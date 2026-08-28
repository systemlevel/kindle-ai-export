import pMap from 'p-map'

import type { CheckpointStore } from './checkpoint-store'
import type { ProcessingStateStore } from './processing-state'
import type {
  AggregateCounts,
  AvailablePageSource,
  BookPageRecord,
  BookStatus,
  FailedPageCheckpoint,
  NormalizedPageDocument,
  PageCheckpoint,
  PageSource,
  ProcessingFailure,
  ProcessingFailureCategory,
  ProcessingProvenance,
  ProcessingRunStatus,
  ProcessorIdentity,
  RawCodexBatch,
  RawCodexPage,
  SucceededPageCheckpoint,
  UnavailablePageSource
} from './types'
import { createPageCacheKey } from './processor-identity'

/** Base backoff for the two transient-service retries, before jitter. */
const transientBackoffMs = [2000, 4000] as const
const maxTransientBackoffMs = 30_000

/** Minimal batch config the scheduler needs; {@link ProcessingConfig} is a
 * structural superset, so a full config can be passed directly. */
export interface SchedulerConfig {
  batchSize: number
  concurrency: number
}

export interface RunBatchContext {
  batchId: string
  attempt: number
  signal?: AbortSignal
}

/** Narrow result shape the scheduler consumes. A `CodexRunResult` (which also
 * carries an `execution` summary) is structurally assignable to this. */
export type SchedulerBatchResult =
  | { ok: true; output: RawCodexBatch }
  | { ok: false; failure: ProcessingFailure }

export type SchedulerRunBatch = (
  pageIds: string[],
  context: RunBatchContext
) => Promise<SchedulerBatchResult>

export type SchedulerNormalizePage = (input: {
  page: RawCodexPage
  source: AvailablePageSource
  processor: ProcessorIdentity
  asin: string
  editionVersion: string
  outDir: string
}) => Promise<NormalizedPageDocument>

export interface ProcessPageSourcesInput {
  runId: string
  sources: PageSource[]
  processor: ProcessorIdentity
  asin: string
  editionVersion: string
  outDir: string
  config: SchedulerConfig
  store: CheckpointStore
  stateStore: ProcessingStateStore
  runBatch: SchedulerRunBatch
  normalizePage: SchedulerNormalizePage
  /** Injectable backoff sleep (defaults to a real timer). */
  sleep?: (ms: number) => Promise<void>
  /** Injectable clock returning an ISO timestamp. */
  now?: () => string
  /** Injectable jitter fraction in [0, 0.25] added to each backoff. */
  jitter?: () => number
  signal?: AbortSignal
}

export interface ProcessingRunResult {
  runId: string
  status: BookStatus
  records: BookPageRecord[]
  counts: AggregateCounts
  /** Present only when a whole-run failure (transient exhaustion or
   * configuration) aborted scheduling. */
  failure?: ProcessingFailure
}

type AttemptOutcome =
  | { kind: 'ok'; output: RawCodexBatch; attempts: number }
  | { kind: 'failed'; failure: ProcessingFailure }
  | { kind: 'cancelled' }

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const defaultNow = (): string => new Date().toISOString()

const defaultJitter = (): number => Math.random() * 0.25

/**
 * Resumable engine that turns page sources into checkpointed results.
 *
 * Unavailable sources become failed checkpoints immediately. Available
 * sources with a reusable success are skipped; the rest are partitioned into
 * ordered batches (bounded by `concurrency`) and run through the injected
 * Codex runner. Successful pages are normalized and checkpointed with run
 * provenance. Classified failures drive retries, recursive halving, per-page
 * failure checkpoints, or a whole-run abort, and an `AbortSignal` cancels the
 * run while preserving completed work.
 */
export async function processPageSources(
  input: ProcessPageSourcesInput
): Promise<ProcessingRunResult> {
  const sleep = input.sleep ?? defaultSleep
  const now = input.now ?? defaultNow
  const jitter = input.jitter ?? defaultJitter
  const { processor, config } = input

  const expected = input.sources.length
  const captured = input.sources.filter(
    (source) => source.availability === 'available'
  ).length
  const startedAt = now()

  const records = new Map<string, PageCheckpoint>()
  const activeBatchIds = new Set<string>()
  let batchCounter = 0
  let terminalRunFailure: ProcessingFailure | undefined
  let cancelled = false

  const aborted = (): boolean => input.signal?.aborted ?? false
  const nextBatchId = (): string => `b${(batchCounter += 1)}`

  function currentCounts(): AggregateCounts {
    let succeeded = 0
    let failed = 0
    for (const record of records.values()) {
      if (record.status === 'succeeded') succeeded += 1
      else failed += 1
    }
    return {
      expected,
      captured,
      succeeded,
      failed,
      pending: expected - succeeded - failed
    }
  }

  async function writeState(
    status: ProcessingRunStatus,
    completedAt: string | null
  ): Promise<void> {
    try {
      await input.stateStore.write({
        runId: input.runId,
        status,
        startedAt,
        completedAt,
        activeBatchIds: [...activeBatchIds],
        counts: currentCounts()
      })
    } catch (err) {
      console.warn(
        `Failed to persist processing state (${status}): ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  function buildProvenance(
    source: PageSource,
    batchId: string,
    attempts: number,
    pageCacheKey: string
  ): ProcessingProvenance {
    return {
      runnerKind: 'codex-cli',
      codexCliVersion: processor.codexCliVersion,
      requestedModel: processor.requestedModel,
      promptVersion: processor.promptVersion,
      outputSchemaVersion: processor.outputSchemaVersion,
      normalizerVersion: processor.normalizerVersion,
      configurationHash: processor.configurationHash,
      pageCacheKey,
      runId: input.runId,
      batchId,
      attempts,
      completedAt: now()
    }
  }

  function unavailableCheckpoint(
    source: UnavailablePageSource
  ): FailedPageCheckpoint {
    return {
      status: 'failed',
      source,
      provenance: buildProvenance(
        source,
        'source-unavailable',
        source.sourceFailure.attempts,
        ''
      ),
      failure: source.sourceFailure
    }
  }

  function transientDelayMs(justFailedAttempt: number): number {
    const base = Math.min(
      transientBackoffMs[justFailedAttempt - 1] ?? transientBackoffMs.at(-1)!,
      maxTransientBackoffMs
    )
    return Math.round(base * (1 + jitter()))
  }

  async function attemptBatch(
    sources: AvailablePageSource[],
    batchId: string
  ): Promise<AttemptOutcome> {
    const pageIds = sources.map((source) => source.captureId)
    let attempt = 0
    for (;;) {
      if (aborted()) return { kind: 'cancelled' }
      attempt += 1
      const result = await input.runBatch(pageIds, {
        batchId,
        attempt,
        signal: input.signal
      })
      if (result.ok)
        return { kind: 'ok', output: result.output, attempts: attempt }

      const category = result.failure.category
      if (category === 'cancelled') return { kind: 'cancelled' }

      const failure: ProcessingFailure = {
        ...result.failure,
        attempts: attempt
      }
      if (attempt >= maxAttemptsFor(category)) {
        return { kind: 'failed', failure }
      }

      const delayMs =
        category === 'transient-service' ? transientDelayMs(attempt) : 0
      if (delayMs > 0) {
        if (aborted()) return { kind: 'cancelled' }
        await sleep(delayMs)
      }
    }
  }

  async function checkpointSuccesses(
    sources: AvailablePageSource[],
    output: RawCodexBatch,
    batchId: string,
    attempts: number
  ): Promise<void> {
    for (const source of sources) {
      const page = output.pages.find(
        (entry) => entry.pageId === source.captureId
      )
      if (!page) continue
      const document = await input.normalizePage({
        page,
        source,
        processor,
        asin: input.asin,
        editionVersion: input.editionVersion,
        outDir: input.outDir
      })
      const checkpoint: SucceededPageCheckpoint = {
        status: 'succeeded',
        source,
        provenance: buildProvenance(
          source,
          batchId,
          attempts,
          createPageCacheKey(source, processor)
        ),
        document
      }
      await input.store.write(checkpoint)
      records.set(source.captureId, checkpoint)
    }
    await writeState('running', null)
  }

  async function checkpointFailure(
    source: AvailablePageSource,
    failure: ProcessingFailure,
    batchId: string
  ): Promise<void> {
    const checkpoint: FailedPageCheckpoint = {
      status: 'failed',
      source,
      provenance: buildProvenance(
        source,
        batchId,
        failure.attempts,
        createPageCacheKey(source, processor)
      ),
      failure
    }
    await input.store.write(checkpoint)
    records.set(source.captureId, checkpoint)
    await writeState('running', null)
  }

  async function processBatch(sources: AvailablePageSource[]): Promise<void> {
    if (terminalRunFailure || cancelled) return
    if (aborted()) {
      cancelled = true
      return
    }

    const batchId = nextBatchId()
    activeBatchIds.add(batchId)
    try {
      const outcome = await attemptBatch(sources, batchId)
      if (outcome.kind === 'cancelled') {
        cancelled = true
        return
      }
      if (outcome.kind === 'ok') {
        // A completed run is preserved even if cancellation arrived during it.
        await checkpointSuccesses(
          sources,
          outcome.output,
          batchId,
          outcome.attempts
        )
        return
      }

      const { failure } = outcome
      if (
        failure.category === 'transient-service' ||
        failure.category === 'configuration'
      ) {
        terminalRunFailure = failure
        return
      }

      if (aborted()) {
        cancelled = true
        return
      }
      if (sources.length === 1) {
        await checkpointFailure(sources[0]!, failure, batchId)
        return
      }

      const midpoint = Math.ceil(sources.length / 2)
      await processBatch(sources.slice(0, midpoint))
      await processBatch(sources.slice(midpoint))
    } finally {
      activeBatchIds.delete(batchId)
    }
  }

  // 1. Startup: clear stale temp files left by a crashed prior run.
  await input.store.removeStaleTemps()

  // 2. Resolve unavailable sources and cache hits; collect the rest to run.
  const uncached: AvailablePageSource[] = []
  for (const source of input.sources) {
    if (source.availability === 'unavailable') {
      const checkpoint = unavailableCheckpoint(source)
      await input.store.write(checkpoint)
      records.set(source.captureId, checkpoint)
      continue
    }
    const reusable = await input.store.readReusable(source, processor)
    if (reusable) {
      records.set(source.captureId, reusable)
      continue
    }
    uncached.push(source)
  }

  await writeState('running', null)

  // 3. Partition into ordered batches and run with bounded concurrency.
  let scheduleError: unknown
  try {
    const batches = chunk(uncached, config.batchSize)
    await pMap(batches, (batch) => processBatch(batch), {
      concurrency: config.concurrency
    })
  } catch (err) {
    scheduleError = err
  }

  // 4. Assemble ordered records, counts, terminal status, and state.
  const status = deriveStatus(cancelled, terminalRunFailure, currentCounts())
  const runRecords = input.sources.map((source): BookPageRecord => {
    const checkpoint = records.get(source.captureId)
    if (checkpoint) return checkpoint
    return { status: 'pending', source }
  })
  const counts = currentCounts()
  await writeState(status, now())

  if (scheduleError) throw scheduleError

  return {
    runId: input.runId,
    status,
    records: runRecords,
    counts,
    failure: terminalRunFailure
  }
}

function maxAttemptsFor(category: ProcessingFailureCategory): number {
  if (category === 'transient-service') return 3
  if (
    category === 'timeout' ||
    category === 'protocol' ||
    category === 'content-validation' ||
    category === 'diagnostic-overflow'
  ) {
    return 2
  }
  // configuration aborts immediately; source (and anything else) is not retried.
  return 1
}

function deriveStatus(
  cancelled: boolean,
  terminalRunFailure: ProcessingFailure | undefined,
  counts: AggregateCounts
): BookStatus {
  if (cancelled) return 'cancelled'
  if (terminalRunFailure) return 'failed'
  if (counts.failed === 0 && counts.pending === 0) return 'complete'
  if (counts.succeeded > 0) return 'partial'
  return 'failed'
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}
