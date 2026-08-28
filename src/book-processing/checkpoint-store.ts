import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  AvailablePageSource,
  FailedPageCheckpoint,
  PageCheckpoint,
  ProcessorIdentity,
  SucceededPageCheckpoint
} from './types'
import { createPageCacheKey } from './processor-identity'

const pageDocumentsDirName = 'page-documents'
const captureIdPattern = /^c\d{6}$/
const staleTempPattern = /^\.c\d{6}\.json\.tmp-\d+-[0-9a-f-]+$/i

export interface CheckpointStore {
  /** Reads and validates the checkpoint for one capture ID, or `undefined`
   * when no checkpoint has been written for it yet. Throws when a
   * checkpoint file exists but is corrupt (unparsable JSON, an unrecognized
   * status, or a source identity that does not match `captureId`). */
  read(captureId: string): Promise<PageCheckpoint | undefined>
  /** Returns the stored checkpoint only when it succeeded and its recorded
   * page cache key exactly matches the key recomputed for `source` and
   * `processor` right now; otherwise returns `undefined` so the caller
   * reprocesses the page. A corrupt checkpoint file is treated the same as
   * a cache miss (logging a warning) rather than throwing, so one bad
   * checkpoint cannot abort an otherwise-resumable run. */
  readReusable(
    source: AvailablePageSource,
    processor: ProcessorIdentity
  ): Promise<SucceededPageCheckpoint | undefined>
  /** Atomically writes (or replaces) the checkpoint for
   * `checkpoint.source.captureId`. */
  write(checkpoint: PageCheckpoint): Promise<void>
  /** Removes only leftover temp files matching the atomic-write naming
   * convention, left behind by a process that died mid-write. Safe to call
   * at startup before any checkpoints are read or written. */
  removeStaleTemps(): Promise<void>
}

/**
 * Writes `value` as pretty-printed JSON to `filePath` without ever exposing
 * a partially written file at that path: the content is written to a
 * private, same-directory temp file, flushed and closed, then renamed over
 * `filePath`. If writing or renaming fails, only the exact temp file this
 * call generated is unlinked before the error is rethrown.
 */
export async function atomicWriteJson(
  filePath: string,
  value: unknown
): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`
  )
  try {
    const handle = await fs.open(tempPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tempPath, filePath)
  } catch (err) {
    await fs.unlink(tempPath).catch(() => undefined)
    throw err
  }
}

export async function createCheckpointStore(
  outDir: string
): Promise<CheckpointStore> {
  const pageDocumentsDir = path.join(outDir, pageDocumentsDirName)
  await fs.mkdir(pageDocumentsDir, { recursive: true, mode: 0o700 })

  function checkpointPathFor(captureId: string): string {
    assertSafeCaptureId(captureId)
    return path.join(pageDocumentsDir, `${captureId}.json`)
  }

  async function read(captureId: string): Promise<PageCheckpoint | undefined> {
    let raw: string
    try {
      raw = await fs.readFile(checkpointPathFor(captureId), 'utf8')
    } catch (err) {
      if (isMissingFile(err)) return undefined
      throw err
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Checkpoint ${captureId} is not valid JSON`)
    }

    return validateCheckpoint(parsed, captureId)
  }

  async function readReusable(
    source: AvailablePageSource,
    processor: ProcessorIdentity
  ): Promise<SucceededPageCheckpoint | undefined> {
    let checkpoint: PageCheckpoint | undefined
    try {
      checkpoint = await read(source.captureId)
    } catch (err) {
      console.warn(
        `Ignoring corrupt checkpoint for ${source.captureId}, reprocessing: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return undefined
    }
    if (!checkpoint || checkpoint.status !== 'succeeded') return undefined

    const expectedCacheKey = createPageCacheKey(source, processor)
    if (checkpoint.provenance.pageCacheKey !== expectedCacheKey) {
      return undefined
    }

    return checkpoint
  }

  async function write(checkpoint: PageCheckpoint): Promise<void> {
    await atomicWriteJson(
      checkpointPathFor(checkpoint.source.captureId),
      checkpoint
    )
  }

  async function removeStaleTemps(): Promise<void> {
    const entries = await fs.readdir(pageDocumentsDir)
    await Promise.all(
      entries
        .filter((entry) => staleTempPattern.test(entry))
        .map((entry) =>
          fs.unlink(path.join(pageDocumentsDir, entry)).catch((err) => {
            console.warn(
              `Failed to remove stale checkpoint temp file ${entry}: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
        )
    )
  }

  return { read, readReusable, write, removeStaleTemps }
}

function assertSafeCaptureId(captureId: string): void {
  if (!captureIdPattern.test(captureId)) {
    throw new Error(`Invalid capture id: ${captureId}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/**
 * Validates that `value` is a well-formed `PageCheckpoint` before it is
 * trusted as a cache hit: a recognized `status` discriminant, a `source`
 * whose `captureId` matches the file it was read from, and the minimal
 * per-status shape (`provenance.pageCacheKey`, plus `document` for a
 * success or `failure` for a failure). This is a corruption guard, not a
 * full re-validation of normalizer output already validated when the
 * checkpoint was written.
 */
function validateCheckpoint(value: unknown, captureId: string): PageCheckpoint {
  if (!isRecord(value)) {
    throw new Error(`Checkpoint ${captureId} is not a JSON object`)
  }

  const { status, source, provenance } = value

  if (!isRecord(source) || typeof source.captureId !== 'string') {
    throw new Error(`Checkpoint ${captureId} has an invalid source`)
  }
  if (source.captureId !== captureId) {
    throw new Error(
      `Checkpoint ${captureId} contains a mismatched source identity (${String(source.captureId)})`
    )
  }
  if (!isRecord(provenance) || typeof provenance.pageCacheKey !== 'string') {
    throw new Error(`Checkpoint ${captureId} has invalid provenance`)
  }

  if (status === 'succeeded') {
    if (source.availability !== 'available') {
      throw new Error(
        `Checkpoint ${captureId} is marked succeeded without an available source`
      )
    }
    if (
      !isRecord(value.document) ||
      !Array.isArray(value.document.blocks) ||
      !Array.isArray(value.document.warnings)
    ) {
      throw new Error(`Checkpoint ${captureId} is missing a valid document`)
    }
    return value as unknown as SucceededPageCheckpoint
  }

  if (status === 'failed') {
    if (
      !isRecord(value.failure) ||
      typeof value.failure.category !== 'string'
    ) {
      throw new Error(`Checkpoint ${captureId} is missing a valid failure`)
    }
    return value as unknown as FailedPageCheckpoint
  }

  throw new Error(`Checkpoint ${captureId} has an unrecognized status`)
}
