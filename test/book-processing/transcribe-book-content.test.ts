/* eslint-disable no-process-env */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, test } from 'vitest'

import type { LegacyContentChunk } from '../../src/book-processing/legacy-content'
import type {
  BookDocument,
  ProcessorIdentity
} from '../../src/book-processing/types'
import type { BookMetadata } from '../../src/types'
import { processBook } from '../../src/transcribe-book-content'
import { readJsonFile } from '../../src/utils'

const fakeCodexPath = path.resolve('test/fixtures/fake-codex.mjs')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

async function writeSyntheticPng(filePath: string): Promise<void> {
  const buffer = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  })
    .png()
    .toBuffer()
  await fs.writeFile(filePath, buffer)
}

function syntheticMetadata(): BookMetadata {
  return {
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
      endContentPage: 2,
      totalNumPages: 2,
      totalNumContentPages: 2
    },
    toc: [{ label: 'Chapter One', positionId: 0, page: 1, depth: 0 }],
    pages: [
      { index: 0, page: 1, screenshot: 'pages/0000.png' },
      { index: 1, page: 2, screenshot: 'pages/0001.png' }
    ],
    locationMap: { locations: [], navigationUnit: [] }
  }
}

async function createBookFixture(): Promise<{ cwd: string; outDir: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-transcribe-'))
  temporaryDirectories.push(cwd)
  const outDir = path.join(cwd, 'out', 'TESTASIN')
  await fs.mkdir(path.join(outDir, 'pages'), { recursive: true })
  await writeSyntheticPng(path.join(outDir, 'pages', '0000.png'))
  await writeSyntheticPng(path.join(outDir, 'pages', '0001.png'))
  await fs.writeFile(
    path.join(outDir, 'metadata.json'),
    JSON.stringify(syntheticMetadata())
  )
  return { cwd, outDir }
}

describe('processBook', () => {
  test('processes a complete book through the injected Codex boundary', async () => {
    await fs.chmod(fakeCodexPath, 0o700)
    const { cwd, outDir } = await createBookFixture()

    // Prove no code path ever reads OPENAI_API_KEY off the injected env. The
    // property is non-enumerable so child-process env enumeration skips it,
    // meaning the getter only fires on an explicit, intentional read.
    let openaiKeyAccessed = false
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ASIN: 'TESTASIN',
      CODEX_BIN: fakeCodexPath,
      // Deterministic: never inherit a stray scenario from the ambient env.
      FAKE_CODEX_SCENARIO: 'success'
    }
    delete env.OPENAI_API_KEY
    Object.defineProperty(env, 'OPENAI_API_KEY', {
      enumerable: false,
      configurable: true,
      get() {
        openaiKeyAccessed = true
        return undefined
      }
    })

    const result = await processBook({ cwd, env })

    expect(result.document.status).toBe('complete')
    expect(result.run.status).toBe('complete')

    // Processor identity is derived from the real Codex preflight + prompt.
    const processor: ProcessorIdentity = result.document.processor
    expect(processor.runnerKind).toBe('codex-cli')
    expect(processor.codexCliVersion).toBe('0.147.0')
    expect(processor.promptVersion).toBe('1')
    expect(processor.outputSchemaVersion).toBe('1')
    expect(processor.configurationHash).toMatch(/^[0-9a-f]{64}$/)

    // Canonical document written to disk.
    const document = await readJsonFile<BookDocument>(
      path.join(outDir, 'book-document.json')
    )
    expect(document).toMatchObject({ schemaVersion: '1', status: 'complete' })
    expect(document.pages).toHaveLength(2)

    // Legacy projection written to disk.
    const content = await readJsonFile<LegacyContentChunk[]>(
      path.join(outDir, 'content.json')
    )
    expect(content).toHaveLength(2)
    expect(content.map((chunk) => chunk.page)).toEqual([1, 2])

    // Per-page checkpoints persisted for a resumable run.
    const checkpoints = await fs.readdir(path.join(outDir, 'page-documents'))
    expect(checkpoints.toSorted()).toEqual(['c000000.json', 'c000001.json'])

    expect(openaiKeyAccessed).toBe(false)
  })

  test('rejects and leaves no temp dir when Codex preflight fails', async () => {
    await fs.chmod(fakeCodexPath, 0o700)
    const { cwd } = await createBookFixture()

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ASIN: 'TESTASIN',
      CODEX_BIN: fakeCodexPath,
      // `codex login status` exits non-zero, so preflight must fail before
      // any batch, temp directory, or checkpoint is ever created.
      FAKE_CODEX_SCENARIO: 'login-unauthenticated'
    }

    const tmpEntriesBefore = await fs.readdir(os.tmpdir())

    await expect(processBook({ cwd, env })).rejects.toThrow(
      /Codex preflight failed/
    )

    const tmpEntriesAfter = await fs.readdir(os.tmpdir())
    const leftoverCodexTempDirs = tmpEntriesAfter.filter(
      (entry) =>
        entry.startsWith('kindle-codex-') && !tmpEntriesBefore.includes(entry)
    )
    expect(leftoverCodexTempDirs).toEqual([])
  })
})
