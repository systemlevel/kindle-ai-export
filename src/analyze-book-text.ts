/* eslint-disable no-process-env */
import 'dotenv/config'

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  createPageAnalyzer,
  loadAnalyzerConfig
} from './book-processing/analyzer-config'
import {
  type AnalysisLogger,
  type AnalysisPhaseSummary,
  type AnalyzerBackend,
  defaultAnalysisLogger,
  formatPageList,
  runAnalysisPhase
} from './book-processing/page-analysis'

/**
 * Standalone runner for phase 2 of the screenshot pipeline: (re)analyze a book
 * whose page images were already captured by `capture-book-text.ts` under
 * `out/<ASIN>/text-capture/page-####.png`, without opening a browser.
 *
 * Each page is analyzed by the selected CLI backend (Codex or Claude Code),
 * the `{ text, visuals }` result is saved as `page-####.json`, every visual is
 * cropped into `text-capture/assets/`, and `out/<ASIN>/book-text.md` is
 * rebuilt.
 *
 * Run with:  npx tsx src/analyze-book-text.ts
 *   ASIN=<asin>                             -> resume: analyze pages missing a result (codex)
 *   ASIN=<asin> ANALYZER=claude             -> same, using the Claude Code CLI
 *   ASIN=<asin> REPROCESS=1                 -> re-analyze EVERY page, replacing results
 *   ASIN=<asin> REPROCESS=1 PAGES=1-20,45   -> re-analyze only the selected pages
 *
 * See `.env.example` for the CODEX_* / CLAUDE_* overrides.
 */

export interface AnalyzeBookOptions {
  /** Root directory that contains `out/<ASIN>/`. Defaults to `process.cwd()`. */
  cwd?: string
  /** Environment the run reads its configuration from (and the CLI inherits). */
  env: NodeJS.ProcessEnv
  log?: AnalysisLogger
}

export interface AnalyzeBookResult {
  asin: string
  backend: AnalyzerBackend
  summary: AnalysisPhaseSummary
}

export async function analyzeBook(
  options: AnalyzeBookOptions
): Promise<AnalyzeBookResult> {
  const { cwd = process.cwd(), env, log = defaultAnalysisLogger } = options

  const asin = env.ASIN?.trim()
  if (!asin) throw new Error('ASIN is required (set it in .env)')
  const config = loadAnalyzerConfig(env)

  const outDir = path.join(cwd, 'out', asin)
  const captureDir = path.join(outDir, 'text-capture')
  const bookTextPath = path.join(outDir, 'book-text.md')

  const captureStat = await fs.stat(captureDir).catch(() => undefined)
  if (!captureStat?.isDirectory()) {
    throw new Error(
      `no captured pages for ASIN ${asin}: expected ${captureDir} ` +
        '(run "npx tsx src/capture-book-text.ts" first)'
    )
  }

  log.info(
    `ASIN=${asin} backend=${config.backend} reprocess=${config.reprocess} ` +
      `pages=${config.pages ? formatPageList(config.pages) : 'all'} ` +
      `captureDir=${captureDir}`
  )

  const analyzer = createPageAnalyzer(config, env)
  log.info(`preflight: checking the ${config.backend} CLI...`)
  await analyzer.preflight()

  const summary = await runAnalysisPhase({
    captureDir,
    bookTextPath,
    analyzer,
    reprocess: config.reprocess,
    pages: config.pages,
    log
  })
  return { asin, backend: config.backend, summary }
}

async function main(): Promise<void> {
  try {
    const { asin, backend, summary } = await analyzeBook({
      cwd: process.cwd(),
      env: process.env
    })
    console.log(
      `[analyze] finished ASIN=${asin} backend=${backend}: ` +
        `${summary.analyzed} analyzed, ${summary.reused} reused, ` +
        `${summary.failed} failed, ${summary.skipped} skipped -> ` +
        summary.outputPath
    )
    if (summary.failed > 0) {
      console.error(
        `[analyze] ${summary.failed} page(s) failed: ` +
          `${formatPageList(summary.failedPages)}. They are flagged as gaps ` +
          'in book-text.md with their page images preserved. Rerun with ' +
          `PAGES=${formatPageList(summary.failedPages)} to retry just those.`
      )
      process.exitCode = 1
    }
  } catch (err) {
    console.error('[analyze] fatal error:', err)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  await main()
}
