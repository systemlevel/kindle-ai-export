import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import type {
  AvailablePageSource,
  FailedPageCheckpoint,
  ProcessorIdentity,
  SucceededPageCheckpoint
} from '../../src/book-processing/types'
import {
  atomicWriteJson,
  createCheckpointStore
} from '../../src/book-processing/checkpoint-store'
import { createPageCacheKey } from '../../src/book-processing/processor-identity'

const temporaryDirectories: string[] = []

async function createOutDir(): Promise<string> {
  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kindle-checkpoint-store-')
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

const source: AvailablePageSource = {
  captureId: 'c000000',
  index: 0,
  printedPage: 1,
  position: null,
  screenshotPath: 'pages/0000-0001.png',
  rendererBatch: null,
  availability: 'available',
  screenshotSha256: 'a'.repeat(64),
  width: 20,
  height: 10
}

const processor: ProcessorIdentity = {
  runnerKind: 'codex-cli',
  codexCliVersion: '0.1.0',
  requestedModel: 'cli-default',
  promptVersion: '1',
  promptSha256: 'b'.repeat(64),
  outputSchemaVersion: '1',
  outputSchemaSha256: 'c'.repeat(64),
  normalizerVersion: '1',
  configurationHash: 'd'.repeat(64)
}

const changedProcessor: ProcessorIdentity = {
  ...processor,
  promptVersion: '2'
}

function successCheckpointFor(
  pageSource: AvailablePageSource,
  processorIdentity: ProcessorIdentity
): SucceededPageCheckpoint {
  return {
    status: 'succeeded',
    source: pageSource,
    provenance: {
      runnerKind: 'codex-cli',
      codexCliVersion: processorIdentity.codexCliVersion,
      requestedModel: processorIdentity.requestedModel,
      promptVersion: processorIdentity.promptVersion,
      outputSchemaVersion: processorIdentity.outputSchemaVersion,
      normalizerVersion: processorIdentity.normalizerVersion,
      configurationHash: processorIdentity.configurationHash,
      pageCacheKey: createPageCacheKey(pageSource, processorIdentity),
      runId: 'run-1',
      batchId: 'batch-1',
      attempts: 1,
      completedAt: '2026-01-01T00:00:00.000Z'
    },
    document: {
      source: pageSource,
      blocks: [],
      warnings: []
    }
  }
}

function failedCheckpointFor(
  pageSource: AvailablePageSource,
  processorIdentity: ProcessorIdentity
): FailedPageCheckpoint {
  return {
    status: 'failed',
    source: pageSource,
    provenance: {
      runnerKind: 'codex-cli',
      codexCliVersion: processorIdentity.codexCliVersion,
      requestedModel: processorIdentity.requestedModel,
      promptVersion: processorIdentity.promptVersion,
      outputSchemaVersion: processorIdentity.outputSchemaVersion,
      normalizerVersion: processorIdentity.normalizerVersion,
      configurationHash: processorIdentity.configurationHash,
      pageCacheKey: createPageCacheKey(pageSource, processorIdentity),
      runId: 'run-1',
      batchId: 'batch-1',
      attempts: 2,
      completedAt: '2026-01-01T00:00:00.000Z'
    },
    failure: {
      category: 'timeout',
      code: 'timeout',
      message: 'Codex invocation timed out',
      attempts: 2,
      occurredAt: '2026-01-01T00:00:00.000Z',
      exitCode: null,
      signal: null
    }
  }
}

const successCheckpoint = successCheckpointFor(source, processor)
const failedCheckpoint = failedCheckpointFor(source, processor)

describe('createCheckpointStore', () => {
  test('reuses only matching successful checkpoints', async () => {
    const outDir = await createOutDir()
    const store = await createCheckpointStore(outDir)
    await store.write(successCheckpoint)
    expect(await store.readReusable(source, processor)).toEqual(
      successCheckpoint
    )
    expect(await store.readReusable(source, changedProcessor)).toBeUndefined()
    await store.write(failedCheckpoint)
    expect(await store.readReusable(source, processor)).toBeUndefined()
  })

  test('readReusable stays silent on a genuine cache miss', async () => {
    const outDir = await createOutDir()
    const store = await createCheckpointStore(outDir)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await store.readReusable(source, processor)).toBeUndefined()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('readReusable treats a corrupt checkpoint as a cache miss and warns, while read() still throws', async () => {
    const outDir = await createOutDir()
    const store = await createCheckpointStore(outDir)
    await fs.writeFile(
      path.join(outDir, 'page-documents', 'c000000.json'),
      `${JSON.stringify({ ...successCheckpoint, status: 'unknown' })}\n`,
      { mode: 0o600 }
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await store.readReusable(source, processor)).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('c000000')
    } finally {
      warnSpy.mockRestore()
    }

    await expect(store.read('c000000')).rejects.toThrow()
  })

  test('readReusable treats invalid JSON as a cache miss and warns, while read() still throws', async () => {
    const outDir = await createOutDir()
    const store = await createCheckpointStore(outDir)
    await fs.writeFile(
      path.join(outDir, 'page-documents', 'c000000.json'),
      'not json',
      { mode: 0o600 }
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await store.readReusable(source, processor)).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('c000000')
    } finally {
      warnSpy.mockRestore()
    }

    await expect(store.read('c000000')).rejects.toThrow()
  })

  test('readReusable treats a missing warnings array as a corrupt succeeded checkpoint', async () => {
    const outDir = await createOutDir()
    const store = await createCheckpointStore(outDir)
    const { warnings, ...documentWithoutWarnings } = successCheckpoint.document
    await fs.writeFile(
      path.join(outDir, 'page-documents', 'c000000.json'),
      `${JSON.stringify({
        ...successCheckpoint,
        document: documentWithoutWarnings
      })}\n`,
      { mode: 0o600 }
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await store.readReusable(source, processor)).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }

    await expect(store.read('c000000')).rejects.toThrow()
  })

  test('writes private files atomically', async () => {
    const outDir = await createOutDir()
    const store = await createCheckpointStore(outDir)
    await store.write(successCheckpoint)
    const stat = await fs.stat(
      path.join(outDir, 'page-documents', 'c000000.json')
    )
    expect(stat.mode & 0o777).toBe(0o600)
    const files = await fs.readdir(path.join(outDir, 'page-documents'))
    expect(files.filter((file) => file.includes('.tmp-'))).toEqual([])
  })

  test('creates the page-documents directory with a private mode', async () => {
    const outDir = await createOutDir()
    await createCheckpointStore(outDir)
    const stat = await fs.stat(path.join(outDir, 'page-documents'))
    expect(stat.mode & 0o777).toBe(0o700)
  })

  test('reads back a written checkpoint and returns undefined when missing', async () => {
    const outDir = await createOutDir()
    const store = await createCheckpointStore(outDir)
    expect(await store.read('c000000')).toBeUndefined()
    await store.write(successCheckpoint)
    expect(await store.read('c000000')).toEqual(successCheckpoint)
  })

  test('replaces an existing checkpoint atomically, leaving one file behind', async () => {
    const outDir = await createOutDir()
    const store = await createCheckpointStore(outDir)
    await store.write(successCheckpoint)
    await store.write(failedCheckpoint)

    expect(await store.read('c000000')).toEqual(failedCheckpoint)
    const files = await fs.readdir(path.join(outDir, 'page-documents'))
    expect(files).toEqual(['c000000.json'])
  })

  test('rejects a checkpoint file that is not valid JSON', async () => {
    const outDir = await createOutDir()
    const store = await createCheckpointStore(outDir)
    await fs.writeFile(
      path.join(outDir, 'page-documents', 'c000000.json'),
      'not json',
      { mode: 0o600 }
    )

    await expect(store.read('c000000')).rejects.toThrow()
  })

  test('rejects a checkpoint whose status discriminant is unrecognized', async () => {
    const outDir = await createOutDir()
    const store = await createCheckpointStore(outDir)
    await fs.writeFile(
      path.join(outDir, 'page-documents', 'c000000.json'),
      `${JSON.stringify({ ...successCheckpoint, status: 'unknown' })}\n`,
      { mode: 0o600 }
    )

    await expect(store.read('c000000')).rejects.toThrow()
  })

  test('rejects a checkpoint whose source identity does not match its filename', async () => {
    const outDir = await createOutDir()
    const store = await createCheckpointStore(outDir)
    await fs.writeFile(
      path.join(outDir, 'page-documents', 'c000001.json'),
      `${JSON.stringify(successCheckpoint)}\n`,
      { mode: 0o600 }
    )

    await expect(store.read('c000001')).rejects.toThrow()
  })

  test('removes only files matching the stale temp naming convention', async () => {
    const outDir = await createOutDir()
    const store = await createCheckpointStore(outDir)
    const pageDocumentsDir = path.join(outDir, 'page-documents')
    const staleTemp =
      '.c000000.json.tmp-12345-abcdef12-3456-7890-abcd-ef1234567890'
    const unrelatedFile = 'c000000.json.tmp-not-hidden'
    await fs.writeFile(path.join(pageDocumentsDir, staleTemp), '{}', {
      mode: 0o600
    })
    await fs.writeFile(path.join(pageDocumentsDir, unrelatedFile), '{}', {
      mode: 0o600
    })
    await store.write(successCheckpoint)

    await store.removeStaleTemps()

    const files = await fs.readdir(pageDocumentsDir)
    expect(files.toSorted()).toEqual(['c000000.json', unrelatedFile])
  })
})

describe('atomicWriteJson', () => {
  test('writes pretty JSON with a trailing newline at a private mode', async () => {
    const outDir = await createOutDir()
    const filePath = path.join(outDir, 'value.json')

    await atomicWriteJson(filePath, { hello: 'world' })

    const contents = await fs.readFile(filePath, 'utf8')
    expect(contents).toBe('{\n  "hello": "world"\n}\n')
    const stat = await fs.stat(filePath)
    expect(stat.mode & 0o777).toBe(0o600)
    const files = await fs.readdir(outDir)
    expect(files.filter((file) => file.includes('.tmp-'))).toEqual([])
  })

  test('unlinks the generated temp file when the rename fails', async () => {
    const outDir = await createOutDir()
    const filePath = path.join(outDir, 'value.json')
    await fs.mkdir(filePath)

    await expect(atomicWriteJson(filePath, { a: 1 })).rejects.toThrow()

    const files = await fs.readdir(outDir)
    expect(files).toEqual(['value.json'])
  })
})
