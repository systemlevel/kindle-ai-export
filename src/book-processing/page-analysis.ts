import { promises as fs } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import sharp from 'sharp'

/**
 * Phase 2 of the screenshot pipeline: analyze captured page PNGs
 * (`out/<ASIN>/text-capture/page-####.png`) with a multimodal CLI backend,
 * persist each page's `{ text, visuals }` result next to its image, crop every
 * visual into `text-capture/assets/`, and assemble `out/<ASIN>/book-text.md`.
 *
 * The phase is backend-agnostic: a {@link PageAnalyzer} wraps one CLI (Codex or
 * Claude Code) and the phase owns resumability, reprocessing, page selection,
 * result persistence, crops, and markdown assembly.
 */

export type AnalyzerBackend = 'codex' | 'claude'

export const analyzerBackends: readonly AnalyzerBackend[] = ['codex', 'claude']

export interface PageAnalyzerIdentity {
  backend: AnalyzerBackend
  /** Requested model, or `null` when the CLI's default model is used. */
  model: string | null
  /** Requested reasoning effort, or `null` when the CLI default is used. */
  effort: string | null
}

/** Stamped into every page JSON the phase writes, so it is always possible to
 * tell which backend/model/effort produced a given page result. */
export interface PageAnalyzerStamp extends PageAnalyzerIdentity {
  analyzedAt: string
}

export interface PageAnalyzer {
  backend: AnalyzerBackend
  identity: PageAnalyzerIdentity
  /** One-line description for logs (binary, model, effort, timeout). */
  describe(): string
  /** Verifies the CLI is installed and authenticated; throws otherwise. */
  preflight(): Promise<void>
  /** Analyzes one absolute page PNG path. Throws on failure — a
   * {@link PageAnalysisError} with `retryable: false` when another attempt
   * cannot help (rejected model, auth failure); anything else is retried. */
  analyzePage(pngPath: string): Promise<PageResult>
}

/**
 * Failure of one page analysis. `retryable` tells the phase whether another
 * attempt could plausibly succeed: transient service errors, timeouts and
 * flaky output are retried with backoff, while a rejected `--model` or an
 * authentication failure fails the page immediately instead of burning
 * minutes of futile retries on every page of a book.
 */
export class PageAnalysisError extends Error {
  readonly retryable: boolean

  constructor(
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {}
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause }
    )
    this.name = 'PageAnalysisError'
    this.retryable = options.retryable ?? true
  }
}

// Structured OCR + visual-analysis prompt. The backend returns JSON (validated
// by the output schema below) so we can preserve BOTH the readable text AND
// every figure/chart/graph/diagram/formula/table/image on the page — each as a
// cropped image plus the model's interpretation of what it shows.
export const pageAnalysisPrompt =
  'You are analyzing a single scanned page image from a book. Return a JSON ' +
  'object that exactly matches the provided output schema, with two fields:\n' +
  '- "text": every word of readable text on the page, transcribed verbatim in ' +
  'natural reading order, formatted as GitHub-flavored Markdown that PRESERVES ' +
  "the page's visual text hierarchy. Specifically:\n" +
  '    * Text rendered visibly LARGER or BOLDER than the surrounding body text ' +
  'becomes a Markdown heading, with the heading LEVEL scaled to its relative ' +
  'prominence: the single most prominent title on the page -> "# ", a major ' +
  'section header -> "## ", a smaller sub-header -> "### ", and so on for less ' +
  'prominent headers.\n' +
  '    * Inline runs that are bold or emphasized within body text -> ' +
  '"**bold**" / "*italic*".\n' +
  '    * Normal body prose stays as plain paragraphs, in reading order, with ' +
  'paragraph breaks preserved.\n' +
  '    * Base heading levels ONLY on the relative size/weight actually visible ' +
  'in the page image; do NOT invent hierarchy that is not there. Keep the ' +
  'transcription verbatim (the same words) — only add the Markdown structure. ' +
  'No commentary of your own.\n' +
  '- "visuals": an array with one entry for EVERY figure, chart, graph, ' +
  'diagram, mathematical formula or equation, table, or image on the page. Do ' +
  'not miss any visual element. For each entry provide:\n' +
  '  - "kind": one of figure, chart, graph, diagram, formula, table, image, ' +
  'other.\n' +
  '  - "description": a DETAILED interpretation of exactly what the visual ' +
  'shows. For a chart or graph, describe the axes, the series, the overall ' +
  'trend, and any notable values or payoff. For a formula, give the equation ' +
  'and explain what it computes. For a table, summarize its structure and key ' +
  'values. For a figure, diagram, or image, describe its content and what it ' +
  'conveys.\n' +
  '  - "region": a bounding box tightly around the visual, as {x, y, width, ' +
  'height} with each value normalized to a 0..1000 scale relative to the page ' +
  'image (x, y = the top-left corner). If you cannot confidently localize the ' +
  'visual, set region to null.\n' +
  'If the page has no visuals, return an empty "visuals" array. Output ONLY the ' +
  'JSON object.'

// Lenient JSON Schema handed to the CLI for structured output. It is strict
// enough to be accepted by structured-output validation (every object closed
// with additionalProperties:false and all properties required, nullable via a
// type array) but imposes NO ordering/contiguity/min-size/cross-field
// constraints so a page never fails validation.
export const pageAnalysisOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'visuals'],
  properties: {
    text: { type: 'string' },
    visuals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'description', 'region'],
        properties: {
          kind: {
            type: 'string',
            enum: [
              'figure',
              'chart',
              'graph',
              'diagram',
              'formula',
              'table',
              'image',
              'other'
            ]
          },
          description: { type: 'string' },
          region: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: ['x', 'y', 'width', 'height'],
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' }
            }
          }
        }
      }
    }
  }
} as const

export const visualKinds = [
  'figure',
  'chart',
  'graph',
  'diagram',
  'formula',
  'table',
  'image',
  'other'
] as const
export type VisualKind = (typeof visualKinds)[number]

export interface VisualRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface PageVisual {
  kind: VisualKind
  description: string
  /** Normalized (0..1000) bounding box, or null when the model could not localize it. */
  region: VisualRegion | null
}

export interface PageResult {
  text: string
  visuals: PageVisual[]
}

/** A persisted page result; `analyzer` is absent on files written before the
 * stamp was introduced. */
export interface AnalyzedPage extends PageResult {
  analyzer?: PageAnalyzerStamp
}

export interface AnalysisLogger {
  info(message: string): void
  warn(message: string): void
}

export interface AnalysisPhaseOptions {
  /** `out/<ASIN>/text-capture` — holds `page-####.png` and `page-####.json`. */
  captureDir: string
  /** `out/<ASIN>/book-text.md`; its directory is the root for relative links. */
  bookTextPath: string
  analyzer: PageAnalyzer
  /** Re-analyze pages that already have a cached result (default: resume). */
  reprocess?: boolean
  /** When set, only these page numbers may be sent to the analyzer. */
  pages?: ReadonlySet<number>
  /** Attempts per page before it is flagged as failed. Default 3. */
  retryAttempts?: number
  /** Backoff between attempts is `retryBaseDelayMs * attempt`. Default 3 s. */
  retryBaseDelayMs?: number
  log?: AnalysisLogger
}

export interface AnalysisPhaseSummary {
  pageCount: number
  analyzed: number
  reused: number
  failed: number
  skipped: number
  failedPages: number[]
  skippedPages: number[]
  outputPath: string
}

const pagePngPattern = /^page-(\d+)\.png$/

// Region coordinates are normalized to a 0..1000 scale on both axes (matching
// the convention used elsewhere in the repo, e.g. book-processing/media-assets).
const normalizedSpan = 1000
// A crop smaller than this (in real page pixels) on either side is treated as
// unusable, so we fall back to preserving the full page image instead.
const minCropPx = 24
// Upper bound on a single PAGES range so a typo cannot allocate millions of
// entries.
const maxSelectionSpan = 100_000
// Analyzers can fail transiently (models-cache TTL errors, rate limits,
// network blips). Retry a page this many times, backing off by this base delay
// per attempt, before flagging it as a failed page in the output.
const defaultRetryAttempts = 3
const defaultRetryBaseDelayMs = 3000

export const defaultAnalysisLogger: AnalysisLogger = {
  info: (message) => console.log(`[analyze] ${message}`),
  warn: (message) => console.warn(`[analyze] ${message}`)
}

/**
 * Parses a `PAGES` selection such as `"1-20, 45"` into the set of page numbers
 * that may be sent to the analyzer. Throws a `PAGES`-prefixed error for
 * anything malformed so the operator sees which variable to fix.
 */
export function parsePageSelection(raw: string): Set<number> {
  const selection = new Set<number>()
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('PAGES must list page numbers or ranges, e.g. "1-20,45"')
  }
  for (const part of trimmed.split(',')) {
    const token = part.trim()
    // Anchored and linear on a short, comma-split token; not backtracking-prone.
    // eslint-disable-next-line security/detect-unsafe-regex
    const match = /^(\d+)(?:-(\d+))?$/.exec(token)
    if (!match) {
      throw new Error(
        `PAGES contains an invalid entry "${token}"; use page numbers or ` +
          'ranges like "1-20,45"'
      )
    }
    const start = Number(match[1])
    const end = match[2] === undefined ? start : Number(match[2])
    if (start < 1 || end < start) {
      throw new Error(
        `PAGES contains an invalid range "${token}"; pages start at 1 and ` +
          'ranges must ascend'
      )
    }
    if (end - start > maxSelectionSpan) {
      throw new Error(`PAGES range "${token}" is too large`)
    }
    for (let page = start; page <= end; page++) selection.add(page)
  }
  return selection
}

/** Collapses `[1,2,3,7]` into `"1-3,7"` for logs and rerun hints. */
export function formatPageList(pages: Iterable<number>): string {
  const sorted = [...new Set(pages)].toSorted((a, b) => a - b)
  const runs: string[] = []
  let runStart: number | undefined
  let previous: number | undefined
  const flush = () => {
    if (runStart === undefined || previous === undefined) return
    runs.push(runStart === previous ? `${runStart}` : `${runStart}-${previous}`)
  }
  for (const page of sorted) {
    if (previous !== undefined && page === previous + 1) {
      previous = page
      continue
    }
    flush()
    runStart = page
    previous = page
  }
  flush()
  return runs.join(',')
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

async function readCachedResult(
  jsonPath: string,
  file: string,
  log: AnalysisLogger
): Promise<AnalyzedPage | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(jsonPath, 'utf8')
  } catch {
    return undefined
  }
  try {
    return coerceAnalyzedPage(JSON.parse(raw))
  } catch (err) {
    log.warn(
      `${file}: cached JSON unreadable (${(err as Error).message}); ` +
        'it will be re-analyzed'
    )
    return undefined
  }
}

/**
 * Runs the analysis phase over every `page-####.png` in `captureDir`.
 *
 * - Resume (default): pages with a readable cached JSON are reused; the rest
 *   are analyzed.
 * - `reprocess`: every eligible page is re-analyzed even when cached.
 * - `pages`: only these page numbers may reach the analyzer. Other pages reuse
 *   their cache when present and are otherwise skipped (and omitted from the
 *   markdown until analyzed).
 * - A cached JSON is only replaced after a successful analysis; a failed page
 *   keeps (and renders) its previous result.
 *
 * Crops and `book-text.md` are always rebuilt from the per-page JSON so the
 * output is deterministic regardless of which pages were freshly analyzed.
 */
export async function runAnalysisPhase(
  options: AnalysisPhaseOptions
): Promise<AnalysisPhaseSummary> {
  const {
    captureDir,
    bookTextPath,
    analyzer,
    reprocess = false,
    pages,
    retryAttempts = defaultRetryAttempts,
    retryBaseDelayMs = defaultRetryBaseDelayMs,
    log = defaultAnalysisLogger
  } = options

  // book-text.md lives at out/<ASIN>/, the capture dir at out/<ASIN>/text-capture,
  // and the preserved visual assets at out/<ASIN>/text-capture/assets/.
  const outDir = path.dirname(bookTextPath)
  const assetsDir = path.join(captureDir, 'assets')

  let entries: string[]
  try {
    entries = await fs.readdir(captureDir)
  } catch {
    throw new Error(
      `capture directory not found: ${captureDir} (run the capture phase first)`
    )
  }
  const pngFiles = entries.filter((f) => pagePngPattern.test(f)).toSorted()
  if (pngFiles.length === 0) {
    throw new Error(
      `no captured page images (page-####.png) found in ${captureDir}`
    )
  }
  await fs.mkdir(assetsDir, { recursive: true })

  const cachedCount = entries.filter((f) => /^page-\d+\.json$/.test(f)).length
  log.info(
    `found ${pngFiles.length} captured page image(s) and ${cachedCount} ` +
      `cached result(s) in ${captureDir}`
  )
  log.info(`analyzer: ${analyzer.describe()}`)
  log.info(
    `mode: ${
      reprocess
        ? 'reprocess (re-analyze pages that already have results)'
        : 'resume (reuse cached results, analyze missing pages)'
    }` +
      (pages
        ? `; page selection: ${formatPageList(pages)} (${pages.size} page(s))`
        : '; all pages eligible')
  )

  let analyzed = 0
  let reused = 0
  let failed = 0
  let skipped = 0
  const failedPages: number[] = []
  const skippedPages: number[] = []
  // Rebuild the whole markdown from the per-page JSON every run so the output is
  // deterministic and resumable.
  const sections: string[] = []

  for (const file of pngFiles) {
    const pngPath = path.join(captureDir, file)
    const pad = pagePngPattern.exec(file)![1]!
    const pageNumber = Number.parseInt(pad, 10)
    const jsonPath = path.join(captureDir, `page-${pad}.json`)
    const eligible = !pages || pages.has(pageNumber)

    const cached = await readCachedResult(jsonPath, file, log)
    let result: AnalyzedPage | undefined

    if (cached && (!reprocess || !eligible)) {
      result = cached
      reused += 1
      log.info(
        `${file}: reusing cached result ${path.basename(jsonPath)} ` +
          `(${eligible ? 'resume' : 'outside page selection'})`
      )
    } else if (!eligible) {
      // NEVER silently drop a page: flag the gap in place with its image.
      skipped += 1
      skippedPages.push(pageNumber)
      log.warn(
        `${file}: no cached result and outside page selection — not ` +
          'analyzed; flagged as a gap in book-text.md'
      )
      sections.push(
        await renderGapSection({
          pageNumber,
          pad,
          pngPath,
          assetsDir,
          outDir,
          headline: 'not analyzed (outside the PAGES selection)',
          advice:
            'Re-run without PAGES (or with this page included) to analyze it.'
        })
      )
      continue
    } else {
      log.info(
        `${file}: analyzing with ${analyzer.backend}` +
          (cached ? ' (reprocess; replacing cached result)' : '') +
          '...'
      )
      const started = Date.now()
      const outcome = await analyzeWithRetries({
        analyzer,
        pngPath: path.resolve(pngPath),
        file,
        retryAttempts,
        retryBaseDelayMs,
        log
      })
      if (outcome.ok) {
        result = {
          ...outcome.result,
          analyzer: {
            ...analyzer.identity,
            analyzedAt: new Date().toISOString()
          }
        }
        await fs.writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`)
        analyzed += 1
        log.info(
          `${file}: analyzed in ${formatDuration(Date.now() - started)}` +
            (outcome.attempts > 1 ? ` (attempt ${outcome.attempts})` : '')
        )
      } else {
        failed += 1
        failedPages.push(pageNumber)
        log.warn(
          `${file}: FAILED after ${outcome.attempts} attempt(s), ` +
            `${formatDuration(Date.now() - started)} — ${outcome.error.message}` +
            (cached
              ? '; keeping previous cached result'
              : '; flagged as a gap in book-text.md (no result cached, so a ' +
                'rerun retries it)')
        )
        if (!cached) {
          sections.push(
            await renderGapSection({
              pageNumber,
              pad,
              pngPath,
              assetsDir,
              outDir,
              headline: 'automated analysis FAILED',
              advice: 'Re-run the analysis to retry only this page.'
            })
          )
          continue
        }
        result = cached
      }
    }

    // Always (re)generate crops + markdown from the parsed result, whether it
    // came fresh from the analyzer or from the cached JSON.
    const rendered = await renderPageSection({
      pageNumber,
      pad,
      pngPath,
      result,
      assetsDir,
      outDir
    })
    sections.push(rendered.markdown)

    const assetNote = rendered.assetsWritten.length
      ? `, assets: ${rendered.assetsWritten.map((a) => path.basename(a)).join(', ')}`
      : ''
    log.info(
      `${file}: ${rendered.textChars} chars text, ` +
        `${rendered.visualCount} visual(s)${assetNote}`
    )
  }

  const combined = `${sections.join('\n\n---\n\n')}\n`
  await fs.writeFile(bookTextPath, combined)

  log.info(
    `done: ${analyzed} analyzed, ${reused} reused, ${failed} failed, ` +
      `${skipped} skipped`
  )
  if (failedPages.length > 0) {
    log.warn(
      `failed page(s): ${formatPageList(failedPages)} — flagged as gaps in ` +
        `${path.basename(bookTextPath)} with their page images preserved; ` +
        `rerun with PAGES=${formatPageList(failedPages)} to retry just those`
    )
  }
  if (skippedPages.length > 0) {
    log.warn(
      `skipped page(s) without results: ${formatPageList(skippedPages)} — ` +
        `flagged as gaps in ${path.basename(bookTextPath)} until analyzed`
    )
  }
  log.info(
    `wrote ${bookTextPath} — ${sections.length} page(s), ` +
      `${combined.length} characters`
  )

  return {
    pageCount: pngFiles.length,
    analyzed,
    reused,
    failed,
    skipped,
    failedPages,
    skippedPages,
    outputPath: bookTextPath
  }
}

interface RetryInput {
  analyzer: PageAnalyzer
  pngPath: string
  file: string
  retryAttempts: number
  retryBaseDelayMs: number
  log: AnalysisLogger
}

type RetryOutcome =
  | { ok: true; result: PageResult; attempts: number }
  | { ok: false; error: Error; attempts: number }

/** Runs the analyzer with linear backoff. Stops early when the analyzer says
 * another attempt cannot help (`PageAnalysisError.retryable === false`). */
async function analyzeWithRetries(input: RetryInput): Promise<RetryOutcome> {
  const { analyzer, pngPath, file, retryAttempts, retryBaseDelayMs, log } =
    input
  const attempts = Math.max(1, retryAttempts)
  let lastError: Error = new Error('analysis did not run')
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await analyzer.analyzePage(pngPath)
      return { ok: true, result, attempts: attempt }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const retryable =
        !(lastError instanceof PageAnalysisError) || lastError.retryable
      if (!retryable) {
        log.warn(`${file}: attempt ${attempt} failed and is not retryable`)
        return { ok: false, error: lastError, attempts: attempt }
      }
      if (attempt < attempts) {
        const backoffMs = retryBaseDelayMs * attempt
        log.warn(
          `${file}: attempt ${attempt}/${attempts} failed ` +
            `(${lastError.message}); retrying in ${formatDuration(backoffMs)}`
        )
        await sleep(backoffMs)
      }
    }
  }
  return { ok: false, error: lastError, attempts }
}

interface GapSectionInput {
  pageNumber: number
  pad: string
  pngPath: string
  assetsDir: string
  outDir: string
  /** e.g. "automated analysis FAILED" */
  headline: string
  advice: string
}

/**
 * Markdown for a page that has no analysis result (failed, or excluded by the
 * page selection). We never drop the page: the original captured image is
 * preserved as an asset and embedded, so the content is still there for a
 * human (or a later pass) to read, and the gap is clearly flagged rather than
 * silently missing.
 */
async function renderGapSection(input: GapSectionInput): Promise<string> {
  const { pageNumber, pad, pngPath, assetsDir, outDir, headline, advice } =
    input
  const fullAssetAbs = path.join(assetsDir, `page-${pad}-full.png`)
  let rel: string | undefined
  try {
    await fs.copyFile(pngPath, fullAssetAbs)
    rel = path.relative(outDir, fullAssetAbs).split(path.sep).join('/')
  } catch (err) {
    console.warn(
      `[analyze] page ${pageNumber}: could not preserve full page image — ` +
        `${(err as Error).message}`
    )
  }

  const lines = [
    `> **⚠️ Page ${pageNumber}: ${headline} — text not transcribed.**`,
    '>',
    '> The captured page image is preserved below so no content is lost. ' +
      advice
  ]
  if (rel) {
    lines.push('', `![Page ${pageNumber} (not transcribed)](${rel})`)
  }
  return lines.join('\n')
}

interface RenderPageInput {
  pageNumber: number
  /** Zero-padded page index string, matching the page-####.png filename. */
  pad: string
  pngPath: string
  result: PageResult
  assetsDir: string
  outDir: string
}

interface RenderedPage {
  markdown: string
  visualCount: number
  textChars: number
  assetsWritten: string[]
}

/**
 * Turn one page's parsed result into its markdown section, preserving every
 * visual as a real image on disk. For each visual we crop its region out of
 * the page PNG; if the region is missing, too small, out of bounds, or the crop
 * fails to decode, we fall back to the full page image so a visual is NEVER
 * lost. Pages with >=1 visual also always get a full-page safety-net copy.
 */
export async function renderPageSection(
  input: RenderPageInput
): Promise<RenderedPage> {
  const { pageNumber, pad, pngPath, result, assetsDir, outDir } = input
  const assetsWritten: string[] = []

  // Real pixel dimensions of the page PNG (needed to convert normalized regions).
  const meta = await sharp(pngPath)
    .metadata()
    .catch(() => undefined)
  const pageWidth = meta?.width
  const pageHeight = meta?.height

  const fullAssetAbs = path.join(assetsDir, `page-${pad}-full.png`)
  let fullCopied = false
  async function ensureFullCopy(): Promise<void> {
    if (fullCopied) return
    await fs.copyFile(pngPath, fullAssetAbs)
    fullCopied = true
    assetsWritten.push(fullAssetAbs)
  }

  const relFromOut = (abs: string): string =>
    path.relative(outDir, abs).split(path.sep).join('/')

  const visualBlocks: string[] = []
  for (let i = 0; i < result.visuals.length; i++) {
    const visual = result.visuals[i]!
    const figId = i + 1

    let assetAbs = fullAssetAbs
    let cropped = false
    if (visual.region && pageWidth && pageHeight) {
      const cropAbs = path.join(assetsDir, `page-${pad}-fig-${figId}.png`)
      const ok = await cropVisual(
        pngPath,
        visual.region,
        pageWidth,
        pageHeight,
        cropAbs
      )
      if (ok) {
        assetAbs = cropAbs
        assetsWritten.push(cropAbs)
        cropped = true
      }
    }
    if (!cropped) {
      // region null / crop out of bounds / too small / sharp failure -> full page.
      await ensureFullCopy()
    }

    const relPath = relFromOut(assetAbs)
    const kindLabel = capitalize(visual.kind)
    const altText = visual.description
      .replaceAll(/\s+/g, ' ')
      .replaceAll(/[[\]]/g, '')
      .trim()
      .slice(0, 80)
    // Keep multi-line descriptions inside the blockquote by prefixing wrapped
    // lines with "> " so the full analysis is preserved verbatim.
    const quoted = (
      visual.description.trim() || '(no description provided)'
    ).replaceAll(/\r?\n/g, '\n> ')
    visualBlocks.push(
      `![${visual.kind} — ${altText}](${relPath})\n` +
        `> **${kindLabel} (page ${pageNumber}):** ${quoted}`
    )
  }

  const parts: string[] = []
  const trimmedText = result.text.trim()
  if (trimmedText) parts.push(trimmedText)
  parts.push(...visualBlocks)

  if (result.visuals.length > 0) {
    // Safety net: always link the untouched full page for any page with visuals.
    await ensureFullCopy()
    parts.push(
      `> _Full page image:_ [page ${pageNumber}](${relFromOut(fullAssetAbs)})`
    )
  }

  return {
    markdown: parts.join('\n\n'),
    visualCount: result.visuals.length,
    textChars: trimmedText.length,
    assetsWritten
  }
}

/**
 * Crop a normalized (0..1000) region out of the page PNG to `destAbs` and verify
 * the result decodes as PNG. Returns false (never throws) when the region maps
 * to a rectangle smaller than `minCropPx` on a side or Sharp fails, so the
 * caller can fall back to preserving the full page image.
 */
export async function cropVisual(
  pngPath: string,
  region: VisualRegion,
  pageWidth: number,
  pageHeight: number,
  destAbs: string
): Promise<boolean> {
  const left = Math.floor((region.x / normalizedSpan) * pageWidth)
  const top = Math.floor((region.y / normalizedSpan) * pageHeight)
  const right = Math.ceil(
    ((region.x + region.width) / normalizedSpan) * pageWidth
  )
  const bottom = Math.ceil(
    ((region.y + region.height) / normalizedSpan) * pageHeight
  )

  const clampedLeft = Math.min(Math.max(left, 0), pageWidth)
  const clampedTop = Math.min(Math.max(top, 0), pageHeight)
  const clampedRight = Math.min(Math.max(right, clampedLeft), pageWidth)
  const clampedBottom = Math.min(Math.max(bottom, clampedTop), pageHeight)

  const width = clampedRight - clampedLeft
  const height = clampedBottom - clampedTop
  if (width < minCropPx || height < minCropPx) return false

  try {
    await sharp(pngPath)
      .extract({ left: clampedLeft, top: clampedTop, width, height })
      .png()
      .toFile(destAbs)
    const cropMeta = await sharp(destAbs).metadata()
    return cropMeta.format === 'png' && !!cropMeta.width && !!cropMeta.height
  } catch (err) {
    console.error(
      `[analyze] crop failed for ${path.basename(destAbs)}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return false
  }
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

function coerceKind(value: unknown): VisualKind {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (visualKinds as readonly string[]).includes(s)
    ? (s as VisualKind)
    : 'other'
}

function coerceRegion(value: unknown): VisualRegion | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const x = Number(o.x)
  const y = Number(o.y)
  const width = Number(o.width)
  const height = Number(o.height)
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null
  return { x, y, width, height }
}

function coerceVisual(value: unknown): PageVisual {
  const o =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    kind: coerceKind(o.kind),
    description: typeof o.description === 'string' ? o.description : '',
    region: coerceRegion(o.region)
  }
}

/**
 * Leniently coerce an already-parsed object into a PageResult. Missing/invalid
 * fields degrade gracefully (empty text, empty visuals, null regions) so a page
 * never hard-fails.
 */
export function coercePageResult(value: unknown): PageResult {
  const o =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    text: typeof o.text === 'string' ? o.text : '',
    visuals: Array.isArray(o.visuals) ? o.visuals.map(coerceVisual) : []
  }
}

function coerceStamp(value: unknown): PageAnalyzerStamp | undefined {
  if (!value || typeof value !== 'object') return undefined
  const o = value as Record<string, unknown>
  const backend = o.backend
  if (backend !== 'codex' && backend !== 'claude') return undefined
  return {
    backend,
    model: typeof o.model === 'string' ? o.model : null,
    effort: typeof o.effort === 'string' ? o.effort : null,
    analyzedAt: typeof o.analyzedAt === 'string' ? o.analyzedAt : ''
  }
}

/** Coerces a persisted page JSON, preserving a valid `analyzer` stamp. */
export function coerceAnalyzedPage(value: unknown): AnalyzedPage {
  const result: AnalyzedPage = coercePageResult(value)
  const stamp =
    value && typeof value === 'object'
      ? coerceStamp((value as Record<string, unknown>).analyzer)
      : undefined
  if (stamp) result.analyzer = stamp
  return result
}

/**
 * Parse a raw model message into a PageResult. If JSON parsing fails entirely,
 * fall back to treating the whole message as plain text with no visuals so a
 * page never hard-fails.
 */
export function parsePageResult(raw: string): PageResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Some models wrap the JSON in a ```json fenced block; try to recover it.
    const fenced = /```(?:json)?\s*([\S\s]*?)```/i.exec(raw)
    if (fenced?.[1]) {
      try {
        parsed = JSON.parse(fenced[1])
      } catch {}
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { text: raw, visuals: [] }
  }
  return coercePageResult(parsed)
}
