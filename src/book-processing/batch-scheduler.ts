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

  console.log('[scheduler] run start', {
    runId: input.runId,
    pages: expected,
    batchSize: config.batchSize,
    concurrency: config.concurrency
  })

  const records = new Map<string, PageCheckpoint>()
  const activeBatchIds = new Set<string>()
  let batchCounter = 0
  let terminalRunFailure: ProcessingFailure | undefined
  let cancelled = false

  const aborted = (): boolean => input.signal?.aborted ?? false
  const nextBatchId = (): string => `b${(batchCounter += 1)}`

  /** Marks the run cancelled and logs it exactly once, no matter how many
   * concurrent batches observe the abort signal. */
  function markCancelled(): void {
    if (!cancelled) {
      console.warn('[scheduler] run cancelled', { runId: input.runId })
    }
    cancelled = true
  }

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
      console.warn('[scheduler] batch retry', {
        batchId,
        category,
        attempt,
        delayMs
      })
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
      if (!page) {
        console.warn('[scheduler] batch ok but page missing from output', {
          batchId,
          captureId: source.captureId
        })
        continue
      }
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
    console.warn('[scheduler] failed checkpoint written', {
      captureId: source.captureId,
      category: failure.category,
      batchId
    })
    await writeState('running', null)
  }

  async function processBatch(sources: AvailablePageSource[]): Promise<void> {
    if (terminalRunFailure || cancelled) return
    if (aborted()) {
      markCancelled()
      return
    }

    const batchId = nextBatchId()
    const pageIds = sources.map((source) => source.captureId)
    activeBatchIds.add(batchId)
    console.log('[scheduler] batch start', {
      batchId,
      pages: sources.length,
      pageIds
    })
    try {
      const outcome = await attemptBatch(sources, batchId)
      if (outcome.kind === 'cancelled') {
        markCancelled()
        return
      }
      if (outcome.kind === 'ok') {
        console.log('[scheduler] batch success', {
          batchId,
          pages: sources.length,
          attempts: outcome.attempts
        })
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
        if (!terminalRunFailure) {
          console.error(`[scheduler] run aborted (${failure.category})`, {
            batchId,
            code: failure.code,
            attempts: failure.attempts
          })
        }
        terminalRunFailure = failure
        return
      }

      if (aborted()) {
        markCancelled()
        return
      }
      if (sources.length === 1) {
        await checkpointFailure(sources[0]!, failure, batchId)
        return
      }

      const midpoint = Math.ceil(sources.length / 2)
      const left = sources.slice(0, midpoint)
      const right = sources.slice(midpoint)
      console.log('[scheduler] batch split', {
        batchId,
        parentPageIds: pageIds,
        leftPageIds: left.map((source) => source.captureId),
        rightPageIds: right.map((source) => source.captureId)
      })
      await processBatch(left)
      await processBatch(right)
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
      console.warn('[scheduler] failed checkpoint written', {
        captureId: source.captureId,
        category: checkpoint.failure.category
      })
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

  // 4. Assemble ordered records, counts, terminal status, and state. The
  // terminal writeState runs in `finally` so persisted state is never left
  // stuck on 'running', even if status derivation itself throws.
  let status: BookStatus = 'failed'
  let runRecords: BookPageRecord[] = []
  let counts: AggregateCounts = currentCounts()
  try {
    status = deriveStatus(cancelled, terminalRunFailure, currentCounts())
    runRecords = input.sources.map((source): BookPageRecord => {
      const checkpoint = records.get(source.captureId)
      if (checkpoint) return checkpoint
      return { status: 'pending', source }
    })
    counts = currentCounts()
  } finally {
    await writeState(status, now())
  }

  console.log('[scheduler] run finish', {
    runId: input.runId,
    status,
    counts
  })

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
