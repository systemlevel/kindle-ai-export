import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type {
  AvailablePageSource,
  BookDocument,
  Citation,
  NormalizedBlock,
  ProcessorIdentity,
  RawBlockKind,
  SucceededPageCheckpoint
} from '../../src/book-processing/types'
import type { TocItem } from '../../src/types'
import {
  partialLegacyContentRejectionMessage,
  projectLegacyContent,
  writeLegacyContent
} from '../../src/book-processing/legacy-content'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

async function createOutDir(): Promise<string> {
  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kindle-legacy-content-')
  )
  temporaryDirectories.push(outDir)
  return outDir
}

const processor: ProcessorIdentity = {
  runnerKind: 'codex-cli',
  codexCliVersion: '0.1.0',
  requestedModel: 'cli-default',
  promptVersion: '1',
  promptSha256: 'a'.repeat(64),
  outputSchemaVersion: '1',
  outputSchemaSha256: 'b'.repeat(64),
  normalizerVersion: '1',
  configurationHash: 'c'.repeat(64)
}

function sourceFor(
  captureId: string,
  printedPage: number | null
): AvailablePageSource {
  const index = Number.parseInt(captureId.slice(1), 10)
  return {
    captureId,
    index,
    printedPage,
    position: null,
    screenshotPath: `pages/${captureId}.png`,
    rendererBatch: null,
    availability: 'available',
    screenshotSha256: String(index).padStart(64, '0'),
    width: 100,
    height: 50
  }
}

function citationFor(
  source: AvailablePageSource,
  order: number,
  kind: RawBlockKind
): Citation {
  return {
    id: `citation-${source.captureId}-${order}`,
    asin: 'TESTASIN',
    editionVersion: 'edition-1',
    captureId: source.captureId,
    captureIndex: source.index,
    printedPage: source.printedPage,
    position: source.position,
    screenshotPath: source.screenshotPath,
    screenshotSha256: source.screenshotSha256,
    blockId: `b${String(order).padStart(4, '0')}`,
    blockKind: kind,
    region: null,
    processorConfigurationHash: processor.configurationHash
  }
}

function blockFor(
  source: AvailablePageSource,
  order: number,
  kind: RawBlockKind,
  text: string
): NormalizedBlock {
  return {
    order,
    kind,
    runs: [{ text, styles: [] }],
    alignment: 'left',
    indentLevel: 0,
    headingLevel: kind === 'heading' ? 1 : null,
    region: null,
    regionConfidence: 'unknown',
    mediaDescription: null,
    caption: null,
    blockId: `b${String(order).padStart(4, '0')}`,
    text,
    citation: citationFor(source, order, kind),
    mediaAsset: null
  }
}

function succeededPageFor(
  source: AvailablePageSource,
  blocks: NormalizedBlock[]
): SucceededPageCheckpoint {
  return {
    status: 'succeeded',
    source,
    provenance: {
      runnerKind: 'codex-cli',
      codexCliVersion: processor.codexCliVersion,
      requestedModel: processor.requestedModel,
      promptVersion: processor.promptVersion,
      outputSchemaVersion: processor.outputSchemaVersion,
      normalizerVersion: processor.normalizerVersion,
      configurationHash: processor.configurationHash,
      pageCacheKey: 'key',
      runId: 'run-1',
      batchId: 'batch-1',
      attempts: 1,
      completedAt: '2026-08-27T00:00:01.000Z'
    },
    document: { source, blocks, warnings: [] }
  }
}

function bookDocumentFor(
  pages: BookDocument['pages'],
  status: BookDocument['status']
): BookDocument {
  const succeeded = pages.filter((page) => page.status === 'succeeded').length
  const failed = pages.filter((page) => page.status === 'failed').length
  return {
    schemaVersion: '1',
    book: {
      asin: 'TESTASIN',
      editionVersion: 'edition-1',
      title: 'Test Book',
      authors: ['Author One']
    },
    processor,
    status,
    counts: {
      expected: pages.length,
      captured: pages.length,
      succeeded,
      failed,
      pending: pages.length - succeeded - failed
    },
    pages
  }
}

const toc: TocItem[] = [
  { label: 'Chapter One', positionId: 1, page: 1, depth: 1 },
  { label: 'Chapter Two', positionId: 2, page: 2, depth: 1 }
]

describe('projectLegacyContent', () => {
  test('excludes page-number blocks and joins the rest with a blank line', () => {
    const source = sourceFor('c000000', 5)
    const page = succeededPageFor(source, [
      blockFor(source, 0, 'paragraph', 'First paragraph.'),
      blockFor(source, 1, 'page-number', '5'),
      blockFor(source, 2, 'paragraph', 'Second paragraph.')
    ])
    const document = bookDocumentFor([page], 'complete')

    const chunks = projectLegacyContent(document, toc, { allowPartial: false })

    expect(chunks).toEqual([
      {
        index: 0,
        page: 5,
        screenshot: 'pages/c000000.png',
        text: 'First paragraph.\n\nSecond paragraph.'
      }
    ])
  })

  test('strips only a leading heading that case-insensitively matches the TOC label for that page', () => {
    const source = sourceFor('c000000', 1)
    const page = succeededPageFor(source, [
      blockFor(source, 0, 'heading', 'CHAPTER ONE'),
      blockFor(source, 1, 'paragraph', 'Body text.')
    ])
    const document = bookDocumentFor([page], 'complete')

    const chunks = projectLegacyContent(document, toc, { allowPartial: false })

    expect(chunks[0]!.text).toBe('Body text.')
  })

  test('does not strip a non-leading heading even when it matches the TOC label', () => {
    const source = sourceFor('c000000', 1)
    const page = succeededPageFor(source, [
      blockFor(source, 0, 'paragraph', 'Body text.'),
      blockFor(source, 1, 'heading', 'Chapter One')
    ])
    const document = bookDocumentFor([page], 'complete')

    const chunks = projectLegacyContent(document, toc, { allowPartial: false })

    expect(chunks[0]!.text).toBe('Body text.\n\nChapter One')
  })

  test('does not strip a leading heading that does not match the TOC label', () => {
    const source = sourceFor('c000000', 1)
    const page = succeededPageFor(source, [
      blockFor(source, 0, 'heading', 'Unrelated Heading'),
      blockFor(source, 1, 'paragraph', 'Body text.')
    ])
    const document = bookDocumentFor([page], 'complete')

    const chunks = projectLegacyContent(document, toc, { allowPartial: false })

    expect(chunks[0]!.text).toBe('Unrelated Heading\n\nBody text.')
  })

  test('preserves canonical block arrays without mutating or reordering them', () => {
    const source = sourceFor('c000000', 1)
    const blocks = [
      blockFor(source, 0, 'heading', 'Chapter One'),
      blockFor(source, 1, 'page-number', '1'),
      blockFor(source, 2, 'paragraph', 'Body text.')
    ]
    const snapshot = structuredClone(blocks)
    const page = succeededPageFor(source, blocks)
    const document = bookDocumentFor([page], 'complete')

    projectLegacyContent(document, toc, { allowPartial: false })

    expect(blocks).toEqual(snapshot)
    expect(blocks).toHaveLength(3)
    // Calling again produces identical output, confirming the first call
    // left the canonical blocks untouched rather than consuming them.
    expect(
      projectLegacyContent(document, toc, { allowPartial: false })
    ).toEqual(projectLegacyContent(document, toc, { allowPartial: false }))
  })

  test('throws when a succeeded page is missing a printed page number', () => {
    const source = sourceFor('c000000', null)
    const page = succeededPageFor(source, [
      blockFor(source, 0, 'paragraph', 'Body text.')
    ])
    const document = bookDocumentFor([page], 'complete')

    expect(() =>
      projectLegacyContent(document, toc, { allowPartial: false })
    ).toThrow(/c000000/)
    expect(() =>
      projectLegacyContent(document, toc, { allowPartial: false })
    ).toThrow(/printed page/i)
  })

  const succeededPage = succeededPageFor(sourceFor('c000000', 1), [
    blockFor(sourceFor('c000000', 1), 0, 'paragraph', 'Body text.')
  ])
  const failedPage: BookDocument['pages'][number] = {
    status: 'failed',
    source: sourceFor('c000001', 2),
    provenance: {
      runnerKind: 'codex-cli',
      codexCliVersion: processor.codexCliVersion,
      requestedModel: processor.requestedModel,
      promptVersion: processor.promptVersion,
      outputSchemaVersion: processor.outputSchemaVersion,
      normalizerVersion: processor.normalizerVersion,
      configurationHash: processor.configurationHash,
      pageCacheKey: 'key',
      runId: 'run-1',
      batchId: 'batch-1',
      attempts: 2,
      completedAt: '2026-08-27T00:00:01.000Z'
    },
    failure: {
      category: 'timeout',
      code: 'timeout',
      message: 'Codex invocation timed out',
      attempts: 2,
      occurredAt: '2026-08-27T00:00:01.000Z',
      exitCode: null,
      signal: null
    }
  }
  const pendingPage = {
    status: 'pending' as const,
    source: sourceFor('c000002', 3)
  }
  const partialBook = bookDocumentFor(
    [succeededPage, failedPage, pendingPage],
    'partial'
  )

  test('rejects partial legacy output by default', () => {
    expect(() =>
      projectLegacyContent(partialBook, toc, { allowPartial: false })
    ).toThrow(partialLegacyContentRejectionMessage)
    expect(() =>
      projectLegacyContent(partialBook, toc, { allowPartial: false })
    ).toThrow(
      'Book processing is partial; set ALLOW_PARTIAL=true to export visible gaps'
    )
  })

  test('inserts an explicit failed-page marker when allowed', () => {
    const chunks = projectLegacyContent(partialBook, toc, {
      allowPartial: true
    })
    expect(chunks[1]!.text).toBe(
      '[Missing captured page c000001; processing failed]'
    )
  })

  test('inserts markers for every non-succeeded status while preserving order', () => {
    const chunks = projectLegacyContent(partialBook, toc, {
      allowPartial: true
    })
    expect(chunks).toHaveLength(3)
    expect(chunks[0]!.index).toBe(0)
    expect(chunks[1]!.text).toBe(
      '[Missing captured page c000001; processing failed]'
    )
    expect(chunks[2]!.text).toBe(
      '[Missing captured page c000002; processing pending]'
    )
    expect(chunks[2]!.page).toBe(3)
  })

  test('does not reject an already-complete document even when allowPartial is false', () => {
    const document = bookDocumentFor([succeededPage], 'complete')
    expect(() =>
      projectLegacyContent(document, toc, { allowPartial: false })
    ).not.toThrow()
  })
})

describe('writeLegacyContent', () => {
  test('writes chunks as private atomic JSON', async () => {
    const outDir = await createOutDir()
    const source = sourceFor('c000000', 1)
    const page = succeededPageFor(source, [
      blockFor(source, 0, 'paragraph', 'Body text.')
    ])
    const document = bookDocumentFor([page], 'complete')
    const chunks = projectLegacyContent(document, toc, { allowPartial: false })

    await writeLegacyContent(outDir, chunks)

    const filePath = path.join(outDir, 'content.json')
    const contents = await fs.readFile(filePath, 'utf8')
    expect(JSON.parse(contents)).toEqual(chunks)
    const stat = await fs.stat(filePath)
    expect(stat.mode & 0o777).toBe(0o600)
  })
})
