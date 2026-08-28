import path from 'node:path'

import type { BookMetadata } from '../types'
import type {
  AggregateCounts,
  BookDocument,
  BookIdentity,
  BookPageRecord,
  BookStatus,
  PageSource,
  ProcessorIdentity
} from './types'
import { atomicWriteJson } from './checkpoint-store'

const bookDocumentFileName = 'book-document.json'

export interface AssembleBookDocumentInput {
  metadata: BookMetadata
  /** Complete, ordered source inventory (available and unavailable). */
  sources: PageSource[]
  /**
   * Per-page records observed so far. Only `succeeded`/`failed` entries are
   * trusted as real checkpoints; any other entry (including a scheduler's
   * placeholder `pending` record for a source with no checkpoint yet) is
   * ignored and re-synthesized from `runStatus` below. This lets callers
   * pass either a filtered list of real checkpoints or a
   * `ProcessingRunResult.records` array directly.
   */
  checkpoints: readonly BookPageRecord[]
  /** The run's terminal status; `'cancelled'` synthesizes `cancelled`
   * records for every source without a real checkpoint, otherwise `pending`
   * records are synthesized. */
  runStatus: BookStatus
  processor: ProcessorIdentity
}

/**
 * Assembles the complete canonical `BookDocument`: every source in
 * `input.sources` is represented exactly once, in inventory order, as its
 * real checkpoint when one exists or a synthesized `pending`/`cancelled`
 * record otherwise. `expected` counts the full inventory; `captured` counts
 * only sources whose screenshot evidence is available. No source is ever
 * filtered out, including unavailable or failed pages.
 */
export function assembleBookDocument(
  input: AssembleBookDocumentInput
): BookDocument {
  const checkpointsByCaptureId = new Map<string, BookPageRecord>()
  for (const record of input.checkpoints) {
    if (record.status === 'succeeded' || record.status === 'failed') {
      checkpointsByCaptureId.set(record.source.captureId, record)
    }
  }

  const cancelled = input.runStatus === 'cancelled'

  const pages: BookPageRecord[] = input.sources.map((source) => {
    const checkpoint = checkpointsByCaptureId.get(source.captureId)
    if (checkpoint) return checkpoint
    return cancelled
      ? { status: 'cancelled' as const, source }
      : { status: 'pending' as const, source }
  })

  const counts = deriveCounts(input.sources, pages)
  const status = deriveBookStatus(cancelled, counts)

  return {
    schemaVersion: '1',
    book: bookIdentityFor(input.metadata),
    processor: input.processor,
    status,
    counts,
    pages
  }
}

/** Atomically writes `book-document.json` using the same private,
 * same-directory-rename helper as page checkpoints and processing state. */
export async function writeBookDocument(
  outDir: string,
  document: BookDocument
): Promise<void> {
  await atomicWriteJson(path.join(outDir, bookDocumentFileName), document)
}

function deriveCounts(
  sources: PageSource[],
  pages: BookPageRecord[]
): AggregateCounts {
  const expected = sources.length
  const captured = sources.filter(
    (source) => source.availability === 'available'
  ).length

  let succeeded = 0
  let failed = 0
  for (const page of pages) {
    if (page.status === 'succeeded') succeeded += 1
    else if (page.status === 'failed') failed += 1
  }

  return {
    expected,
    captured,
    succeeded,
    failed,
    pending: expected - succeeded - failed
  }
}

/**
 * A counts-based status derivation: an explicit cancellation always wins, a
 * fully-succeeded inventory is `complete`, any partial success is
 * `partial`, and zero successes is `failed`. This is computed from the
 * final assembled counts rather than passed through from `runStatus`, so it
 * can intentionally diverge from `ProcessingRunResult.status` - e.g. a
 * whole-run `configuration` failure that still produced some successful
 * pages yields `runStatus: 'failed'` but a document `status` of `'partial'`.
 */
function deriveBookStatus(
  cancelled: boolean,
  counts: AggregateCounts
): BookStatus {
  if (cancelled) return 'cancelled'
  if (counts.failed === 0 && counts.pending === 0) return 'complete'
  if (counts.succeeded > 0) return 'partial'
  return 'failed'
}

function bookIdentityFor(metadata: BookMetadata): BookIdentity {
  return {
    asin: metadata.meta.asin,
    editionVersion: metadata.meta.version,
    title: metadata.meta.title,
    authors: metadata.meta.authorList
  }
}
