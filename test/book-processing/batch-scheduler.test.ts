import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import type { CheckpointStore } from '../../src/book-processing/checkpoint-store'
import type {
  AvailablePageSource,
  NormalizedPageDocument,
  PageCheckpoint,
  PageSource,
  ProcessingFailureCategory,
  ProcessingState,
  ProcessorIdentity,
  SucceededPageCheckpoint,
  UnavailablePageSource
} from '../../src/book-processing/types'
import {
  processPageSources,
  type ProcessPageSourcesInput,
  type SchedulerBatchResult,
  type SchedulerRunBatch
} from '../../src/book-processing/batch-scheduler'
import {
  createProcessingStateStore,
  type ProcessingStateStore
} from '../../src/book-processing/processing-state'

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

function captureIdFor(index: number): string {
  return `c${String(index).padStart(6, '0')}`
}

const allEightIds = Array.from({ length: 8 }, (_, index) => captureIdFor(index))
const firstFourIds = allEightIds.slice(0, 4)
const lastFourIds = allEightIds.slice(4, 8)

function availableSource(index: number): AvailablePageSource {
  return {
    captureId: captureIdFor(index),
    index,
    printedPage: index + 1,
    position: null,
    screenshotPath: `pages/${String(index).padStart(4, '0')}.png`,
    rendererBatch: null,
    availability: 'available',
    screenshotSha256: String(index).padStart(64, '0'),
    width: 100,
    height: 50
  }
}

function unavailableSource(index: number): UnavailablePageSource {
  return {
    captureId: captureIdFor(index),
    index,
    printedPage: index + 1,
    position: null,
    screenshotPath: `pages/${captureIdFor(index)}.unavailable.png`,
    rendererBatch: null,
    availability: 'unavailable',
    screenshotSha256: null,
    width: null,
    height: null,
    sourceFailure: {
      category: 'source',
      code: 'screenshot-unreadable',
      message: `Screenshot for ${captureIdFor(index)} could not be read`,
      attempts: 1,
      occurredAt: '2026-08-27T00:00:00.000Z',
      exitCode: null,
      signal: null
    }
  }
}

function successfulRawBatch(ids: readonly string[]): SchedulerBatchResult {
  return {
    ok: true,
    output: {
      schemaVersion: '1',
      pages: ids.map((id) => ({ pageId: id, blocks: [], warnings: [] }))
    }
  }
}

function failureResult(
  category: ProcessingFailureCategory
): SchedulerBatchResult {
  return {
    ok: false,
    failure: {
      category,
      code: category,
      message: `${category} failure`,
      attempts: 1,
      occurredAt: '2026-08-27T00:00:00.000Z',
      exitCode: null,
      signal: null
    }
  }
}

const protocolFailure = (): SchedulerBatchResult => failureResult('protocol')
const timeoutFailure = (): SchedulerBatchResult => failureResult('timeout')
const transientFailure = (): SchedulerBatchResult =>
  failureResult('transient-service')

async function normalizePage({
  page,
  source
}: {
  page: { warnings: string[] }
  source: AvailablePageSource
}): Promise<NormalizedPageDocument> {
  return { source, blocks: [], warnings: page.warnings }
}

interface MemoryCheckpointStore extends CheckpointStore {
  writes: PageCheckpoint[]
}

function memoryStore(
  reusable: Record<string, SucceededPageCheckpoint> = {}
): MemoryCheckpointStore {
  const written = new Map<string, PageCheckpoint>()
  const writes: PageCheckpoint[] = []
  return {
    writes,
    async read(captureId) {
      return written.get(captureId)
    },
    async readReusable(source) {
      return reusable[source.captureId]
    },
    async write(checkpoint) {
      writes.push(checkpoint)
      written.set(checkpoint.source.captureId, checkpoint)
    },
    async removeStaleTemps() {
      /* no-op for the in-memory store */
    }
  }
}

interface MemoryStateStore extends ProcessingStateStore {
  writes: ProcessingState[]
}

function memoryStateStore(): MemoryStateStore {
  const writes: ProcessingState[] = []
  return {
    writes,
    async read() {
      return writes.at(-1)
    },
    async write(state) {
      writes.push(structuredClone(state))
    }
  }
}

interface Overrides {
  sources?: PageSource[]
  runBatch?: SchedulerRunBatch
  store?: MemoryCheckpointStore
  stateStore?: ProcessingStateStore
  batchSize?: number
  concurrency?: number
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

function schedulerInput(overrides: Overrides = {}): ProcessPageSourcesInput {
  const sources =
    overrides.sources ??
    Array.from({ length: 8 }, (_, index) => availableSource(index))
  return {
    runId: 'run-1',
    sources,
    processor,
    asin: 'TESTASIN',
    editionVersion: 'edition-1',
    outDir: '/tmp/kindle-scheduler-test',
    config: {
      batchSize: overrides.batchSize ?? 8,
      concurrency: overrides.concurrency ?? 1
    },
    store: overrides.store ?? memoryStore(),
    stateStore: overrides.stateStore ?? memoryStateStore(),
    runBatch: overrides.runBatch ?? (async (ids) => successfulRawBatch(ids)),
    normalizePage,
    sleep: overrides.sleep ?? (async () => {}),
    now: () => '2026-08-27T00:00:00.000Z',
    jitter: () => 0,
    signal: overrides.signal
  }
}

describe('processPageSources', () => {
  test('checkpoints an eight-page batch on the first attempt', async () => {
    const calls: string[][] = []
    const store = memoryStore()
    const result = await processPageSources(
      schedulerInput({
        store,
        runBatch: async (ids) => {
          calls.push(ids)
          return successfulRawBatch(ids)
        }
      })
    )

    expect(calls).toEqual([allEightIds])
    expect(result.status).toBe('complete')
    expect(result.records.map((record) => record.status)).toEqual(
      Array.from({ length: 8 }, () => 'succeeded')
    )
    expect(result.counts).toEqual({
      expected: 8,
      captured: 8,
      succeeded: 8,
      failed: 0,
      pending: 0
    })
    expect(store.writes).toHaveLength(8)
  })

  test('skips pages that already have a reusable checkpoint', async () => {
    const cached: SucceededPageCheckpoint = {
      status: 'succeeded',
      source: availableSource(0),
      provenance: {
        runnerKind: 'codex-cli',
        codexCliVersion: processor.codexCliVersion,
        requestedModel: processor.requestedModel,
        promptVersion: processor.promptVersion,
        outputSchemaVersion: processor.outputSchemaVersion,
        normalizerVersion: processor.normalizerVersion,
        configurationHash: processor.configurationHash,
        pageCacheKey: 'cached',
        runId: 'previous',
        batchId: 'b1',
        attempts: 1,
        completedAt: '2026-08-26T00:00:00.000Z'
      },
      document: { source: availableSource(0), blocks: [], warnings: [] }
    }
    const calls: string[][] = []
    const result = await processPageSources(
      schedulerInput({
        sources: [availableSource(0), availableSource(1)],
        store: memoryStore({ c000000: cached }),
        runBatch: async (ids) => {
          calls.push(ids)
          return successfulRawBatch(ids)
        }
      })
    )

    expect(calls).toEqual([['c000001']])
    expect(result.status).toBe('complete')
    expect(result.records[0]).toBe(cached)
  })

  test('splits an invalid batch recursively while preserving order', async () => {
    const calls: string[][] = []
    const result = await processPageSources(
      schedulerInput({
        runBatch: async (ids) => {
          calls.push(ids)
          if (ids.includes('c000005') && ids.length > 1)
            return protocolFailure()
          if (ids[0] === 'c000005') return successfulRawBatch(ids)
          return successfulRawBatch(ids)
        }
      })
    )
    expect(calls).toEqual([
      allEightIds,
      allEightIds,
      firstFourIds,
      lastFourIds,
      lastFourIds,
      ['c000004', 'c000005'],
      ['c000004', 'c000005'],
      ['c000004'],
      ['c000005'],
      // The right sibling of [4..7]. The plan's snippet omitted this call,
      // but the pseudocode and design ("each half follows the same rule")
      // both process it, so a faithful scheduler must invoke it.
      ['c000006', 'c000007']
    ])
    expect(result.records.map((record) => record.source.captureId)).toEqual(
      allEightIds
    )
    expect(
      result.records.every((record) => record.status === 'succeeded')
    ).toBe(true)
  })

  test('checkpoints a single page that fails twice as a failed page', async () => {
    const calls: string[][] = []
    const store = memoryStore()
    const result = await processPageSources(
      schedulerInput({
        sources: [availableSource(0), availableSource(1)],
        batchSize: 2,
        store,
        runBatch: async (ids) => {
          calls.push(ids)
          if (ids.includes('c000001')) return protocolFailure()
          return successfulRawBatch(ids)
        }
      })
    )

    expect(calls).toEqual([
      ['c000000', 'c000001'],
      ['c000000', 'c000001'],
      ['c000000'],
      ['c000001'],
      ['c000001']
    ])
    expect(result.status).toBe('partial')
    expect(result.counts).toMatchObject({ succeeded: 1, failed: 1, pending: 0 })
    const failed = result.records[1]!
    expect(failed.status).toBe('failed')
    if (failed.status === 'failed') {
      expect(failed.failure.category).toBe('protocol')
      expect(failed.failure.attempts).toBe(2)
    }
  })

  test('retries a timeout then splits into ordered halves', async () => {
    const calls: string[][] = []
    const sleeps: number[] = []
    const result = await processPageSources(
      schedulerInput({
        sources: Array.from({ length: 4 }, (_, index) =>
          availableSource(index)
        ),
        batchSize: 4,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        runBatch: async (ids) => {
          calls.push(ids)
          if (ids.includes('c000001') && ids.length > 1) return timeoutFailure()
          return successfulRawBatch(ids)
        }
      })
    )

    expect(calls).toEqual([
      ['c000000', 'c000001', 'c000002', 'c000003'],
      ['c000000', 'c000001', 'c000002', 'c000003'],
      ['c000000', 'c000001'],
      ['c000000', 'c000001'],
      ['c000000'],
      ['c000001'],
      ['c000002', 'c000003']
    ])
    expect(sleeps).toEqual([])
    expect(result.status).toBe('complete')
  })

  test('aborts the whole run after three transient-service attempts', async () => {
    const calls: string[][] = []
    const sleeps: number[] = []
    const stateStore = memoryStateStore()
    const result = await processPageSources(
      schedulerInput({
        stateStore,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        runBatch: async (ids) => {
          calls.push(ids)
          return transientFailure()
        }
      })
    )

    expect(calls).toEqual([allEightIds, allEightIds, allEightIds])
    expect(sleeps).toEqual([2000, 4000])
    expect(result.status).toBe('failed')
    expect(result.failure?.category).toBe('transient-service')
    expect(result.records.every((record) => record.status === 'pending')).toBe(
      true
    )
    expect(result.counts).toMatchObject({ succeeded: 0, failed: 0, pending: 8 })
    expect(stateStore.writes.at(-1)).toMatchObject({ status: 'failed' })
  })

  test('checkpoints an unavailable page immediately without calling Codex', async () => {
    const calls: string[][] = []
    const store = memoryStore()
    const result = await processPageSources(
      schedulerInput({
        sources: [availableSource(0), unavailableSource(1), availableSource(2)],
        store,
        runBatch: async (ids) => {
          calls.push(ids)
          return successfulRawBatch(ids)
        }
      })
    )

    expect(calls).toEqual([['c000000', 'c000002']])
    expect(result.records.map((record) => record.status)).toEqual([
      'succeeded',
      'failed',
      'succeeded'
    ])
    const unavailable = result.records[1]!
    expect(unavailable.status).toBe('failed')
    if (unavailable.status === 'failed') {
      expect(unavailable.failure.category).toBe('source')
    }
    expect(result.status).toBe('partial')
    expect(
      store.writes.some((write) => write.source.captureId === 'c000001')
    ).toBe(true)
  })

  test('cancels remaining batches while preserving completed checkpoints', async () => {
    const calls: string[][] = []
    const controller = new AbortController()
    const stateStore = memoryStateStore()
    const store = memoryStore()
    const result = await processPageSources(
      schedulerInput({
        sources: Array.from({ length: 8 }, (_, index) =>
          availableSource(index)
        ),
        batchSize: 4,
        store,
        stateStore,
        signal: controller.signal,
        runBatch: async (ids) => {
          calls.push(ids)
          if (ids[0] === 'c000000') {
            controller.abort()
            return successfulRawBatch(ids)
          }
          return successfulRawBatch(ids)
        }
      })
    )

    expect(calls).toEqual([firstFourIds])
    expect(result.status).toBe('cancelled')
    expect(
      result.records
        .filter((record) => record.status === 'succeeded')
        .map((record) => record.source.captureId)
    ).toEqual(firstFourIds)
    expect(
      result.records.filter((record) => record.status === 'pending')
    ).toHaveLength(4)
    expect(store.writes).toHaveLength(4)
    expect(stateStore.writes.at(-1)).toMatchObject({
      status: 'cancelled',
      counts: { succeeded: 4, pending: 4 }
    })
  })

  test('persists the real processing-state store across a run', async () => {
    const outDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'kindle-scheduler-state-')
    )
    try {
      const stateStore = await createProcessingStateStore(outDir)
      const result = await processPageSources(
        schedulerInput({ sources: [availableSource(0)], stateStore })
      )
      expect(result.status).toBe('complete')
      await expect(stateStore.read()).resolves.toMatchObject({
        runId: 'run-1',
        status: 'complete',
        counts: { succeeded: 1 }
      })
    } finally {
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })
})
