/* eslint-disable no-process-env */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, test } from 'vitest'

import { analyzeBook } from '../../src/analyze-book-text'

const fakeClaudePath = path.resolve('test/fixtures/fake-claude.mjs')
const fakeCodexPath = path.resolve('test/fixtures/fake-codex.mjs')
const temporaryDirectories: string[] = []
const silentLog = { info: () => undefined, warn: () => undefined }

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

async function createBookFixture(pageCount: number): Promise<{
  cwd: string
  outDir: string
  captureDir: string
}> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'analyze-book-'))
  temporaryDirectories.push(cwd)
  const outDir = path.join(cwd, 'out', 'TESTASIN')
  const captureDir = path.join(outDir, 'text-capture')
  await fs.mkdir(captureDir, { recursive: true })
  const png = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  })
    .png()
    .toBuffer()
  for (let page = 1; page <= pageCount; page++) {
    await fs.writeFile(
      path.join(captureDir, `page-${`${page}`.padStart(4, '0')}.png`),
      png
    )
  }
  return { cwd, outDir, captureDir }
}

/** The ambient environment (e.g. a terminal inside Claude Code) may already
 * carry analyzer knobs; strip them so the tests only see their own settings. */
const analyzerVariables = [
  'ANALYZER',
  'REPROCESS',
  'PAGES',
  'CODEX_BIN',
  'CODEX_MODEL',
  'CODEX_REASONING_EFFORT',
  'CODEX_TIMEOUT_MS',
  'CLAUDE_CLI_BIN',
  'CLAUDE_CLI_MODEL',
  'CLAUDE_CLI_EFFORT',
  'CLAUDE_CLI_TIMEOUT_MS'
]

function baseEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of analyzerVariables) delete env[name]
  return { ...env, ASIN: 'TESTASIN', ...overrides }
}

describe('analyzeBook', () => {
  test('requires ASIN', async () => {
    const { cwd } = await createBookFixture(1)
    const env = baseEnv({})
    delete env.ASIN
    await expect(analyzeBook({ cwd, env, log: silentLog })).rejects.toThrow(
      /ASIN/
    )
  })

  test('fails fast when the book has no capture directory', async () => {
    const { cwd } = await createBookFixture(0)
    await fs.rm(path.join(cwd, 'out', 'TESTASIN', 'text-capture'), {
      recursive: true
    })
    await expect(
      analyzeBook({
        cwd,
        env: baseEnv({ CODEX_BIN: fakeCodexPath }),
        log: silentLog
      })
    ).rejects.toThrow(/text-capture/)
  })

  test('analyzes captured pages with the Claude Code CLI backend', async () => {
    const { cwd, outDir, captureDir } = await createBookFixture(2)

    const result = await analyzeBook({
      cwd,
      env: baseEnv({
        ANALYZER: 'claude',
        CLAUDE_CLI_BIN: fakeClaudePath,
        FAKE_CLAUDE_SCENARIO: 'success'
      }),
      log: silentLog
    })

    expect(result.asin).toBe('TESTASIN')
    expect(result.backend).toBe('claude')
    expect(result.summary).toMatchObject({
      pageCount: 2,
      analyzed: 2,
      reused: 0,
      failed: 0
    })
    const markdown = await fs.readFile(
      path.join(outDir, 'book-text.md'),
      'utf8'
    )
    expect(markdown).toContain('Claude page text')
    expect(markdown).toContain('> **Chart (page 1):** A rising line chart.')
    const pageJson = JSON.parse(
      await fs.readFile(path.join(captureDir, 'page-0001.json'), 'utf8')
    ) as { analyzer: { backend: string; effort: string | null } }
    expect(pageJson.analyzer.backend).toBe('claude')
    expect(pageJson.analyzer.effort).toBe('high')
  })

  test('reprocesses existing results with the Codex backend', async () => {
    const { cwd, outDir, captureDir } = await createBookFixture(1)
    await fs.writeFile(
      path.join(captureDir, 'page-0001.json'),
      JSON.stringify({ text: 'stale text', visuals: [] })
    )

    const result = await analyzeBook({
      cwd,
      env: baseEnv({
        CODEX_BIN: fakeCodexPath,
        FAKE_CODEX_SCENARIO: 'page-analysis',
        REPROCESS: '1'
      }),
      log: silentLog
    })

    expect(result.backend).toBe('codex')
    expect(result.summary).toMatchObject({ analyzed: 1, reused: 0 })
    const markdown = await fs.readFile(
      path.join(outDir, 'book-text.md'),
      'utf8'
    )
    expect(markdown).toContain('Codex page text')
    expect(markdown).not.toContain('stale text')
  })

  test('fails before touching pages when the backend preflight fails', async () => {
    const { cwd, captureDir } = await createBookFixture(1)

    await expect(
      analyzeBook({
        cwd,
        env: baseEnv({
          ANALYZER: 'claude',
          CLAUDE_CLI_BIN: fakeClaudePath,
          FAKE_CLAUDE_SCENARIO: 'not-logged-in'
        }),
        log: silentLog
      })
    ).rejects.toThrow(/claude auth login/)
    await expect(
      fs.access(path.join(captureDir, 'page-0001.json'))
    ).rejects.toThrow()
  })
})
