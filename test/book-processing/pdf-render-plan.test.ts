import { describe, expect, test } from 'vitest'

import type {
  AvailablePageSource,
  BookDocument,
  BookPageRecord,
  Citation,
  NormalizedBlock,
  ProcessingProvenance,
  ProcessorIdentity,
  RawBlockKind,
  RawTextRun,
  SucceededPageCheckpoint
} from '../../src/book-processing/types'
import type { BookMetadata } from '../../src/types'
import { createPdfRenderPlan } from '../../src/book-processing/pdf-render-plan'

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

function provenanceFor(attempts = 1): ProcessingProvenance {
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
    attempts,
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

function bookDocumentFor(
  pages: BookPageRecord[],
  status: BookDocument['status']
): BookDocument {
  const succeeded = pages.filter((page) => page.status === 'succeeded').length
  const failed = pages.filter((page) => page.status === 'failed').length
  return {
    schemaVersion: '1',
    book: {
      asin: 'TESTASIN',
      editionVersion: 'edition000001',
      title: 'Synthetic Book',
      authors: ['Test Author']
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

/** Builds a minimal single-run paragraph block for the ordering test, which
 * only cares about which page/block each item traces back to. */
function paragraphBlockFor(
  citationId: string,
  source: AvailablePageSource,
  text: string
): NormalizedBlock {
  return {
    order: 0,
    kind: 'paragraph',
    runs: [{ text, styles: [] }],
    alignment: 'left',
    indentLevel: 0,
    headingLevel: null,
    region: null,
    regionConfidence: 'unknown',
    mediaDescription: null,
    caption: null,
    blockId: 'b0000',
    text,
    citation: citationFor(citationId, source, 0, 'paragraph'),
    mediaAsset: null
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

describe('createPdfRenderPlan', () => {
  test('creates ordered PDF instructions with source citations', () => {
    const source = sourceFor('c000000', 1)

    const citation0 =
      'knd:TESTASIN:edition000001:source000001:process00001:b0000'
    const citation1 =
      'knd:TESTASIN:edition000001:source000001:process00001:b0001'
    const citation2 =
      'knd:TESTASIN:edition000001:source000001:process00001:b0002'

    const syntheticRuns: RawTextRun[] = [
      { text: 'Body ', styles: [] },
      { text: 'text', styles: ['bold'] },
      { text: '.', styles: [] }
    ]

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
      citation: citationFor(citation0, source, 0, 'heading'),
      mediaAsset: null
    }

    const paragraphBlock: NormalizedBlock = {
      order: 1,
      kind: 'paragraph',
      runs: syntheticRuns,
      alignment: 'left',
      indentLevel: 0,
      headingLevel: null,
      region: null,
      regionConfidence: 'unknown',
      mediaDescription: null,
      caption: null,
      blockId: 'b0001',
      text: 'Body text.',
      citation: citationFor(citation1, source, 1, 'paragraph'),
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
      citation: citationFor(citation2, source, 2, 'image'),
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
    const completeBook = bookDocumentFor([page], 'complete')

    const plan = createPdfRenderPlan({
      document: completeBook,
      metadata,
      allowPartial: false
    })

    expect(plan.items).toEqual([
      { kind: 'title', text: 'Synthetic Book', authors: ['Test Author'] },
      { kind: 'heading', level: 1, text: 'Chapter One', citationId: citation0 },
      { kind: 'paragraph', runs: syntheticRuns, citationId: citation1 },
      {
        kind: 'image',
        path: 'assets/c000000/b0002.png',
        caption: 'Synthetic diagram',
        citationId: citation2
      }
    ])
  })

  test('carries the book title and authors into the PDFKit document info', () => {
    const source = sourceFor('c000001', 1)
    const page = succeededPageFor(source, [])
    const document = bookDocumentFor([page], 'complete')

    const plan = createPdfRenderPlan({
      document,
      metadata,
      allowPartial: false
    })

    expect(plan.info).toEqual({
      Title: 'Synthetic Book',
      Author: 'Test Author'
    })
  })

  test('drops page-number blocks, matching the Markdown exporter', () => {
    const source = sourceFor('c000002', 1)
    const pageNumberBlock: NormalizedBlock = {
      order: 0,
      kind: 'page-number',
      runs: [{ text: '1', styles: [] }],
      alignment: 'center',
      indentLevel: 0,
      headingLevel: null,
      region: null,
      regionConfidence: 'unknown',
      mediaDescription: null,
      caption: null,
      blockId: 'b0000',
      text: '1',
      citation: citationFor('citation-c000002-0', source, 0, 'page-number'),
      mediaAsset: null
    }
    const page = succeededPageFor(source, [pageNumberBlock])
    const document = bookDocumentFor([page], 'complete')

    const plan = createPdfRenderPlan({
      document,
      metadata,
      allowPartial: false
    })

    expect(plan.items).toEqual([
      { kind: 'title', text: 'Synthetic Book', authors: ['Test Author'] }
    ])
  })

  test('renders an image block with no crop asset as a null path, never inventing one', () => {
    const source = sourceFor('c000003', 1)
    const imageBlock: NormalizedBlock = {
      order: 0,
      kind: 'image',
      runs: [],
      alignment: 'left',
      indentLevel: 0,
      headingLevel: null,
      region: null,
      regionConfidence: 'unknown',
      mediaDescription: 'A hand-drawn sketch of a castle.',
      caption: null,
      blockId: 'b0000',
      text: '',
      citation: citationFor('citation-c000003-0', source, 0, 'image'),
      mediaAsset: null
    }
    const page = succeededPageFor(source, [imageBlock])
    const document = bookDocumentFor([page], 'complete')

    const plan = createPdfRenderPlan({
      document,
      metadata,
      allowPartial: false
    })

    expect(plan.items).toEqual([
      { kind: 'title', text: 'Synthetic Book', authors: ['Test Author'] },
      {
        kind: 'image',
        path: null,
        caption: null,
        citationId: 'citation-c000003-0'
      }
    ])
  })

  test('rejects partial books unless visible gaps are enabled', () => {
    const succeededPage = succeededPageFor(sourceFor('c000000', 1), [])
    const failedPage: BookPageRecord = {
      status: 'failed',
      source: sourceFor('c000001', 2),
      provenance: provenanceFor(2),
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
    const partialBook = bookDocumentFor([succeededPage, failedPage], 'partial')

    expect(() =>
      createPdfRenderPlan({
        document: partialBook,
        metadata,
        allowPartial: false
      })
    ).toThrow(
      'Book processing is partial; set ALLOW_PARTIAL=true to export visible gaps'
    )
  })

  test('renders failed, pending, and cancelled pages as gap items when allowed, never inventing replacement text', () => {
    const succeededPage = succeededPageFor(sourceFor('c000020', 10), [])
    const failedPage: BookPageRecord = {
      status: 'failed',
      source: sourceFor('c000021', 11),
      provenance: provenanceFor(2),
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
    const pendingPage: BookPageRecord = {
      status: 'pending',
      source: sourceFor('c000022', 12)
    }
    const cancelledPage: BookPageRecord = {
      status: 'cancelled',
      source: sourceFor('c000023', null)
    }

    const partialBook = bookDocumentFor(
      [succeededPage, failedPage, pendingPage, cancelledPage],
      'partial'
    )

    const plan = createPdfRenderPlan({
      document: partialBook,
      metadata,
      allowPartial: true
    })

    expect(plan.items).toEqual([
      { kind: 'title', text: 'Synthetic Book', authors: ['Test Author'] },
      {
        kind: 'gap',
        captureId: 'c000021',
        printedPage: 11,
        status: 'failed'
      },
      {
        kind: 'gap',
        captureId: 'c000022',
        printedPage: 12,
        status: 'pending'
      },
      {
        kind: 'gap',
        captureId: 'c000023',
        printedPage: null,
        status: 'cancelled'
      }
    ])
  })

  test('preserves page order and block order exactly across multiple pages, without sorting', () => {
    const source1 = sourceFor('c000050', 1)
    const source2 = sourceFor('c000051', 2)

    const page1 = succeededPageFor(source1, [
      paragraphBlockFor('citation-c000050-0', source1, 'First page body.')
    ])
    const page2 = succeededPageFor(source2, [
      paragraphBlockFor('citation-c000051-0', source2, 'Second page body.')
    ])
    const document = bookDocumentFor([page1, page2], 'complete')

    const plan = createPdfRenderPlan({
      document,
      metadata,
      allowPartial: false
    })

    expect(plan.items).toEqual([
      { kind: 'title', text: 'Synthetic Book', authors: ['Test Author'] },
      {
        kind: 'paragraph',
        runs: [{ text: 'First page body.', styles: [] }],
        citationId: 'citation-c000050-0'
      },
      {
        kind: 'paragraph',
        runs: [{ text: 'Second page body.', styles: [] }],
        citationId: 'citation-c000051-0'
      }
    ])
  })
})
