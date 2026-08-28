import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type {
  AvailablePageSource,
  FailedPageCheckpoint,
  ProcessorIdentity,
  SucceededPageCheckpoint,
  UnavailablePageSource
} from '../../src/book-processing/types'
import type { BookMetadata } from '../../src/types'
import {
  assembleBookDocument,
  writeBookDocument
} from '../../src/book-processing/assemble-book'
import { createPageCacheKey } from '../../src/book-processing/processor-identity'

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
    path.join(os.tmpdir(), 'kindle-assemble-book-')
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

const metadata: BookMetadata = {
  meta: {
    ACR: 'acr',
    asin: 'TESTASIN',
    authorList: ['Author One'],
    bookSize: '1',
    bookType: 'ebook',
    cover: 'cover.jpg',
    language: 'en',
    positions: { cover: 0, srl: 0, toc: 0 },
    publisher: 'Publisher',
    refEmId: 'ref',
    releaseDate: '2026-01-01',
    sample: false,
    title: 'Test Book',
    version: 'edition-1',
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
    endContentPage: 10,
    totalNumPages: 10,
    totalNumContentPages: 10
  },
  toc: [],
  pages: [],
  locationMap: { locations: [], navigationUnit: [] }
}

function captureIdFor(index: number): string {
  return `c${String(index).padStart(6, '0')}`
}

function indexForCaptureId(captureId: string): number {
  return Number.parseInt(captureId.slice(1), 10)
}

function availableSource(captureId: string): AvailablePageSource {
  const index = indexForCaptureId(captureId)
  return {
    captureId,
    index,
    printedPage: index + 1,
    position: null,
    screenshotPath: `pages/${captureId}.png`,
    rendererBatch: null,
    availability: 'available',
    screenshotSha256: String(index).padStart(64, '0'),
    width: 100,
    height: 50
  }
}

function unavailableSource(captureId: string): UnavailablePageSource {
  const index = indexForCaptureId(captureId)
  return {
    captureId,
    index,
    printedPage: index + 1,
    position: null,
    screenshotPath: `pages/${captureId}.unavailable.png`,
    rendererBatch: null,
    availability: 'unavailable',
    screenshotSha256: null,
    width: null,
    height: null,
    sourceFailure: {
      category: 'source',
      code: 'screenshot-unreadable',
      message: `Screenshot for ${captureId} could not be read`,
      attempts: 1,
      occurredAt: '2026-08-27T00:00:00.000Z',
      exitCode: null,
      signal: null
    }
  }
}

const threeSources: AvailablePageSource[] = [
  availableSource(captureIdFor(0)),
  availableSource(captureIdFor(1)),
  availableSource(captureIdFor(2))
]

function successFor(source: AvailablePageSource): SucceededPageCheckpoint {
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
      pageCacheKey: createPageCacheKey(source, processor),
      runId: 'run-1',
      batchId: 'batch-1',
      attempts: 1,
      completedAt: '2026-08-27T00:00:01.000Z'
    },
    document: { source, blocks: [], warnings: [] }
  }
}

function failureFor(
  source: AvailablePageSource | UnavailablePageSource
): FailedPageCheckpoint {
  return {
    status: 'failed',
    source,
    provenance: {
      runnerKind: 'codex-cli',
      codexCliVersion: processor.codexCliVersion,
      requestedModel: processor.requestedModel,
      promptVersion: processor.promptVersion,
      outputSchemaVersion: processor.outputSchemaVersion,
      normalizerVersion: processor.normalizerVersion,
      configurationHash: processor.configurationHash,
      pageCacheKey: '',
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
}

/** Mirrors the scheduler's own conversion of an unavailable source's
 * recorded `sourceFailure` directly into a failed checkpoint. */
function sourceFailureFor(source: UnavailablePageSource): FailedPageCheckpoint {
  return {
    status: 'failed',
    source,
    provenance: {
      runnerKind: 'codex-cli',
      codexCliVersion: processor.codexCliVersion,
      requestedModel: processor.requestedModel,
      promptVersion: processor.promptVersion,
      outputSchemaVersion: processor.outputSchemaVersion,
      normalizerVersion: processor.normalizerVersion,
      configurationHash: processor.configurationHash,
      pageCacheKey: '',
      runId: 'run-1',
      batchId: 'source-unavailable',
      attempts: source.sourceFailure.attempts,
      completedAt: '2026-08-27T00:00:01.000Z'
    },
    failure: source.sourceFailure
  }
}

describe('assembleBookDocument', () => {
  test('assembles a complete book when every source succeeds', () => {
    const document = assembleBookDocument({
      metadata,
      sources: threeSources,
      checkpoints: threeSources.map((source) => successFor(source)),
      runStatus: 'complete',
      processor
    })

    expect(document.schemaVersion).toBe('1')
    expect(document.status).toBe('complete')
    expect(document.counts).toEqual({
      expected: 3,
      captured: 3,
      succeeded: 3,
      failed: 0,
      pending: 0
    })
    expect(document.pages.map((page) => page.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded'
    ])
    expect(document.pages.map((page) => page.source.captureId)).toEqual(
      threeSources.map((source) => source.captureId)
    )
  })

  test('assembles a partial book without dropping expected pages', () => {
    const document = assembleBookDocument({
      metadata,
      sources: threeSources,
      checkpoints: [successFor(threeSources[0]!), failureFor(threeSources[1]!)],
      runStatus: 'failed',
      processor
    })
    expect(document.status).toBe('partial')
    expect(document.counts).toEqual({
      expected: 3,
      captured: 3,
      succeeded: 1,
      failed: 1,
      pending: 1
    })
    expect(document.pages.map((page) => page.status)).toEqual([
      'succeeded',
      'failed',
      'pending'
    ])
  })

  test('reports failed when a run ends with zero successes', () => {
    const document = assembleBookDocument({
      metadata,
      sources: threeSources,
      checkpoints: [failureFor(threeSources[0]!)],
      runStatus: 'failed',
      processor
    })
    expect(document.status).toBe('failed')
    expect(document.counts).toEqual({
      expected: 3,
      captured: 3,
      succeeded: 0,
      failed: 1,
      pending: 2
    })
  })

  test('counts unavailable evidence as expected but not captured', () => {
    const sources = [availableSource('c000000'), unavailableSource('c000001')]
    const document = assembleBookDocument({
      metadata,
      sources,
      checkpoints: [
        successFor(sources[0] as AvailablePageSource),
        sourceFailureFor(sources[1] as UnavailablePageSource)
      ],
      runStatus: 'failed',
      processor
    })
    expect(document.counts).toEqual({
      expected: 2,
      captured: 1,
      succeeded: 1,
      failed: 1,
      pending: 0
    })
    expect(document.pages.map((page) => page.status)).toEqual([
      'succeeded',
      'failed'
    ])
  })

  test('marks every unfinished page cancelled when the operator aborts', () => {
    const document = assembleBookDocument({
      metadata,
      sources: threeSources,
      checkpoints: [successFor(threeSources[0]!)],
      runStatus: 'cancelled',
      processor
    })
    expect(document.status).toBe('cancelled')
    expect(document.pages.map((page) => page.status)).toEqual([
      'succeeded',
      'cancelled',
      'cancelled'
    ])
  })

  test('synthesized pending and cancelled records carry the source but no content', () => {
    const document = assembleBookDocument({
      metadata,
      sources: threeSources,
      checkpoints: [],
      runStatus: 'cancelled',
      processor
    })
    for (const page of document.pages) {
      expect(page.status).toBe('cancelled')
      expect(page).not.toHaveProperty('document')
      expect(page).not.toHaveProperty('failure')
      expect(page).toEqual({ status: 'cancelled', source: page.source })
    }
  })

  test('ignores a scheduler-synthesized pending record when the run was cancelled', () => {
    // Regression: ProcessingRunResult.records always pads uncheckpointed
    // sources with a `pending` record regardless of run status (the
    // scheduler intentionally leaves cancelled/pending disambiguation to
    // this assembler). Passing that padded record straight through must
    // still be re-derived as `cancelled`, not trusted as a real checkpoint.
    const document = assembleBookDocument({
      metadata,
      sources: threeSources,
      checkpoints: [
        successFor(threeSources[0]!),
        { status: 'pending', source: threeSources[1]! },
        { status: 'pending', source: threeSources[2]! }
      ],
      runStatus: 'cancelled',
      processor
    })
    expect(document.status).toBe('cancelled')
    expect(document.pages.map((page) => page.status)).toEqual([
      'succeeded',
      'cancelled',
      'cancelled'
    ])
  })

  test('preserves inventory order regardless of checkpoint array order', () => {
    const document = assembleBookDocument({
      metadata,
      sources: threeSources,
      checkpoints: [failureFor(threeSources[2]!), successFor(threeSources[0]!)],
      runStatus: 'partial',
      processor
    })
    expect(document.pages.map((page) => page.source.captureId)).toEqual([
      'c000000',
      'c000001',
      'c000002'
    ])
    expect(document.pages.map((page) => page.status)).toEqual([
      'succeeded',
      'pending',
      'failed'
    ])
  })
})

describe('writeBookDocument', () => {
  test('writes the canonical document as private atomic JSON', async () => {
    const outDir = await createOutDir()
    const document = assembleBookDocument({
      metadata,
      sources: threeSources,
      checkpoints: threeSources.map((source) => successFor(source)),
      runStatus: 'complete',
      processor
    })

    await writeBookDocument(outDir, document)

    const filePath = path.join(outDir, 'book-document.json')
    const contents = await fs.readFile(filePath, 'utf8')
    expect(JSON.parse(contents)).toEqual(document)
    const stat = await fs.stat(filePath)
    expect(stat.mode & 0o777).toBe(0o600)
  })
})
