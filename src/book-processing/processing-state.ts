import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  AggregateCounts,
  ProcessingRunStatus,
  ProcessingState
} from './types'
import { atomicWriteJson } from './checkpoint-store'

const stateFileName = 'processing-state.json'

const runStatuses: readonly ProcessingRunStatus[] = [
  'pending',
  'running',
  'complete',
  'partial',
  'failed',
  'cancelled'
]

const countKeys: readonly (keyof AggregateCounts)[] = [
  'expected',
  'captured',
  'succeeded',
  'failed',
  'pending'
]

export interface ProcessingStateStore {
  /** Reads and validates the persisted run state, or `undefined` when no run
   * has written one yet. Throws when the file exists but is corrupt (invalid
   * JSON, an unrecognized status, or malformed counts). */
  read(): Promise<ProcessingState | undefined>
  /** Atomically writes (or replaces) the single `processing-state.json`. */
  write(state: ProcessingState): Promise<void>
}

/**
 * Persists a run's lifecycle to a private `processing-state.json` inside the
 * book output directory. Writes go through {@link atomicWriteJson} so a
 * partially written file is never observable, mirroring the checkpoint store.
 */
export async function createProcessingStateStore(
  outDir: string
): Promise<ProcessingStateStore> {
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 })
  const filePath = path.join(outDir, stateFileName)

  async function write(state: ProcessingState): Promise<void> {
    await atomicWriteJson(filePath, validateState(state))
  }

  async function read(): Promise<ProcessingState | undefined> {
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf8')
    } catch (err) {
      if (isMissingFile(err)) return undefined
      throw err
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`${stateFileName} is not valid JSON`)
    }

    return validateState(parsed)
  }

  return { read, write }
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

function isRunStatus(value: unknown): value is ProcessingRunStatus {
  return (
    typeof value === 'string' &&
    (runStatuses as readonly string[]).includes(value)
  )
}

function validateCounts(value: unknown): AggregateCounts {
  if (!isRecord(value)) {
    throw new Error(`${stateFileName} has invalid counts`)
  }
  for (const key of countKeys) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      throw new Error(`${stateFileName} counts are missing "${key}"`)
    }
  }
  return value as unknown as AggregateCounts
}

function validateState(value: unknown): ProcessingState {
  if (!isRecord(value)) {
    throw new Error(`${stateFileName} is not a JSON object`)
  }
  if (typeof value.runId !== 'string') {
    throw new Error(`${stateFileName} is missing a run id`)
  }
  if (!isRunStatus(value.status)) {
    throw new Error(`${stateFileName} has an unrecognized status`)
  }
  if (typeof value.startedAt !== 'string') {
    throw new Error(`${stateFileName} is missing startedAt`)
  }
  if (value.completedAt !== null && typeof value.completedAt !== 'string') {
    throw new Error(`${stateFileName} has an invalid completedAt`)
  }
  if (
    !Array.isArray(value.activeBatchIds) ||
    value.activeBatchIds.some((id) => typeof id !== 'string')
  ) {
    throw new Error(`${stateFileName} has invalid activeBatchIds`)
  }
  validateCounts(value.counts)
  return value as unknown as ProcessingState
}
