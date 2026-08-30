import 'dotenv/config'

import type { Readable } from 'node:stream'
import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { input } from '@inquirer/prompts'
import delay from 'delay'
import { chromium } from 'patchright'
import sharp from 'sharp'

import { parsePageNav } from './playwright-utils'
import { assert, fileExists, getEnv } from './utils'

/**
 * Standalone "screenshot the Kindle web reader + Codex-OCR the pages" pipeline.
 *
 * This deliberately bypasses the broken metadata-endpoint scraping in
 * `extract-kindle-book.ts` (Amazon removed the `startReading`/`YJmetadata`
 * endpoints and the render-TAR body text is glyph-obfuscated). The only path to
 * readable text is OCR of the rendered page pixels, so we:
 *
 *   1. Reuse the SAME warm persistent browser profile the extractor already
 *      logged in with (`out/<ASIN>/data`), open the reader, and page through it.
 *   2. Screenshot the rendered reader image for each page to
 *      `out/<ASIN>/text-capture/page-####.png` (resumable, with end-of-book
 *      detection via consecutive-identical-screenshot hashing).
 *   3. Optionally (OCR=1) analyze each page PNG with the local `codex` CLI —
 *      transcribing the text AND detecting every figure/chart/graph/diagram/
 *      formula/table/image — then assemble `out/<ASIN>/book-text.md`. Each
 *      visual is preserved as a cropped image under `text-capture/assets/`
 *      (falling back to the full page image) alongside Codex's interpretation of
 *      what it shows, so nothing visual is lost.
 *
 * Run with:  npx tsx src/capture-book-text.ts
 *   ASIN=<asin> MAX_PAGES=5            -> capture only (5 pages, smoke test)
 *   ASIN=<asin> MAX_PAGES=100000 OCR=1 -> capture + OCR the whole book
 */

// The rendered current-page image inside the Kindle reader. Screenshotting this
// element captures the readable page PIXELS (not the obfuscated body text).
const krRendererMainImageSelector = '#kr-renderer .kg-full-page-img img'
const readerContainerSelector = '#kr-renderer'

// Stop once this many consecutive screenshots are byte-identical (end of book).
const identicalStopThreshold = 3

// Structured OCR + visual-analysis prompt. Codex returns JSON (validated by the
// output schema below) so we can preserve BOTH the readable text AND every
// figure/chart/graph/diagram/formula/table/image on the page — each as a
// cropped image plus Codex's interpretation of what it shows.
const ocrPrompt =
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

// Lenient JSON Schema handed to codex via --output-schema. It is strict enough
// to be accepted by structured-output validation (every object closed with
// additionalProperties:false and all properties required, nullable via a type
// array) but imposes NO ordering/contiguity/min-size/cross-field constraints so
// a page never fails validation.
const ocrOutputSchema = {
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

const visualKinds = [
  'figure',
  'chart',
  'graph',
  'diagram',
  'formula',
  'table',
  'image',
  'other'
] as const
type VisualKind = (typeof visualKinds)[number]

interface VisualRegion {
  x: number
  y: number
  width: number
  height: number
}

interface PageVisual {
  kind: VisualKind
  description: string
  /** Normalized (0..1000) bounding box, or null when Codex could not localize it. */
  region: VisualRegion | null
}

interface PageResult {
  text: string
  visuals: PageVisual[]
}

// Region coordinates are normalized to a 0..1000 scale on both axes (matching
// the convention used elsewhere in the repo, e.g. book-processing/media-assets).
const normalizedSpan = 1000
// A crop smaller than this (in real page pixels) on either side is treated as
// unusable, so we fall back to preserving the full page image instead.
const minCropPx = 24

type SpawnedCodex = ChildProcessByStdio<null, Readable, Readable>

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function pad4(n: number): string {
  return `${n}`.padStart(4, '0')
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = getEnv(name)
  if (!raw || !raw.trim()) return fallback
  const value = Number.parseInt(raw.trim(), 10)
  assert(
    Number.isInteger(value) && value > 0,
    `${name} must be a positive integer, received "${raw}"`
  )
  return value
}

async function main(): Promise<void> {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required (set it in .env)')

  const amazonEmail = getEnv('AMAZON_EMAIL')
  const amazonPassword = getEnv('AMAZON_PASSWORD')

  const maxPages = parsePositiveIntEnv('MAX_PAGES', 5)
  const ocrEnabled = getEnv('OCR') === '1' || getEnv('OCR') === 'true'
  const codexBin = getEnv('CODEX_BIN') || 'codex'
  const codexModel = getEnv('CODEX_MODEL') || undefined
  // Codex reasoning effort. `--ignore-user-config` bypasses ~/.codex/config.toml,
  // so we set this explicitly via `-c model_reasoning_effort=`. Defaults to xhigh
  // so figure/formula/chart interpretation gets full reasoning; override with
  // CODEX_REASONING_EFFORT (e.g. minimal | low | medium | high | xhigh).
  const codexReasoningEffort =
    getEnv('CODEX_REASONING_EFFORT')?.trim() || 'xhigh'
  const codexTimeoutMs = parsePositiveIntEnv('CODEX_TIMEOUT_MS', 300_000)

  const outDir = path.join('out', asin)
  const userDataDir = path.join(outDir, 'data')
  const captureDir = path.join(outDir, 'text-capture')
  const captureStatePath = path.join(captureDir, 'capture-state.json')
  const bookTextPath = path.join(outDir, 'book-text.md')
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.mkdir(captureDir, { recursive: true })

  const bookReaderUrl = `https://read.amazon.com/?asin=${asin}`

  console.log(
    `[capture] ASIN=${asin} maxPages=${maxPages} ocr=${ocrEnabled} profile=${userDataDir}`
  )

  // --- Launch the reader with the SAME proven persistent-profile setup the
  // extractor uses, so the warm login is reused (no re-auth expected). ---
  const deviceScaleFactor = 2
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    args: [
      '--hide-crash-restore-bubble',
      '--disable-features=PasswordAutosave',
      '--disable-features=WebAuthn',
      '--disable-features=MacAppCodeSignClone'
    ],
    ignoreDefaultArgs: [
      '--enable-automation',
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
    bypassCSP: true,
    deviceScaleFactor,
    viewport: { width: 1280, height: 720 }
  })

  const page = context.pages()[0] ?? (await context.newPage())

  let capturedCount = 0

  async function writeCaptureState(): Promise<void> {
    await fs.writeFile(
      captureStatePath,
      JSON.stringify(
        {
          asin,
          capturedPages: capturedCount,
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )
    )
  }

  async function getMainImageSrc(): Promise<string | undefined> {
    try {
      const src = await page
        .locator(krRendererMainImageSelector)
        .first()
        .getAttribute('src')
      return src ?? undefined
    } catch {
      return undefined
    }
  }

  async function getNavSuffix(): Promise<string> {
    try {
      const footerText = await page
        .locator('ion-footer ion-title')
        .first()
        .textContent()
      const nav = parsePageNav(footerText)
      if (nav?.page !== undefined) {
        return ` [reader page ${nav.page}/${nav.total}]`
      }
      if (nav?.location !== undefined) {
        return ` [location ${nav.location}/${nav.total}]`
      }
    } catch {}
    return ''
  }

  async function captureReaderScreenshot(): Promise<Buffer> {
    // Prefer the rendered page image element (cleanest crop for OCR), then the
    // reader container, then the full viewport as a last resort.
    for (const selector of [
      krRendererMainImageSelector,
      readerContainerSelector
    ]) {
      try {
        const locator = page.locator(selector).first()
        if ((await locator.count()) > 0) {
          return await locator.screenshot({ type: 'png', scale: 'css' })
        }
      } catch {}
    }
    return page.screenshot({ type: 'png', fullPage: false })
  }

  async function waitForPageChange(
    prevSrc: string | undefined,
    timeoutMs: number
  ): Promise<boolean> {
    await delay(300)
    // If we couldn't read a src to compare against, just settle on a fixed delay.
    if (prevSrc === undefined) {
      await delay(900)
      return true
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const src = await getMainImageSrc()
      if (src && src !== prevSrc) {
        await delay(250) // let the new render settle
        return true
      }
      await delay(100)
    }
    return false
  }

  // Dismiss any open Kindle reader overlay (settings/menu ion-popover or modal)
  // that would otherwise intercept page-turn clicks/keys. The reader leaves these
  // open when a menu-item selector we tried isn't found.
  async function dismissOverlays(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      const open = await page
        .locator('ion-popover[is-open="true"], ion-modal[is-open="true"]')
        .count()
        .catch(() => 0)
      if (!open) return
      try {
        await page.keyboard.press('Escape')
      } catch {}
      await delay(250)
    }
  }

  // Advance one page. Prefer the ArrowRight key; fall back to the reader's
  // next-page chevron. Returns whether the rendered page appears to have changed.
  async function advancePage(prevSrc: string | undefined): Promise<boolean> {
    // Ensure nothing (a lingering settings/menu popover) intercepts the advance.
    await dismissOverlays()
    try {
      await page.keyboard.press('ArrowRight')
    } catch {}
    if (await waitForPageChange(prevSrc, 4000)) return true

    try {
      await page
        .locator('.kr-chevron-container-right')
        .first()
        .click({ timeout: 4000 })
    } catch (err) {
      console.warn(
        '[capture] next-page chevron click failed:',
        (err as Error).message
      )
    }
    return waitForPageChange(prevSrc, 6000)
  }

  async function setSingleColumnLayout(): Promise<void> {
    try {
      const settingsButton = page
        .locator(
          'ion-button[aria-label="Reader settings"], ' +
            'button[aria-label="Reader settings"]'
        )
        .first()
      await settingsButton.waitFor({ timeout: 15_000 })
      await settingsButton.click()
      await delay(500)
      await page
        .locator('[role="radiogroup"][aria-label$=" columns"]', {
          hasText: 'Single Column'
        })
        .click({ timeout: 5000 })
      await delay(200)
      console.log('[capture] set single-column layout')
    } catch (err) {
      console.warn(
        '[capture] could not set single-column layout (continuing):',
        (err as Error).message
      )
    } finally {
      // Always close the settings popover so it can't intercept page turns.
      await dismissOverlays()
    }
  }

  // Best-effort: jump to the beginning of the book via the reader's
  // "Go to Page" modal (reusing the extractor's selectors). If this fails we
  // simply capture from the CURRENT reader position instead of hard-failing.
  async function goToStart(): Promise<boolean> {
    try {
      await page.locator('#reader-header').hover({ force: true })
      await delay(200)
      await page
        .locator('ion-button[aria-label="Reader menu"]')
        .click({ timeout: 5000 })
      await delay(500)
      await page
        .locator('ion-item[role="listitem"]', { hasText: 'Go to Page' })
        .click({ timeout: 5000 })
      await page.locator('ion-modal input[placeholder="page number"]').fill('1')
      await page
        .locator('ion-modal ion-button[item-i-d="go-to-modal-go-button"]')
        .click({ timeout: 5000 })
      await delay(800)

      const alertNo = page.locator('ion-alert button', { hasText: 'No' })
      if (await alertNo.isVisible().catch(() => false)) {
        await alertNo.click().catch(() => {})
      }
      console.log('[capture] navigated to start (page 1 via "Go to Page")')
      return true
    } catch (err) {
      console.warn(
        '[capture] could not go to start; capturing from CURRENT reader ' +
          'position (verify the first captured page):',
        (err as Error).message
      )
      return false
    } finally {
      // Whether or not "Go to Page" worked, close the menu/modal we opened so
      // a lingering ion-popover can't intercept subsequent page turns.
      await dismissOverlays()
    }
  }

  try {
    // Go directly to the reader if authenticated; otherwise wait for sign-in.
    await Promise.any([
      page.goto(bookReaderUrl, { timeout: 30_000 }),
      page.waitForURL('**/ap/signin', { timeout: 30_000 })
    ])

    if (/\/ap\/signin/.test(new URL(page.url()).pathname)) {
      console.warn('[capture] not authenticated — sign-in page detected')
      if (amazonEmail && amazonPassword) {
        console.log('[capture] attempting automated Amazon login...')
        await page.locator('input[type="email"]').fill(amazonEmail)
        await page.locator('input#continue').click()
        await page.locator('input[type="password"]').fill(amazonPassword)
        await page.locator('input#signInSubmit').click()

        if (!/\/kindle-library/.test(new URL(page.url()).pathname)) {
          const code = await input({
            message: '2-factor auth code? (leave blank if none)'
          })
          if (code) {
            await page.locator('input[type="tel"]').fill(code)
            await page
              .locator(
                'input[type="submit"][aria-labelledby="cvf-submit-otp-button-announce"]'
              )
              .click()
          }
        }
      } else {
        await input({
          message:
            'Please sign in to Amazon in the opened browser window, then ' +
            'press Enter to continue...'
        })
      }

      if (!page.url().includes('read.amazon.com')) {
        await page.goto(bookReaderUrl)
      }
    }

    console.log('[capture] waiting for reader to load...')
    await page
      .waitForSelector(krRendererMainImageSelector, { timeout: 60_000 })
      .catch(() => {
        console.warn(
          '[capture] main reader image did not appear within 60s; ' +
            'continuing anyway...'
        )
      })

    await setSingleColumnLayout()
    await goToStart()
    // Belt-and-suspenders: make sure no menu/settings overlay is left open
    // before we start turning pages.
    await dismissOverlays()

    // --- Capture loop --------------------------------------------------------
    console.log(`[capture] starting capture of up to ${maxPages} pages...`)
    let previousHash: string | undefined
    let consecutiveIdentical = 0

    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const pngPath = path.join(captureDir, `page-${pad4(pageIndex)}.png`)
      const prevSrc = await getMainImageSrc()

      let buffer: Buffer
      let fromDisk = false
      if (await fileExists(pngPath)) {
        buffer = await fs.readFile(pngPath)
        fromDisk = true
        console.log(
          `[capture] page ${pageIndex}: already captured, skipping (resume)`
        )
      } else {
        buffer = await captureReaderScreenshot()
      }

      const hash = sha256(buffer)
      if (previousHash !== undefined && hash === previousHash) {
        consecutiveIdentical += 1
      } else {
        consecutiveIdentical = 1
      }
      previousHash = hash

      if (consecutiveIdentical >= identicalStopThreshold) {
        console.log(
          `[capture] ${identicalStopThreshold} identical screenshots in a ` +
            'row — assuming end of book, stopping.'
        )
        break
      }

      if (!fromDisk) {
        await fs.writeFile(pngPath, buffer)
        const navSuffix = await getNavSuffix()
        console.log(
          `[capture] page ${pageIndex}: captured ${buffer.length} bytes -> ` +
            `${pngPath}${navSuffix}`
        )
      }
      capturedCount = pageIndex
      await writeCaptureState()

      if (pageIndex >= maxPages) {
        console.log(
          `[capture] reached MAX_PAGES limit (${maxPages}), stopping.`
        )
        break
      }

      const changed = await advancePage(prevSrc)
      if (!changed) {
        console.log(
          `[capture] page did not change after advancing past page ` +
            `${pageIndex} — assuming end of book, stopping.`
        )
        break
      }
    }

    console.log(
      `[capture] capture complete: ${capturedCount} page(s) in ${captureDir}`
    )
  } finally {
    await context.close().catch(() => {})
    await context
      .browser()
      ?.close()
      .catch(() => {})
  }

  // --- OCR phase (browser closed) -------------------------------------------
  if (!ocrEnabled) {
    console.log(
      '[capture] OCR disabled — set OCR=1 to transcribe the captured pages. ' +
        'Capture-only complete.'
    )
    return
  }

  await runOcrPhase({
    captureDir,
    bookTextPath,
    codexBin,
    codexModel,
    codexReasoningEffort,
    codexTimeoutMs
  })
}

interface OcrPhaseOptions {
  captureDir: string
  bookTextPath: string
  codexBin: string
  codexModel: string | undefined
  codexReasoningEffort: string
  codexTimeoutMs: number
}

async function runOcrPhase(options: OcrPhaseOptions): Promise<void> {
  const {
    captureDir,
    bookTextPath,
    codexBin,
    codexModel,
    codexReasoningEffort,
    codexTimeoutMs
  } = options

  // book-text.md lives at out/<ASIN>/, the capture dir at out/<ASIN>/text-capture,
  // and the preserved visual assets at out/<ASIN>/text-capture/assets/.
  const outDir = path.dirname(bookTextPath)
  const assetsDir = path.join(captureDir, 'assets')
  await fs.mkdir(assetsDir, { recursive: true })

  const pngFiles = (await fs.readdir(captureDir))
    .filter((f) => /^page-\d+\.png$/.test(f))
    .toSorted()
  console.log(`[ocr] found ${pngFiles.length} captured page image(s)`)
  console.log(
    `[ocr] codex model=${codexModel ?? 'default (gpt-5.6-sol)'} ` +
      `reasoning_effort=${codexReasoningEffort}`
  )

  let analyzed = 0
  let reused = 0
  let failed = 0
  // Rebuild the whole markdown from the per-page JSON every run so the output is
  // deterministic and resumable.
  const sections: string[] = []

  for (const file of pngFiles) {
    const pngPath = path.join(captureDir, file)
    const pad = /^page-(\d+)\.png$/.exec(file)![1]!
    const pageNumber = Number.parseInt(pad, 10)
    const jsonPath = path.join(captureDir, `page-${pad}.json`)

    let result: PageResult | undefined
    if (await fileExists(jsonPath)) {
      try {
        result = coercePageResult(
          JSON.parse(await fs.readFile(jsonPath, 'utf8'))
        )
        reused += 1
        console.log(
          `[ocr] ${file}: reusing cached result ${path.basename(jsonPath)} (resume)`
        )
      } catch (err) {
        console.warn(
          `[ocr] ${file}: cached JSON unreadable (${(err as Error).message}); ` +
            're-running codex'
        )
      }
    }

    if (!result) {
      console.log(`[ocr] ${file}: analyzing with codex...`)
      try {
        result = await ocrPageWithCodex(pngPath, {
          codexBin,
          codexModel,
          codexReasoningEffort,
          codexTimeoutMs
        })
        await fs.writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`)
        analyzed += 1
      } catch (err) {
        failed += 1
        console.error(`[ocr] ${file}: FAILED — ${(err as Error).message}`)
        continue
      }
    }

    // Always (re)generate crops + markdown from the parsed result, whether it
    // came fresh from codex or from the cached JSON.
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
    console.log(
      `[ocr] ${file}: ${rendered.textChars} chars text, ` +
        `${rendered.visualCount} visual(s)${assetNote}`
    )
  }

  const combined = `${sections.join('\n\n---\n\n')}\n`
  await fs.writeFile(bookTextPath, combined)

  console.log(
    `[ocr] done: ${analyzed} analyzed, ${reused} reused, ${failed} failed`
  )
  console.log(
    `[ocr] wrote ${bookTextPath} — ${sections.length} page(s), ` +
      `${combined.length} characters`
  )
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
 * Turn one page's parsed Codex result into its markdown section, preserving
 * every visual as a real image on disk. For each visual we crop its region out
 * of the page PNG; if the region is missing, too small, out of bounds, or the
 * crop fails to decode, we fall back to the full page image so a visual is
 * NEVER lost. Pages with >=1 visual also always get a full-page safety-net copy.
 */
async function renderPageSection(
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
async function cropVisual(
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
      `[ocr] crop failed for ${path.basename(destAbs)}: ${
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
function coercePageResult(value: unknown): PageResult {
  const o =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    text: typeof o.text === 'string' ? o.text : '',
    visuals: Array.isArray(o.visuals) ? o.visuals.map(coerceVisual) : []
  }
}

/**
 * Parse the raw --output-last-message string into a PageResult. If JSON parsing
 * fails entirely, fall back to treating the whole message as plain text with no
 * visuals so a page never hard-fails.
 */
function parsePageResult(raw: string): PageResult {
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

interface CodexOcrOptions {
  codexBin: string
  codexModel: string | undefined
  codexReasoningEffort: string
  codexTimeoutMs: number
}

/**
 * Analyze a single page PNG via the local `codex` CLI, using the verified
 * invocation (stdin closed; final structured message written to
 * `--output-last-message`) plus `--output-schema` so codex returns JSON. Returns
 * the parsed `{ text, visuals }` result. Never hard-fails on malformed JSON —
 * the raw message is preserved as plain text with no visuals in that case.
 */
async function ocrPageWithCodex(
  pngPath: string,
  options: CodexOcrOptions
): Promise<PageResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-ocr-'))
  const resultPath = path.join(tmpDir, 'result.json')
  const schemaPath = path.join(tmpDir, 'schema.json')
  const absImage = path.resolve(pngPath)

  try {
    await fs.writeFile(schemaPath, JSON.stringify(ocrOutputSchema, null, 2))
    await spawnCodex(absImage, tmpDir, resultPath, schemaPath, options)

    // Bound the untrusted result file before reading it into memory.
    const stats = await fs.stat(resultPath).catch(() => undefined)
    if (!stats) throw new Error('codex did not write an output file')
    const maxResultBytes = 8 * 1024 * 1024
    if (stats.size > maxResultBytes) {
      throw new Error(`codex output file too large (${stats.size} bytes)`)
    }
    if (stats.size === 0) throw new Error('codex produced an empty output file')

    const raw = (await fs.readFile(resultPath, 'utf8')).trim()
    if (!raw) throw new Error('codex output was blank after trimming')
    return parsePageResult(raw)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

function spawnCodex(
  imagePath: string,
  cwd: string,
  resultPath: string,
  schemaPath: string,
  options: CodexOcrOptions
): Promise<void> {
  const args = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--cd',
    cwd,
    '--image',
    imagePath,
    '--output-schema',
    schemaPath,
    '--output-last-message',
    resultPath,
    '--json'
  ]
  // --ignore-user-config drops the user's config.toml, so set reasoning effort
  // explicitly. Passed as a `-c` override (bare value; codex treats a non-TOML
  // value as a literal string, e.g. model_reasoning_effort=xhigh).
  if (options.codexReasoningEffort) {
    args.push('-c', `model_reasoning_effort=${options.codexReasoningEffort}`)
  }
  if (options.codexModel) args.push('--model', options.codexModel)
  args.push(ocrPrompt)

  return new Promise<void>((resolve, reject) => {
    let child: SpawnedCodex
    try {
      // stdin ignored (closed) per the verified invocation; env is inherited.
      child = spawn(options.codexBin, args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      reject(err as Error)
      return
    }

    let settled = false
    let turnCompleted = false
    let pending = ''
    let stderrSample = ''

    const timeout = setTimeout(() => {
      if (settled) return
      try {
        child.kill('SIGKILL')
      } catch {}
      settle(new Error(`codex timed out after ${options.codexTimeoutMs}ms`))
    }, options.codexTimeoutMs)

    function settle(err?: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (err) reject(err)
      else resolve()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as { type?: string }
          if (event.type === 'turn.completed') turnCompleted = true
        } catch {}
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrSample.length < 4096) {
        stderrSample += chunk
          .toString('utf8')
          .slice(0, 4096 - stderrSample.length)
      }
    })

    child.once('error', (err) => settle(err))
    child.once('close', (code) => {
      if (code === 0) {
        if (!turnCompleted) {
          console.warn(
            '[ocr] codex exited 0 but no turn.completed event was seen; ' +
              'relying on the output file'
          )
        }
        settle()
      } else {
        settle(
          new Error(
            `codex exited with code ${code}` +
              (stderrSample ? `: ${stderrSample.trim()}` : '')
          )
        )
      }
    })
  })
}

try {
  await main()
} catch (err) {
  console.error('[capture] fatal error:', err)
  process.exitCode = 1
}
