import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import PDFDocument from 'pdfkit'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type {
  AvailablePageSource,
  BookDocument,
  Citation,
  NormalizedBlock,
  ProcessingProvenance,
  ProcessorIdentity,
  RawBlockKind,
  SucceededPageCheckpoint
} from '../../src/book-processing/types'
import type { BookMetadata } from '../../src/types'
import { renderBookPdf } from '../../src/export-book-pdf'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

async function createOutDir(): Promise<string> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-export-pdf-'))
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

function provenanceFor(): ProcessingProvenance {
  return {
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
  }
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
  id: string,
  source: AvailablePageSource,
  order: number,
  kind: RawBlockKind
): Citation {
  return {
    id,
    asin: 'TESTASIN',
    editionVersion: 'edition000001',
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

function succeededPageFor(
  source: AvailablePageSource,
  blocks: NormalizedBlock[]
): SucceededPageCheckpoint {
  return {
    status: 'succeeded',
    source,
    provenance: provenanceFor(),
    document: { source, blocks, warnings: [] }
  }
}

function bookDocumentFor(source: AvailablePageSource): BookDocument {
  const headingBlock: NormalizedBlock = {
    order: 0,
    kind: 'heading',
    runs: [{ text: 'Chapter One', styles: [] }],
    alignment: 'left',
    indentLevel: 0,
    headingLevel: 1,
    region: null,
    regionConfidence: 'unknown',
    mediaDescription: null,
    caption: null,
    blockId: 'b0000',
    text: 'Chapter One',
    citation: citationFor(
      'knd:TESTASIN:edition000001:source000001:process00001:b0000',
      source,
      0,
      'heading'
    ),
    mediaAsset: null
  }

  const paragraphBlock: NormalizedBlock = {
    order: 1,
    kind: 'paragraph',
    runs: [
      { text: 'Body ', styles: [] },
      { text: 'text', styles: ['bold', 'italic'] },
      { text: '.', styles: [] }
    ],
    alignment: 'left',
    indentLevel: 0,
    headingLevel: null,
    region: null,
    regionConfidence: 'unknown',
    mediaDescription: null,
    caption: null,
    blockId: 'b0001',
    text: 'Body text.',
    citation: citationFor(
      'knd:TESTASIN:edition000001:source000001:process00001:b0001',
      source,
      1,
      'paragraph'
    ),
    mediaAsset: null
  }

  const imageBlock: NormalizedBlock = {
    order: 2,
    kind: 'image',
    runs: [],
    alignment: 'left',
    indentLevel: 0,
    headingLevel: null,
    region: { x: 100, y: 100, width: 400, height: 300 },
    regionConfidence: 'high',
    mediaDescription: 'A synthetic diagram of the system.',
    caption: 'Synthetic diagram',
    blockId: 'b0002',
    text: '',
    citation: citationFor(
      'knd:TESTASIN:edition000001:source000001:process00001:b0002',
      source,
      2,
      'image'
    ),
    mediaAsset: {
      path: 'assets/c000000/b0002.png',
      mimeType: 'image/png',
      width: 400,
      height: 300,
      sha256: 'd'.repeat(64),
      sourceScreenshotSha256: source.screenshotSha256,
      pixelCrop: { left: 100, top: 100, width: 400, height: 300 },
      derivation: 'page-crop'
    }
  }

  const page = succeededPageFor(source, [
    headingBlock,
    paragraphBlock,
    imageBlock
  ])

  return {
    schemaVersion: '1',
    book: {
      asin: 'TESTASIN',
      editionVersion: 'edition000001',
      title: 'Synthetic Book',
      authors: ['Test Author']
    },
    processor,
    status: 'complete',
    counts: {
      expected: 1,
      captured: 1,
      succeeded: 1,
      failed: 0,
      pending: 0
    },
    pages: [page]
  }
}

const metadata: BookMetadata = {
  meta: {
    ACR: 'acr',
    asin: 'TESTASIN',
    authorList: ['Test Author'],
    bookSize: '1',
    bookType: 'ebook',
    cover: 'cover.jpg',
    language: 'en',
    positions: { cover: 0, srl: 0, toc: 0 },
    publisher: 'Publisher',
    refEmId: 'ref',
    releaseDate: '2026-01-01',
    sample: false,
    title: 'Synthetic Book',
    version: 'edition000001',
    startPosition: 0,
    endPosition: 1000
  },
  info: {
    clippingLimit: 0,
    contentChecksum: null,
    contentType: 'ebook',
    contentVersion: '1',
    deliveredAsin: 'TESTASIN',
    downloadRestrictionReason: null,
    expirationDate: null,
    format: 'kfx',
    formatVersion: '1',
    fragmentMapUrl: null,
    hasAnnotations: false,
    isOwned: true,
    isSample: false,
    kindleSessionId: 'session',
    lastPageReadData: { deviceName: 'device', position: 0, syncTime: 0 },
    manifestUrl: null,
    originType: 'purchase',
    pageNumberUrl: null,
    requestedAsin: 'TESTASIN',
    srl: 0
  },
  nav: {
    startPosition: 0,
    endPosition: 1000,
    startContentPosition: 0,
    startContentPage: 1,
    endContentPosition: 1000,
    endContentPage: 2,
    totalNumPages: 2,
    totalNumContentPages: 2
  },
  toc: [
    { label: 'Chapter One', positionId: 0, page: 1, depth: 0 },
    { label: 'Back Matter', positionId: 1, location: 9999, depth: 0 }
  ],
  pages: [{ index: 0, page: 1, screenshot: 'pages/c000000.png' }],
  locationMap: { locations: [], navigationUnit: [] }
}

describe('renderBookPdf', () => {
  test('renders a valid, nonempty PDF and embeds the exact crop asset path', async () => {
    const outDir = await createOutDir()
    const outputPath = path.join(outDir, 'book.pdf')
    const source = sourceFor('c000000', 1)
    const document = bookDocumentFor(source)

    const capturedImagePaths: unknown[] = []
    const imageSpy = vi
      .spyOn(PDFDocument.prototype, 'image')
      .mockImplementation(function (
        this: PDFKit.PDFDocument,
        src: unknown
      ): PDFKit.PDFDocument {
        capturedImagePaths.push(src)
        return this
      })

    await renderBookPdf({
      document,
      metadata,
      allowPartial: false,
      outputPath,
      outDir
    })

    expect(imageSpy).toHaveBeenCalledTimes(1)
    expect(capturedImagePaths).toEqual([
      path.resolve(outDir, 'assets/c000000/b0002.png')
    ])

    const bytes = await fs.readFile(outputPath)
    expect(bytes.length).toBeGreaterThan(200)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  test('rejects a partial document unless allowPartial is set', async () => {
    const outDir = await createOutDir()
    const outputPath = path.join(outDir, 'book.pdf')
    const source = sourceFor('c000000', 1)
    const document: BookDocument = {
      ...bookDocumentFor(source),
      status: 'partial'
    }

    await expect(
      renderBookPdf({
        document,
        metadata,
        allowPartial: false,
        outputPath,
        outDir
      })
    ).rejects.toThrow(
      'Book processing is partial; set ALLOW_PARTIAL=true to export visible gaps'
    )
  })
})
