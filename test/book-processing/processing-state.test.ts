import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type {
  AggregateCounts,
  ProcessingRunStatus,
  ProcessingState
} from '../../src/book-processing/types'
import { createProcessingStateStore } from '../../src/book-processing/processing-state'

const temporaryDirectories: string[] = []

async function createOutDir(): Promise<string> {
  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kindle-processing-state-')
  )
  temporaryDirectories.push(outDir)
  return outDir
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

const counts: AggregateCounts = {
  expected: 3,
  captured: 3,
  succeeded: 1,
  failed: 0,
  pending: 2
}

function stateWith(status: ProcessingRunStatus): ProcessingState {
  return {
    runId: 'run-1',
    status,
    startedAt: '2026-08-27T10:00:00.000Z',
    completedAt:
      status === 'running' || status === 'pending'
        ? null
        : '2026-08-27T10:01:00.000Z',
    activeBatchIds: status === 'running' ? ['b1'] : [],
    counts
  }
}

describe('createProcessingStateStore', () => {
  test('returns undefined before any state is written', async () => {
    const store = await createProcessingStateStore(await createOutDir())
    expect(await store.read()).toBeUndefined()
  })

  test.each<ProcessingRunStatus>([
    'pending',
    'running',
    'complete',
    'partial',
    'failed',
    'cancelled'
  ])('round-trips the %s status', async (status) => {
    const store = await createProcessingStateStore(await createOutDir())
    const state = stateWith(status)
    await store.write(state)
    expect(await store.read()).toEqual(state)
  })

  test('records cancellation without losing completed counts', async () => {
    const outDir = await createOutDir()
    const store = await createProcessingStateStore(outDir)
    await store.write({
      runId: 'run-1',
      status: 'cancelled',
      startedAt: '2026-08-27T10:00:00.000Z',
      completedAt: '2026-08-27T10:01:00.000Z',
      activeBatchIds: [],
      counts: { expected: 3, captured: 3, succeeded: 1, failed: 0, pending: 2 }
    })
    await expect(store.read()).resolves.toMatchObject({
      status: 'cancelled',
      counts: { succeeded: 1, pending: 2 }
    })
  })

  test('writes processing-state.json privately and atomically', async () => {
    const outDir = await createOutDir()
    const store = await createProcessingStateStore(outDir)
    await store.write(stateWith('running'))

    const stat = await fs.stat(path.join(outDir, 'processing-state.json'))
    expect(stat.mode & 0o777).toBe(0o600)
    const files = await fs.readdir(outDir)
    expect(files.filter((file) => file.includes('.tmp-'))).toEqual([])
  })

  test('rejects a corrupt state file on read', async () => {
    const outDir = await createOutDir()
    const store = await createProcessingStateStore(outDir)
    await fs.writeFile(path.join(outDir, 'processing-state.json'), 'not json', {
      mode: 0o600
    })
    await expect(store.read()).rejects.toThrow()
  })

  test('rejects an unrecognized status on read', async () => {
    const outDir = await createOutDir()
    const store = await createProcessingStateStore(outDir)
    await fs.writeFile(
      path.join(outDir, 'processing-state.json'),
      `${JSON.stringify({ ...stateWith('running'), status: 'bogus' })}\n`,
      { mode: 0o600 }
    )
    await expect(store.read()).rejects.toThrow()
  })

  test('rejects a state whose counts are incomplete', async () => {
    const outDir = await createOutDir()
    const store = await createProcessingStateStore(outDir)
    await fs.writeFile(
      path.join(outDir, 'processing-state.json'),
      `${JSON.stringify({
        ...stateWith('running'),
        counts: { expected: 1 }
      })}\n`,
      { mode: 0o600 }
    )
    await expect(store.read()).rejects.toThrow()
  })
})
