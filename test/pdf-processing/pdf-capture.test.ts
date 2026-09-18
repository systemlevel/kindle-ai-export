/* eslint-disable no-process-env */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { parsePdfOptions, processPdfBook } from '../../src/capture-pdf-text'
import { capturePdfBook } from '../../src/pdf-processing/pdf-capture'

const directories: string[] = []
const quietLog = { info: () => undefined, warn: () => undefined }

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true }))
  )
})

async function fixture(pageCount = 2) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-capture-test-'))
  directories.push(cwd)
  const sourcePath = path.join(cwd, 'A Book.pdf')
  await fs.writeFile(sourcePath, '%PDF-fake source for isolated capture tests')
  const inspectPdf = vi.fn(async () => ({ pageCount }))
  const renderPdfPage = vi.fn(
    async ({
      outputPath,
      pageNumber
    }: {
      outputPath: string
      pageNumber: number
    }) => {
      await sharp({
        create: {
          width: 200,
          height: 200,
          channels: 3,
          background: { r: pageNumber, g: 255, b: 255 }
        }
      })
        .png()
        .toFile(outputPath)
    }
  )
  return {
    cwd,
    sourcePath,
    options: { sourcePath, outRoot: path.join(cwd, 'out'), dpi: 150 },
    dependencies: { inspectPdf, renderPdfPage },
    renderPdfPage
  }
}

describe('PDF capture isolation and resume', () => {
  test('captures every physical page into a dedicated folder and resumes without rendering', async () => {
    const f = await fixture()
    const first = await capturePdfBook(f.options, f.dependencies)
    expect(path.basename(first.bookDir)).toMatch(/^pdf-a-book-[a-f0-9]{12}$/)
    expect(
      await fs.readFile(path.join(first.bookDir, 'source.pdf'), 'utf8')
    ).toBe(await fs.readFile(f.sourcePath, 'utf8'))
    expect(await fs.readdir(path.join(first.bookDir, 'text-capture'))).toEqual([
      'page-0001.png',
      'page-0002.png'
    ])
    expect(first.pageCount).toBe(2)
    await capturePdfBook(f.options, f.dependencies)
    expect(f.renderPdfPage).toHaveBeenCalledTimes(2)
  })

  test('refuses to write inside an existing Kindle output folder', async () => {
    const f = await fixture()
    const kindle = path.join(f.options.outRoot, 'kindle-book')
    await fs.mkdir(path.join(kindle, 'text-capture'), { recursive: true })
    await fs.writeFile(path.join(kindle, 'book.txt'), 'Kindle content')
    await expect(
      capturePdfBook({ ...f.options, bookName: 'kindle-book' }, f.dependencies)
    ).rejects.toThrow(/not a PDF capture/)
    expect(await fs.readFile(path.join(kindle, 'book.txt'), 'utf8')).toBe(
      'Kindle content'
    )
    expect(await fs.readdir(kindle)).toEqual(['book.txt', 'text-capture'])
    expect(f.renderPdfPage).not.toHaveBeenCalled()
  })

  test('refuses source and resolution changes for the same output folder', async () => {
    const f = await fixture()
    const options = { ...f.options, bookName: 'my-pdf' }
    await capturePdfBook(options, f.dependencies)
    await expect(
      capturePdfBook({ ...options, dpi: 200 }, f.dependencies)
    ).rejects.toThrow(/resolution/)
    await fs.appendFile(f.sourcePath, '\nchanged')
    await expect(capturePdfBook(options, f.dependencies)).rejects.toThrow(
      /different PDF/
    )
  })

  test('resumes interrupted rendering and releases the per-book lock', async () => {
    const f = await fixture(3)
    const realRender = f.renderPdfPage.getMockImplementation()
    if (!realRender) throw new Error('Missing fixture renderer')
    f.renderPdfPage.mockImplementation(async (args) => {
      if (args.pageNumber === 2) throw new Error('render interrupted')
      await realRender(args)
    })
    await expect(capturePdfBook(f.options, f.dependencies)).rejects.toThrow(
      'render interrupted'
    )
    f.renderPdfPage.mockImplementation(realRender)
    const result = await capturePdfBook(f.options, f.dependencies)
    expect(f.renderPdfPage.mock.calls.map(([args]) => args.pageNumber)).toEqual(
      [1, 2, 2, 3]
    )
    await expect(
      fs.access(path.join(result.bookDir, '.pdf-capture.lock'))
    ).rejects.toThrow()
  })

  test('repairs a missing or modified image and invalidates only its cached analysis', async () => {
    const f = await fixture()
    const { bookDir } = await capturePdfBook(f.options, f.dependencies)
    await fs.writeFile(
      path.join(bookDir, 'text-capture/page-0001.json'),
      'stale'
    )
    await fs.writeFile(
      path.join(bookDir, 'text-capture/page-0002.json'),
      'keep'
    )
    await fs.writeFile(
      path.join(bookDir, 'book-text.md'),
      'stale combined output'
    )
    await fs.writeFile(
      path.join(bookDir, 'text-capture/page-0001.png'),
      'modified'
    )
    await capturePdfBook(f.options, f.dependencies)
    expect(f.renderPdfPage).toHaveBeenCalledTimes(3)
    await expect(
      fs.access(path.join(bookDir, 'text-capture/page-0001.json'))
    ).rejects.toThrow()
    expect(
      await fs.readFile(
        path.join(bookDir, 'text-capture/page-0002.json'),
        'utf8'
      )
    ).toBe('keep')
    await expect(
      fs.access(path.join(bookDir, 'book-text.md'))
    ).rejects.toThrow()
  })

  test('analyze-only fails if capture is incomplete or untrusted, without repairing it', async () => {
    const f = await fixture()
    await expect(
      capturePdfBook({ ...f.options, analyzeOnly: true }, f.dependencies)
    ).rejects.toThrow(/capture/i)
    const { bookDir } = await capturePdfBook(f.options, f.dependencies)
    await fs.unlink(path.join(bookDir, 'text-capture/page-0002.png'))
    await expect(
      capturePdfBook({ ...f.options, analyzeOnly: true }, f.dependencies)
    ).rejects.toThrow(/page-0002/)
    expect(f.renderPdfPage).toHaveBeenCalledTimes(2)
  })

  test('rejects concurrent runs and unexpected PNG pages instead of ingesting them', async () => {
    const f = await fixture()
    const { bookDir } = await capturePdfBook(f.options, f.dependencies)
    const lock = path.join(bookDir, '.pdf-capture.lock')
    await fs.writeFile(lock, 'another run')
    await expect(capturePdfBook(f.options, f.dependencies)).rejects.toThrow(
      /lock/
    )
    expect(await fs.readFile(lock, 'utf8')).toBe('another run')
    await fs.unlink(lock)
    await fs.writeFile(
      path.join(bookDir, 'text-capture/foreign.png'),
      'foreign'
    )
    await expect(capturePdfBook(f.options, f.dependencies)).rejects.toThrow(
      /unexpected.*PNG/i
    )
  })

  test('rejects symlink destinations and corrupt source snapshots', async () => {
    const f = await fixture()
    await fs.mkdir(f.options.outRoot)
    const target = path.join(f.cwd, 'kindle')
    await fs.mkdir(target)
    await fs.symlink(target, path.join(f.options.outRoot, 'linked'))
    await expect(
      capturePdfBook({ ...f.options, bookName: 'linked' }, f.dependencies)
    ).rejects.toThrow(/symlink/i)
    const { bookDir } = await capturePdfBook(f.options, f.dependencies)
    await fs.writeFile(path.join(bookDir, 'source.pdf'), 'modified snapshot')
    await expect(capturePdfBook(f.options, f.dependencies)).rejects.toThrow(
      /snapshot/
    )
  })

  test('removes interrupted temporary renders before analysis and holds the lock throughout it', async () => {
    const f = await fixture()
    const { bookDir } = await capturePdfBook(f.options, f.dependencies)
    await fs.writeFile(
      path.join(bookDir, 'text-capture/page-0001.rendering.png'),
      'interrupted'
    )
    await capturePdfBook(f.options, f.dependencies, async () => {
      await expect(
        fs.access(path.join(bookDir, '.pdf-capture.lock'))
      ).resolves.toBeUndefined()
      await expect(
        fs.access(path.join(bookDir, 'text-capture/page-0001.rendering.png'))
      ).rejects.toThrow()
      await expect(capturePdfBook(f.options, f.dependencies)).rejects.toThrow(
        /lock/
      )
    })
  })

  test.each([
    'book-text.md',
    'text-capture/page-0001.json',
    'text-capture/assets'
  ])('refuses analysis output symlinks at %s', async (relativePath) => {
    const f = await fixture()
    const { bookDir } = await capturePdfBook(f.options, f.dependencies)
    const external = path.join(f.cwd, 'kindle-output')
    await fs.writeFile(external, 'untouched Kindle')
    await fs.symlink(external, path.join(bookDir, relativePath))
    const analyze = vi.fn()
    await expect(
      capturePdfBook(f.options, f.dependencies, analyze)
    ).rejects.toThrow(/symlink/)
    expect(analyze).not.toHaveBeenCalled()
    expect(await fs.readFile(external, 'utf8')).toBe('untouched Kindle')
  })
})

describe('PDF command', () => {
  test('uses PDF-specific inputs and ignores Kindle BOOK selection', () => {
    expect(
      parsePdfOptions({
        argv: ['book.pdf'],
        env: { BOOK: 'kindle-output' },
        cwd: '/tmp/project'
      })
    ).toMatchObject({
      sourcePath: '/tmp/project/book.pdf',
      outRoot: '/tmp/project/out',
      dpi: 150,
      bookName: undefined
    })
    expect(() => parsePdfOptions({ argv: [], env: {} })).toThrow(/PDF_FILE/)
    expect(() =>
      parsePdfOptions({ argv: ['book.pdf'], env: { PDF_DPI: '150oops' } })
    ).toThrow(/PDF_DPI/)
    expect(() =>
      parsePdfOptions({ argv: ['book.pdf'], env: { PDF_BOOK: '../kindle' } })
    ).toThrow(/PDF_BOOK/)
    expect(() =>
      parsePdfOptions({
        argv: ['book.pdf'],
        env: { CAPTURE_ONLY: '1', ANALYZE_ONLY: '1' }
      })
    ).toThrow(/together/)
    expect(() =>
      parsePdfOptions({ argv: ['book.pdf'], env: { CAPTURE_ONLY: 'tru' } })
    ).toThrow(/CAPTURE_ONLY/)
  })

  test('capture-only needs no AI credentials or provider and analysis can later use the existing analyzer', async () => {
    const f = await fixture()
    const captured = await processPdfBook(
      {
        argv: [f.sourcePath],
        cwd: f.cwd,
        env: { CAPTURE_ONLY: '1', ANALYZER: 'invalid' },
        log: quietLog
      },
      f.dependencies
    )
    expect(captured.summary).toBeUndefined()
    const analyzed = await processPdfBook(
      {
        argv: [f.sourcePath],
        cwd: f.cwd,
        log: quietLog,
        env: {
          ...process.env,
          ANALYZE_ONLY: '1',
          ANALYZER: 'claude',
          CLAUDE_CLI_BIN: path.resolve('test/fixtures/fake-claude.mjs'),
          REPROCESS: '0',
          PAGES: ''
        }
      },
      f.dependencies
    )
    expect(analyzed.summary?.analyzed).toBe(2)
    const markdown = await fs.readFile(
      path.join(captured.bookDir, 'book-text.md'),
      'utf8'
    )
    expect(markdown).toContain('Claude page text')
    expect(markdown).toContain('A rising line chart.')
    const assets = await fs.readdir(
      path.join(captured.bookDir, 'text-capture/assets')
    )
    expect(assets.some((asset) => asset.includes('page-0001'))).toBe(true)
    expect(markdown).toContain('text-capture/assets/')
    const cropMetadata = await Promise.all(
      assets.map((asset) =>
        sharp(
          path.join(captured.bookDir, 'text-capture/assets', asset)
        ).metadata()
      )
    )
    expect(
      cropMetadata.some(
        (metadata) => metadata.width === 60 && metadata.height === 80
      )
    ).toBe(true)
    expect(f.renderPdfPage).toHaveBeenCalledTimes(2)
  })

  test('surfaces analysis failures, releases its lock, and retries from saved page images', async () => {
    const f = await fixture(1)
    const baseEnv = {
      ...process.env,
      ANALYZER: 'claude',
      CLAUDE_CLI_BIN: path.resolve('test/fixtures/fake-claude.mjs'),
      REPROCESS: '0',
      PAGES: ''
    }
    await expect(
      processPdfBook(
        {
          argv: [f.sourcePath],
          cwd: f.cwd,
          log: quietLog,
          env: { ...baseEnv, FAKE_CLAUDE_SCENARIO: 'malformed' }
        },
        f.dependencies
      )
    ).rejects.toThrow(/failed for 1 page/)
    const result = await processPdfBook(
      {
        argv: [f.sourcePath],
        cwd: f.cwd,
        log: quietLog,
        env: { ...baseEnv, FAKE_CLAUDE_SCENARIO: 'success' }
      },
      f.dependencies
    )
    expect(result.summary?.analyzed).toBe(1)
    expect(f.renderPdfPage).toHaveBeenCalledTimes(1)
    await expect(
      fs.access(path.join(result.bookDir, '.pdf-capture.lock'))
    ).rejects.toThrow()
  }, 20_000)
})
