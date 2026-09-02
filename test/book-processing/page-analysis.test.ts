import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, test } from 'vitest'

import {
  PageAnalysisError,
  type PageAnalyzer,
  parsePageSelection,
  runAnalysisPhase
} from '../../src/book-processing/page-analysis'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

function pad4(n: number): string {
  return `${n}`.padStart(4, '0')
}

async function writeSyntheticPng(filePath: string): Promise<void> {
  const buffer = await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  })
    .png()
    .toBuffer()
  await fs.writeFile(filePath, buffer)
}

async function createCaptureFixture(pageCount: number): Promise<{
  captureDir: string
  bookTextPath: string
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'page-analysis-'))
  temporaryDirectories.push(root)
  const outDir = path.join(root, 'out', 'TESTASIN')
  const captureDir = path.join(outDir, 'text-capture')
  await fs.mkdir(captureDir, { recursive: true })
  for (let page = 1; page <= pageCount; page++) {
    await writeSyntheticPng(path.join(captureDir, `page-${pad4(page)}.png`))
  }
  return { captureDir, bookTextPath: path.join(outDir, 'book-text.md') }
}

async function writeCachedResult(
  captureDir: string,
  page: number,
  text: string
): Promise<void> {
  await fs.writeFile(
    path.join(captureDir, `page-${pad4(page)}.json`),
    JSON.stringify({ text, visuals: [] })
  )
}

async function readCachedResult(
  captureDir: string,
  page: number
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(path.join(captureDir, `page-${pad4(page)}.json`), 'utf8')
  ) as Record<string, unknown>
}

function fakeAnalyzer(
  options: {
    failOn?: number[]
    /** Fail this many attempts for a page before succeeding. */
    transientFailures?: number
    nonRetryable?: boolean
  } = {}
): PageAnalyzer & { calls: string[] } {
  const calls: string[] = []
  const attempts = new Map<number, number>()
  return {
    backend: 'codex',
    identity: { backend: 'codex', model: null, effort: 'xhigh' },
    calls,
    describe: () => 'fake analyzer',
    preflight: async () => undefined,
    async analyzePage(pngPath) {
      const file = path.basename(pngPath)
      calls.push(file)
      const page = Number(/page-(\d+)\.png$/.exec(file)![1])
      const attempt = (attempts.get(page) ?? 0) + 1
      attempts.set(page, attempt)
      if (options.failOn?.includes(page)) {
        throw new PageAnalysisError(`boom on page ${page}`, {
          retryable: !options.nonRetryable
        })
      }
      if (options.transientFailures && attempt <= options.transientFailures) {
        throw new Error(`transient failure ${attempt} on page ${page}`)
      }
      return { text: `fresh text ${page}`, visuals: [] }
    }
  }
}

// Tests never wait for the real 3 s backoff.
const fastRetry = { retryBaseDelayMs: 1 }

const silentLog = { info: () => undefined, warn: () => undefined }

describe('parsePageSelection', () => {
  test('parses page numbers and inclusive ranges', () => {
    expect(
      [...parsePageSelection('1-3, 7,10-11')].toSorted((a, b) => a - b)
    ).toEqual([1, 2, 3, 7, 10, 11])
  })

  test('rejects malformed selections', () => {
    for (const raw of ['', 'a', '0', '5-2', '1,,2', '3-']) {
      expect(() => parsePageSelection(raw), raw).toThrow(/PAGES/)
    }
  })
})

describe('runAnalysisPhase', () => {
  test('resumes by reusing cached results and analyzing only missing pages', async () => {
    const { captureDir, bookTextPath } = await createCaptureFixture(3)
    await writeCachedResult(captureDir, 2, 'cached text 2')
    const analyzer = fakeAnalyzer()

    const summary = await runAnalysisPhase({
      captureDir,
      bookTextPath,
      analyzer,
      log: silentLog
    })

    expect(analyzer.calls).toEqual(['page-0001.png', 'page-0003.png'])
    expect(summary).toMatchObject({
      pageCount: 3,
      analyzed: 2,
      reused: 1,
      failed: 0,
      skipped: 0,
      failedPages: []
    })
    const markdown = await fs.readFile(bookTextPath, 'utf8')
    expect(markdown).toBe(
      'fresh text 1\n\n---\n\ncached text 2\n\n---\n\nfresh text 3\n'
    )
    const cached = await readCachedResult(captureDir, 1)
    expect(cached).toMatchObject({
      text: 'fresh text 1',
      visuals: [],
      analyzer: { backend: 'codex', model: null, effort: 'xhigh' }
    })
    expect(typeof (cached.analyzer as Record<string, unknown>).analyzedAt).toBe(
      'string'
    )
  })

  test('reprocess re-analyzes pages that already have results', async () => {
    const { captureDir, bookTextPath } = await createCaptureFixture(2)
    await writeCachedResult(captureDir, 1, 'cached text 1')
    await writeCachedResult(captureDir, 2, 'cached text 2')
    const analyzer = fakeAnalyzer()

    const summary = await runAnalysisPhase({
      captureDir,
      bookTextPath,
      analyzer,
      reprocess: true,
      log: silentLog
    })

    expect(analyzer.calls).toEqual(['page-0001.png', 'page-0002.png'])
    expect(summary).toMatchObject({ analyzed: 2, reused: 0, failed: 0 })
    expect(await fs.readFile(bookTextPath, 'utf8')).toBe(
      'fresh text 1\n\n---\n\nfresh text 2\n'
    )
  })

  test('page selection limits which pages reach the analyzer', async () => {
    const { captureDir, bookTextPath } = await createCaptureFixture(4)
    await writeCachedResult(captureDir, 3, 'cached text 3')
    const analyzer = fakeAnalyzer()

    const summary = await runAnalysisPhase({
      captureDir,
      bookTextPath,
      analyzer,
      reprocess: true,
      pages: new Set([1, 2]),
      log: silentLog
    })

    expect(analyzer.calls).toEqual(['page-0001.png', 'page-0002.png'])
    expect(summary).toMatchObject({
      analyzed: 2,
      reused: 1,
      skipped: 1,
      skippedPages: [4]
    })
    const markdown = await fs.readFile(bookTextPath, 'utf8')
    expect(markdown).toMatch(
      /^fresh text 1\n\n---\n\nfresh text 2\n\n---\n\ncached text 3\n\n---\n\n/
    )
    // Never silently drop a page: the skipped page is flagged in place.
    expect(markdown).toContain('Page 4: not analyzed')
    expect(markdown).toContain(
      '![Page 4 (not transcribed)](text-capture/assets/page-0004-full.png)'
    )
  })

  test('a failed page keeps its previous cached result', async () => {
    const { captureDir, bookTextPath } = await createCaptureFixture(2)
    await writeCachedResult(captureDir, 1, 'cached text 1')
    const analyzer = fakeAnalyzer({ failOn: [1] })

    const summary = await runAnalysisPhase({
      captureDir,
      bookTextPath,
      analyzer,
      reprocess: true,
      log: silentLog,
      ...fastRetry
    })

    expect(summary).toMatchObject({
      analyzed: 1,
      failed: 1,
      failedPages: [1]
    })
    expect(await readCachedResult(captureDir, 1)).toEqual({
      text: 'cached text 1',
      visuals: []
    })
    expect(await fs.readFile(bookTextPath, 'utf8')).toBe(
      'cached text 1\n\n---\n\nfresh text 2\n'
    )
  })

  test('retries a transient failure with backoff before succeeding', async () => {
    const { captureDir, bookTextPath } = await createCaptureFixture(1)
    const analyzer = fakeAnalyzer({ transientFailures: 2 })

    const summary = await runAnalysisPhase({
      captureDir,
      bookTextPath,
      analyzer,
      log: silentLog,
      ...fastRetry
    })

    expect(analyzer.calls).toHaveLength(3)
    expect(summary).toMatchObject({ analyzed: 1, failed: 0, failedPages: [] })
    expect(await fs.readFile(bookTextPath, 'utf8')).toBe('fresh text 1\n')
  })

  test('gives up after the configured attempts and reports the page', async () => {
    const { captureDir, bookTextPath } = await createCaptureFixture(1)
    const analyzer = fakeAnalyzer({ transientFailures: 99 })

    const summary = await runAnalysisPhase({
      captureDir,
      bookTextPath,
      analyzer,
      retryAttempts: 2,
      log: silentLog,
      ...fastRetry
    })

    expect(analyzer.calls).toHaveLength(2)
    expect(summary).toMatchObject({ analyzed: 0, failed: 1, failedPages: [1] })
  })

  test('does not retry a failure the analyzer marks as not retryable', async () => {
    const { captureDir, bookTextPath } = await createCaptureFixture(1)
    const analyzer = fakeAnalyzer({ failOn: [1], nonRetryable: true })

    const summary = await runAnalysisPhase({
      captureDir,
      bookTextPath,
      analyzer,
      log: silentLog,
      ...fastRetry
    })

    expect(analyzer.calls).toHaveLength(1)
    expect(summary).toMatchObject({ failed: 1, failedPages: [1] })
  })

  test('renders a visible gap with the page image when a page fails without a cached result', async () => {
    const { captureDir, bookTextPath } = await createCaptureFixture(2)
    const analyzer = fakeAnalyzer({ failOn: [1], nonRetryable: true })

    await runAnalysisPhase({
      captureDir,
      bookTextPath,
      analyzer,
      log: silentLog,
      ...fastRetry
    })

    const markdown = await fs.readFile(bookTextPath, 'utf8')
    expect(markdown).toContain('Page 1: automated analysis FAILED')
    expect(markdown).toContain(
      '![Page 1 (not transcribed)](text-capture/assets/page-0001-full.png)'
    )
    expect(markdown).toContain('fresh text 2')
    await expect(
      fs.access(path.join(captureDir, 'assets', 'page-0001-full.png'))
    ).resolves.toBeUndefined()
    // No JSON is cached for a failed page, so a plain rerun retries it.
    await expect(
      fs.access(path.join(captureDir, 'page-0001.json'))
    ).rejects.toThrow()
  })

  test('an unreadable cached result is re-analyzed', async () => {
    const { captureDir, bookTextPath } = await createCaptureFixture(1)
    await fs.writeFile(path.join(captureDir, 'page-0001.json'), '{not json')
    const analyzer = fakeAnalyzer()

    const summary = await runAnalysisPhase({
      captureDir,
      bookTextPath,
      analyzer,
      log: silentLog
    })

    expect(analyzer.calls).toEqual(['page-0001.png'])
    expect(summary).toMatchObject({ analyzed: 1, reused: 0 })
  })

  test('fails fast when the capture directory has no page images', async () => {
    const { captureDir, bookTextPath } = await createCaptureFixture(0)

    await expect(
      runAnalysisPhase({
        captureDir,
        bookTextPath,
        analyzer: fakeAnalyzer(),
        log: silentLog
      })
    ).rejects.toThrow(/no captured page images/i)
  })
})
