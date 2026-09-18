import 'dotenv/config'

/* eslint-disable no-process-env */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  createPageAnalyzer,
  loadAnalyzerConfig
} from './book-processing/analyzer-config'
import {
  type AnalysisPhaseSummary,
  runAnalysisPhase
} from './book-processing/page-analysis'
import {
  capturePdfBook,
  type PdfCaptureDependencies,
  type PdfCaptureOptions,
  validatePdfBookName
} from './pdf-processing/pdf-capture'

interface PdfCommandOptions {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  log?: { info: (message: string) => void; warn: (message: string) => void }
}

function booleanOption(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key]
  if (value === undefined || value.trim() === '') return false
  if (/^(1|true)$/i.test(value.trim())) return true
  if (/^(0|false)$/i.test(value.trim())) return false
  throw new Error(`${key} must be 1/0 or true/false.`)
}

export function parsePdfOptions({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd()
}: PdfCommandOptions = {}): PdfCaptureOptions & { captureOnly: boolean } {
  if (argv.length > 1) throw new Error('Pass one PDF path at a time.')
  const source = argv[0] || env.PDF_FILE
  if (!source?.trim())
    throw new Error(
      'Pass a PDF path: npx tsx src/capture-pdf-text.ts "/path/to/book.pdf", or set PDF_FILE.'
    )
  const dpiText = env.PDF_DPI ?? '150'
  const dpi = Number(dpiText)
  if (!/^\d+$/.test(dpiText) || !Number.isInteger(dpi) || dpi < 72 || dpi > 600)
    throw new Error('PDF_DPI must be an integer between 72 and 600.')
  if (env.PDF_BOOK !== undefined) validatePdfBookName(env.PDF_BOOK)
  const captureOnly = booleanOption(env, 'CAPTURE_ONLY')
  const analyzeOnly = booleanOption(env, 'ANALYZE_ONLY')
  if (captureOnly && analyzeOnly)
    throw new Error('CAPTURE_ONLY and ANALYZE_ONLY cannot be used together.')
  return {
    sourcePath: path.resolve(cwd, source),
    outRoot: path.resolve(cwd, 'out'),
    bookName: env.PDF_BOOK,
    dpi,
    captureOnly,
    analyzeOnly
  }
}

export async function processPdfBook(
  options: PdfCommandOptions = {},
  dependencies?: PdfCaptureDependencies
) {
  const env = options.env ?? process.env
  const log = options.log ?? console
  const parsed = parsePdfOptions(options)
  const config = parsed.captureOnly ? undefined : loadAnalyzerConfig(env)
  const analyzer = config ? createPageAnalyzer(config, env) : undefined
  if (analyzer) await analyzer.preflight()
  let summary: AnalysisPhaseSummary | undefined
  const captured = await capturePdfBook(
    { ...parsed, log },
    dependencies,
    async ({ bookDir, pageCount }) => {
      log.info(`[pdf] Captured ${pageCount} pages in ${bookDir}`)
      if (!analyzer || !config) return
      summary = await runAnalysisPhase({
        captureDir: path.join(bookDir, 'text-capture'),
        bookTextPath: path.join(bookDir, 'book-text.md'),
        analyzer,
        reprocess: config.reprocess,
        pages: config.pages,
        log
      })
      if (summary.failed > 0)
        throw new Error(
          `PDF analysis failed for ${summary.failed} page(s). Successful pages were saved; run the same command again to retry.`
        )
      if (summary.skipped > 0)
        log.warn(
          `[pdf] ${summary.skipped} page(s) have no analysis because of PAGES selection. Their images remain in the output.`
        )
      log.info(`[pdf] Book text: ${summary.outputPath}`)
    }
  )
  return { ...captured, summary }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (
    process.argv
      .slice(2)
      .some((argument) => argument === '--help' || argument === '-h')
  ) {
    console.log(
      'Usage: npx tsx src/capture-pdf-text.ts "/path/to/book.pdf"\n\nPDF_FILE: alternative input path\nPDF_BOOK: optional output folder name under out/\nPDF_DPI: render resolution, 72–600 (default 150)\nCAPTURE_ONLY=1: render without AI analysis\nANALYZE_ONLY=1: analyze an existing validated capture\nANALYZER=codex|claude: existing analyzer settings apply (default codex)\nREPROCESS=1: replace existing analysis\nPAGES: optional physical page selection, e.g. 1,3-5\n\nRequires Poppler: brew install poppler (macOS) or apt-get install poppler-utils (Linux).'
    )
  } else {
    try {
      await processPdfBook()
    } catch (err) {
      console.error(`[pdf] ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
  }
}
