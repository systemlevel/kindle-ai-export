import { createWriteStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'

import PDFDocument from 'pdfkit'
import sharp from 'sharp'
import { afterEach, describe, expect, test, vi } from 'vitest'

import * as cliProcess from '../../src/book-processing/cli-process'
import {
  inspectPdf,
  renderPdfPage
} from '../../src/pdf-processing/pdf-renderer'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

async function fixture(options: PDFKit.PDFDocumentOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-renderer-'))
  temporaryDirectories.push(root)
  // A valid filename containing shell metacharacters must be treated literally.
  const pdfPath = path.join(root, '-book $(touch UNEXPECTED) & notes.pdf')
  const outputPath = path.join(root, 'page-0002.partial.png')
  const stream = createWriteStream(pdfPath)
  const document = new PDFDocument({
    autoFirstPage: false,
    compress: false,
    ...options
  })
  document.pipe(stream)
  document.addPage({ size: [144, 72], margin: 0 })
  document.rect(0, 0, 144, 72).fill('#ff0000')
  document.fillColor('#000000').fontSize(8).text('First page', 2, 2)
  document.addPage({ size: [144, 72], margin: 0 })
  document.rect(0, 0, 144, 72).fill('#00ff00')
  document.fillColor('#000000').fontSize(8).text('Second page', 2, 2)
  document.end()
  await finished(stream)
  return { root, pdfPath, outputPath }
}

const successfulProcess: cliProcess.CliProcessResult = {
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  overflow: null,
  spawnError: null,
  durationMs: 1
}

describe('PDF renderer', () => {
  test('reads the physical page count from a real PDF', async () => {
    const { pdfPath } = await fixture()
    await expect(inspectPdf(pdfPath)).resolves.toEqual({ pageCount: 2 })
  })

  test('renders exactly the requested page at the requested resolution', async () => {
    const { root, pdfPath, outputPath } = await fixture()
    await renderPdfPage({ pdfPath, pageNumber: 2, dpi: 144, outputPath })
    const metadata = await sharp(outputPath).metadata()
    expect(metadata).toMatchObject({ format: 'png', width: 288, height: 144 })
    const { data } = await sharp(outputPath)
      .extract({ left: 200, top: 100, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect([...data]).toEqual([0, 255, 0])
    expect((await fs.readdir(root)).toSorted()).toEqual(
      [path.basename(pdfPath), 'page-0002.partial.png'].toSorted()
    )
  })

  test('reports how to install Poppler when pdfinfo is unavailable', async () => {
    const { pdfPath, root } = await fixture()
    vi.stubEnv('PATH', root)
    await expect(inspectPdf(pdfPath)).rejects.toThrow(
      /Poppler.*brew install poppler/i
    )
  })

  test('reports a malformed PDF with the Poppler diagnostic', async () => {
    const { pdfPath } = await fixture()
    await fs.writeFile(pdfPath, 'This is not a PDF.')
    await expect(inspectPdf(pdfPath)).rejects.toThrow(/invalid|malformed/i)
  })

  test('reports a password-protected PDF without asking for credentials', async () => {
    const { pdfPath } = await fixture({ userPassword: 'test-password' })
    await expect(inspectPdf(pdfPath)).rejects.toThrow(
      /password.*unlocked copy/i
    )
  })

  test('accepts encrypted PDFs that Poppler can read without a password', async () => {
    const { pdfPath, outputPath } = await fixture({
      ownerPassword: 'owner-password'
    })
    await expect(inspectPdf(pdfPath)).resolves.toEqual({ pageCount: 2 })
    await renderPdfPage({ pdfPath, pageNumber: 1, dpi: 72, outputPath })
    expect((await sharp(outputPath).metadata()).format).toBe('png')
  })

  test.each(['', 'Pages: 0', 'Pages: -2', 'Pages: 100001', 'Pages: 3.5'])(
    'rejects missing, invalid, or unbounded page counts: %s',
    async (stdout) => {
      const { pdfPath } = await fixture()
      vi.spyOn(cliProcess, 'runCliProcess').mockResolvedValue({
        ...successfulProcess,
        stdout
      })
      await expect(inspectPdf(pdfPath)).rejects.toThrow(/page count/i)
    }
  )

  test.each([
    { timedOut: true, expected: /timed out/i },
    { overflow: 'stderr' as const, expected: /output limit/i },
    { signal: 'SIGTERM' as const, expected: /SIGTERM/i }
  ])(
    'reports bounded process failures: $expected',
    async ({ expected, ...failure }) => {
      const { pdfPath } = await fixture()
      vi.spyOn(cliProcess, 'runCliProcess').mockResolvedValue({
        ...successfulProcess,
        stdout: 'Pages: 2',
        ...failure
      })
      await expect(inspectPdf(pdfPath)).rejects.toThrow(expected)
    }
  )

  test.each([
    { pageNumber: 0, dpi: 72 },
    { pageNumber: 1.5, dpi: 72 },
    { pageNumber: 100_001, dpi: 72 },
    { pageNumber: 1, dpi: 0 },
    { pageNumber: 1, dpi: 71 },
    { pageNumber: 1, dpi: 601 },
    { pageNumber: 1, dpi: Number.NaN }
  ])(
    'rejects invalid page or DPI limits: $pageNumber / $dpi',
    async (settings) => {
      const { pdfPath, outputPath } = await fixture()
      await expect(
        renderPdfPage({ pdfPath, outputPath, ...settings })
      ).rejects.toThrow(/pageNumber|DPI/)
      await expect(fs.access(outputPath)).rejects.toThrow()
    }
  )

  test('reports rendering beyond the end of the PDF', async () => {
    const { pdfPath, outputPath } = await fixture()
    await expect(
      renderPdfPage({ pdfPath, pageNumber: 3, dpi: 72, outputPath })
    ).rejects.toThrow(/pdftoppm.*page/i)
  })

  test('requires a PNG output filename rather than silently truncating it', async () => {
    const { pdfPath, root } = await fixture()
    await expect(
      renderPdfPage({
        pdfPath,
        pageNumber: 1,
        dpi: 72,
        outputPath: path.join(root, 'page.jpeg')
      })
    ).rejects.toThrow(/\.png/)
  })

  test('does not overwrite an existing output or confuse stale output with success', async () => {
    const { pdfPath, outputPath } = await fixture()
    await fs.writeFile(outputPath, 'existing content')
    await expect(
      renderPdfPage({ pdfPath, pageNumber: 1, dpi: 72, outputPath })
    ).rejects.toThrow(/already exists/i)
    expect(await fs.readFile(outputPath, 'utf8')).toBe('existing content')
  })

  test.each(['missing', 'empty'])(
    'rejects a successful process that leaves a %s output file',
    async (kind) => {
      const { pdfPath, outputPath } = await fixture()
      vi.spyOn(cliProcess, 'runCliProcess').mockImplementation(async () => {
        if (kind === 'empty') await fs.writeFile(outputPath, '')
        return successfulProcess
      })
      await expect(
        renderPdfPage({ pdfPath, pageNumber: 1, dpi: 72, outputPath })
      ).rejects.toThrow(/non-empty.*PNG/i)
    }
  )
})
