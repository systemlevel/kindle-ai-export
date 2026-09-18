/* eslint-disable no-process-env */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { diagnosticSample, runCliProcess } from '../book-processing/cli-process'

const maxPageCount = 100_000

async function runPoppler(
  command: 'pdfinfo' | 'pdftoppm',
  args: string[],
  timeoutMs: number
): Promise<string> {
  const result = await runCliProcess(command, args, {
    env: { ...process.env, LC_ALL: 'C' },
    timeoutMs,
    stdoutMaxBytes: 1024 * 1024,
    stderrMaxBytes: 1024 * 1024
  })
  if (result.spawnError) {
    if ((result.spawnError as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Poppler tool ${command} is missing. Install Poppler with ` +
          '"brew install poppler" (macOS) or "apt install poppler-utils" (Linux).'
      )
    }
    throw new Error(`Could not run ${command}: ${result.spawnError.message}`)
  }
  if (result.timedOut) {
    throw new Error(`${command} timed out after ${timeoutMs / 1000} seconds`)
  }
  if (result.overflow) {
    throw new Error(`${command} exceeded its ${result.overflow} output limit`)
  }
  if (result.signal) {
    throw new Error(`${command} was terminated by ${result.signal}`)
  }
  if (result.exitCode !== 0) {
    const diagnostic = diagnosticSample(result.stderr || result.stdout)
    if (/password/i.test(diagnostic)) {
      throw new Error(
        `${command}: this PDF requires a password; provide an unlocked copy. ` +
          diagnostic
      )
    }
    throw new Error(
      `${command} could not process the PDF (invalid, unreadable, or ` +
        `unsupported input; exit ${result.exitCode}): ${diagnostic}`
    )
  }
  return result.stdout
}

/** Inspect physical PDF pages, including pages without an embedded text layer. */
export async function inspectPdf(
  pdfPath: string
): Promise<{ pageCount: number }> {
  const stdout = await runPoppler('pdfinfo', [path.resolve(pdfPath)], 60_000)
  const pageCount = Number(/^Pages:[\t ]+(\d+)[\t ]*$/m.exec(stdout)?.[1])
  if (
    !Number.isSafeInteger(pageCount) ||
    pageCount < 1 ||
    pageCount > maxPageCount
  ) {
    throw new Error(
      `pdfinfo returned an invalid page count; expected 1–${maxPageCount} pages`
    )
  }
  return { pageCount }
}

/** Render one physical page to a new PNG. The caller owns temporary cleanup. */
export async function renderPdfPage(options: {
  pdfPath: string
  pageNumber: number
  dpi: number
  outputPath: string
}): Promise<void> {
  const { pdfPath, pageNumber, dpi, outputPath } = options
  if (
    !Number.isSafeInteger(pageNumber) ||
    pageNumber < 1 ||
    pageNumber > maxPageCount
  ) {
    throw new Error(`pageNumber must be an integer from 1 to ${maxPageCount}`)
  }
  if (!Number.isSafeInteger(dpi) || dpi < 72 || dpi > 600) {
    throw new Error('DPI must be an integer from 72 to 600')
  }
  if (!outputPath.endsWith('.png')) {
    throw new Error('PDF page outputPath must end in .png')
  }
  const absoluteOutputPath = path.resolve(outputPath)
  const existing = await fs
    .lstat(absoluteOutputPath)
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined
      throw err
    })
  if (existing) {
    throw new Error(`PDF page output already exists: ${outputPath}`)
  }
  await runPoppler(
    'pdftoppm',
    [
      '-f',
      String(pageNumber),
      '-l',
      String(pageNumber),
      '-singlefile',
      '-r',
      String(dpi),
      '-png',
      path.resolve(pdfPath),
      absoluteOutputPath.slice(0, -4)
    ],
    120_000
  )
  const output = await fs.stat(absoluteOutputPath).catch(() => undefined)
  if (!output?.isFile() || output.size === 0) {
    throw new Error(`pdftoppm did not create a non-empty PNG: ${outputPath}`)
  }
}
