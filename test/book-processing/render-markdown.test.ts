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
  SucceededPageCheckpoint
} from '../../src/book-processing/types'
import type { BookMetadata } from '../../src/types'
import { renderBookMarkdown } from '../../src/book-processing/render-markdown'

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

/** Builds a minimal single-run paragraph block for chapter-boundary tests
 * that only care about which pages' text ends up under which heading. */
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

/**
 * Two TOC entries where only the second lacks a `page` (it is keyed by
 * `location` instead, as Kindle back-matter bookmarks often are). This
 * mirrors the legacy exporter's chapter-boundary loop, which always treats
 * its final TOC entry as a sentinel rather than a rendered chapter: with a
 * sentinel `page` of `undefined`, "Chapter One" extends to the end of the
 * document, so every synthetic test below can share one fixture regardless
 * of how many pages/printed-page numbers it uses.
 */
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

describe('renderBookMarkdown', () => {
  test('renders semantic blocks, assets, and machine-readable citations', () => {
    const source = sourceFor('c000000', 1)

    const emphasisBlock: NormalizedBlock = {
      order: 0,
      kind: 'heading',
      runs: [
        { text: 'Synthetic', styles: ['bold'] },
        { text: ' heading', styles: [] }
      ],
      alignment: 'left',
      indentLevel: 0,
      headingLevel: 2,
      region: null,
      regionConfidence: 'unknown',
      mediaDescription: null,
      caption: null,
      blockId: 'b0000',
      text: 'Synthetic heading',
      citation: citationFor(
        'knd:TESTASIN:edition000001:source000001:process00001:b0000',
        source,
        0,
        'heading'
      ),
      mediaAsset: null
    }

    // A page-number block sits between the two rendered blocks. It is
    // deliberately excluded from output (no text, no citation comment),
    // which is why the citation ids below jump from b0000 to b0002.
    const pageNumberBlock: NormalizedBlock = {
      order: 1,
      kind: 'page-number',
      runs: [{ text: '1', styles: [] }],
      alignment: 'center',
      indentLevel: 0,
      headingLevel: null,
      region: null,
      regionConfidence: 'unknown',
      mediaDescription: null,
      caption: null,
      blockId: 'b0001',
      text: '1',
      citation: citationFor(
        'knd:TESTASIN:edition000001:source000001:process00001:b0001',
        source,
        1,
        'page-number'
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
      emphasisBlock,
      pageNumberBlock,
      imageBlock
    ])
    const completeBook = bookDocumentFor([page], 'complete')

    expect(
      renderBookMarkdown({
        document: completeBook,
        metadata,
        allowPartial: false
      })
    ).toMatchInlineSnapshot(`
"# Synthetic Book

> By Test Author

## Chapter One

**Synthetic** heading
<!-- kindle-citation: knd:TESTASIN:edition000001:source000001:process00001:b0000 -->

![Synthetic diagram](assets/c000000/b0002.png)
<!-- kindle-citation: knd:TESTASIN:edition000001:source000001:process00001:b0002 -->"
`)
  })

  test('renders a plain paragraph block using its run text', () => {
    const source = sourceFor('c000010', 5)
    const block: NormalizedBlock = {
      order: 0,
      kind: 'paragraph',
      runs: [{ text: 'Plain paragraph text.', styles: [] }],
      alignment: 'left',
      indentLevel: 0,
      headingLevel: null,
      region: null,
      regionConfidence: 'unknown',
      mediaDescription: null,
      caption: null,
      blockId: 'b0000',
      text: 'Plain paragraph text.',
      citation: citationFor('citation-c000010-0', source, 0, 'paragraph'),
      mediaAsset: null
    }
    const page = succeededPageFor(source, [block])
    const document = bookDocumentFor([page], 'complete')

    const markdown = renderBookMarkdown({
      document,
      metadata,
      allowPartial: false
    })

    expect(markdown).toContain(
      'Plain paragraph text\\.\n<!-- kindle-citation: citation-c000010-0 -->'
    )
  })

  test('renders a combined bold+italic run with deterministic nesting', () => {
    const source = sourceFor('c000013', 8)
    const block: NormalizedBlock = {
      order: 0,
      kind: 'paragraph',
      runs: [{ text: 'strong emphasis', styles: ['bold', 'italic'] }],
      alignment: 'left',
      indentLevel: 0,
      headingLevel: null,
      region: null,
      regionConfidence: 'unknown',
      mediaDescription: null,
      caption: null,
      blockId: 'b0000',
      text: 'strong emphasis',
      citation: citationFor('citation-c000013-0', source, 0, 'paragraph'),
      mediaAsset: null
    }
    const page = succeededPageFor(source, [block])
    const document = bookDocumentFor([page], 'complete')

    const markdown = renderBookMarkdown({
      document,
      metadata,
      allowPartial: false
    })

    expect(markdown).toContain('**_strong emphasis_**')
  })

  test('renders media description with a source-page link when no crop asset exists', () => {
    const source = sourceFor('c000011', 6)
    const block: NormalizedBlock = {
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
      citation: citationFor('citation-c000011-0', source, 0, 'image'),
      mediaAsset: null
    }
    const page = succeededPageFor(source, [block])
    const document = bookDocumentFor([page], 'complete')

    const markdown = renderBookMarkdown({
      document,
      metadata,
      allowPartial: false
    })

    expect(markdown).toContain(
      'A hand\\-drawn sketch of a castle\\. [View source page](pages/c000011.png)\n<!-- kindle-citation: citation-c000011-0 -->'
    )
  })

  test('renders only the source-page link when no crop, description, or caption exists, without inventing an "Image" placeholder', () => {
    const source = sourceFor('c000014', 9)
    const block: NormalizedBlock = {
      order: 0,
      kind: 'image',
      runs: [],
      alignment: 'left',
      indentLevel: 0,
      headingLevel: null,
      region: null,
      regionConfidence: 'unknown',
      mediaDescription: null,
      caption: null,
      blockId: 'b0000',
      text: '',
      citation: citationFor('citation-c000014-0', source, 0, 'image'),
      mediaAsset: null
    }
    const page = succeededPageFor(source, [block])
    const document = bookDocumentFor([page], 'complete')

    const markdown = renderBookMarkdown({
      document,
      metadata,
      allowPartial: false
    })

    expect(markdown).toContain(
      '[View source page](pages/c000014.png)\n<!-- kindle-citation: citation-c000014-0 -->'
    )
    expect(markdown).not.toMatch(/Image \[View source page\]/)
    expect(markdown).not.toContain('Image')
  })

  test('escapes markdown metacharacters in run text and image alt text', () => {
    const source = sourceFor('c000012', 7)
    const textBlock: NormalizedBlock = {
      order: 0,
      kind: 'paragraph',
      runs: [{ text: 'Use *bold* or [brackets] carefully.', styles: [] }],
      alignment: 'left',
      indentLevel: 0,
      headingLevel: null,
      region: null,
      regionConfidence: 'unknown',
      mediaDescription: null,
      caption: null,
      blockId: 'b0000',
      text: 'Use *bold* or [brackets] carefully.',
      citation: citationFor('citation-c000012-0', source, 0, 'paragraph'),
      mediaAsset: null
    }
    const imageBlock: NormalizedBlock = {
      order: 1,
      kind: 'image',
      runs: [],
      alignment: 'left',
      indentLevel: 0,
      headingLevel: null,
      region: { x: 0, y: 0, width: 500, height: 500 },
      regionConfidence: 'high',
      mediaDescription: null,
      caption: 'A [caption] with *stars*',
      blockId: 'b0001',
      text: '',
      citation: citationFor('citation-c000012-1', source, 1, 'image'),
      mediaAsset: {
        path: 'assets/c000012/b0001.png',
        mimeType: 'image/png',
        width: 500,
        height: 500,
        sha256: 'e'.repeat(64),
        sourceScreenshotSha256: source.screenshotSha256,
        pixelCrop: { left: 0, top: 0, width: 500, height: 500 },
        derivation: 'page-crop'
      }
    }
    const page = succeededPageFor(source, [textBlock, imageBlock])
    const document = bookDocumentFor([page], 'complete')

    const markdown = renderBookMarkdown({
      document,
      metadata,
      allowPartial: false
    })

    expect(markdown).toContain('Use \\*bold\\* or \\[brackets\\] carefully\\.')
    expect(markdown).toContain(
      '![A \\[caption\\] with \\*stars\\*](assets/c000012/b0001.png)'
    )
  })

  test('rejects partial books unless visible gaps are enabled', () => {
    const succeededPage = succeededPageFor(sourceFor('c000000', 1), [
      {
        order: 0,
        kind: 'paragraph',
        runs: [{ text: 'Body text.', styles: [] }],
        alignment: 'left',
        indentLevel: 0,
        headingLevel: null,
        region: null,
        regionConfidence: 'unknown',
        mediaDescription: null,
        caption: null,
        blockId: 'b0000',
        text: 'Body text.',
        citation: citationFor(
          'citation-c000000-0',
          sourceFor('c000000', 1),
          0,
          'paragraph'
        ),
        mediaAsset: null
      }
    ])
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
    const pendingPage: BookPageRecord = {
      status: 'pending',
      source: sourceFor('c000002', 3)
    }
    const partialBook = bookDocumentFor(
      [succeededPage, failedPage, pendingPage],
      'partial'
    )

    expect(() =>
      renderBookMarkdown({
        document: partialBook,
        metadata,
        allowPartial: false
      })
    ).toThrow(
      'Book processing is partial; set ALLOW_PARTIAL=true to export visible gaps'
    )
  })

  test('renders failed, pending, and cancelled pages as blockquotes when allowed, never inventing replacement text', () => {
    const succeededSource = sourceFor('c000020', 10)
    const succeededPage = succeededPageFor(succeededSource, [
      {
        order: 0,
        kind: 'paragraph',
        runs: [{ text: 'Present body text.', styles: [] }],
        alignment: 'left',
        indentLevel: 0,
        headingLevel: null,
        region: null,
        regionConfidence: 'unknown',
        mediaDescription: null,
        caption: null,
        blockId: 'b0000',
        text: 'Present body text.',
        citation: citationFor(
          'citation-c000020-0',
          succeededSource,
          0,
          'paragraph'
        ),
        mediaAsset: null
      }
    ])
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
    // No printed page number is available for the cancelled source, so the
    // marker must omit it rather than inventing one.
    const cancelledPage: BookPageRecord = {
      status: 'cancelled',
      source: sourceFor('c000023', null)
    }

    const partialBook = bookDocumentFor(
      [succeededPage, failedPage, pendingPage, cancelledPage],
      'partial'
    )

    const markdown = renderBookMarkdown({
      document: partialBook,
      metadata,
      allowPartial: true
    })

    expect(markdown).toContain(
      '> Capture c000021 (printed page 11): processing failed'
    )
    expect(markdown).toContain(
      '> Capture c000022 (printed page 12): processing pending'
    )
    expect(markdown).toContain('> Capture c000023: processing cancelled')
    expect(markdown).not.toMatch(/Codex invocation timed out/)
  })

  test('does not reject an already-complete document even when allowPartial is false', () => {
    const source = sourceFor('c000030', 1)
    const page = succeededPageFor(source, [
      {
        order: 0,
        kind: 'paragraph',
        runs: [{ text: 'Body text.', styles: [] }],
        alignment: 'left',
        indentLevel: 0,
        headingLevel: null,
        region: null,
        regionConfidence: 'unknown',
        mediaDescription: null,
        caption: null,
        blockId: 'b0000',
        text: 'Body text.',
        citation: citationFor('citation-c000030-0', source, 0, 'paragraph'),
        mediaAsset: null
      }
    ])
    const document = bookDocumentFor([page], 'complete')

    expect(() =>
      renderBookMarkdown({ document, metadata, allowPartial: false })
    ).not.toThrow()
  })

  test('inserts a caller-supplied Table of Contents section between the byline and the chapters', () => {
    const source = sourceFor('c000040', 1)
    const page = succeededPageFor(source, [
      paragraphBlockFor('citation-c000040-0', source, 'Body text.')
    ])
    const document = bookDocumentFor([page], 'complete')

    const tocMarkdown = '## Table of Contents\n\n- [Chapter One](#chapter-one)'

    const markdown = renderBookMarkdown({
      document,
      metadata,
      allowPartial: false,
      tocMarkdown
    })

    expect(markdown).toBe(
      [
        '# Synthetic Book',
        '',
        '> By Test Author',
        '',
        '---',
        '',
        '## Table of Contents',
        '',
        '- [Chapter One](#chapter-one)',
        '',
        '---',
        '',
        '## Chapter One',
        '',
        'Body text\\.',
        '<!-- kindle-citation: citation-c000040-0 -->'
      ].join('\n')
    )
  })

  test('omitting tocMarkdown renders no Table of Contents section (default behavior)', () => {
    const source = sourceFor('c000041', 1)
    const page = succeededPageFor(source, [
      paragraphBlockFor('citation-c000041-0', source, 'Body text.')
    ])
    const document = bookDocumentFor([page], 'complete')

    const markdown = renderBookMarkdown({
      document,
      metadata,
      allowPartial: false
    })

    expect(markdown).not.toContain('Table of Contents')
    expect(markdown).not.toContain('---')
  })

  test('extends a chapter whose next-boundary page is never reached to the end of the book, instead of dropping it', () => {
    // Four TOC entries: three real chapters plus a location-only sentinel
    // last entry (never itself rendered - see the shared fixture's comment
    // above). "Chapter Two"'s own next boundary (page 100) is never reached
    // by any page's printed page number, so under the ported legacy loop it
    // would have been silently dropped; the current behavior instead extends
    // "Chapter Two" all the way to the end of the book, absorbing what would
    // have been "Chapter Three"'s content, and "Chapter Three" renders as an
    // empty heading.
    const multiChapterToc: BookMetadata['toc'] = [
      { label: 'Chapter One', positionId: 0, page: 1, depth: 0 },
      { label: 'Chapter Two', positionId: 1, page: 2, depth: 0 },
      { label: 'Chapter Three', positionId: 2, page: 100, depth: 0 },
      { label: 'Back Matter', positionId: 3, location: 9999, depth: 0 }
    ]
    const multiChapterMetadata: BookMetadata = {
      ...metadata,
      toc: multiChapterToc
    }

    const source1 = sourceFor('c000050', 1)
    const source2 = sourceFor('c000051', 2)
    const source3 = sourceFor('c000052', 3)

    const page1 = succeededPageFor(source1, [
      paragraphBlockFor('citation-c000050-0', source1, 'Chapter one body.')
    ])
    const page2 = succeededPageFor(source2, [
      paragraphBlockFor('citation-c000051-0', source2, 'Chapter two body.')
    ])
    const page3 = succeededPageFor(source3, [
      paragraphBlockFor(
        'citation-c000052-0',
        source3,
        'Chapter three body, absorbed by chapter two.'
      )
    ])
    const document = bookDocumentFor([page1, page2, page3], 'complete')

    const markdown = renderBookMarkdown({
      document,
      metadata: multiChapterMetadata,
      allowPartial: false
    })

    const chapterOneIndex = markdown.indexOf('## Chapter One')
    const chapterTwoIndex = markdown.indexOf('## Chapter Two')
    const chapterThreeIndex = markdown.indexOf('## Chapter Three')

    expect(chapterOneIndex).toBeGreaterThan(-1)
    expect(chapterTwoIndex).toBeGreaterThan(chapterOneIndex)
    expect(chapterThreeIndex).toBeGreaterThan(chapterTwoIndex)

    expect(markdown.slice(chapterOneIndex, chapterTwoIndex)).toContain(
      'Chapter one body\\.'
    )

    const chapterTwoSection = markdown.slice(chapterTwoIndex, chapterThreeIndex)
    expect(chapterTwoSection).toContain('Chapter two body\\.')
    expect(chapterTwoSection).toContain(
      'Chapter three body, absorbed by chapter two\\.'
    )

    // "Chapter Three" itself renders as a heading with no body content or
    // citations, since chapter Two's extension already consumed every page.
    const chapterThreeSection = markdown.slice(chapterThreeIndex)
    expect(chapterThreeSection).not.toContain('kindle-citation')
  })
})
