/* eslint-disable no-process-env */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createCodexPageAnalyzer } from '../../src/book-processing/codex-page-analyzer'
import {
  pageAnalysisOutputSchema,
  pageAnalysisPrompt
} from '../../src/book-processing/page-analysis'

const fixturePath = path.resolve('test/fixtures/fake-codex.mjs')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

async function fixture(scenario: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-analyzer-'))
  temporaryDirectories.push(root)
  await fs.chmod(fixturePath, 0o700)
  const pngPath = path.join(root, 'page-0001.png')
  await fs.writeFile(pngPath, 'synthetic page')
  const argumentLogPath = path.join(root, 'arguments.json')
  const env = {
    ...process.env,
    FAKE_CODEX_SCENARIO: scenario,
    FAKE_CODEX_ARGUMENT_LOG: argumentLogPath
  }
  return { pngPath, argumentLogPath, env }
}

describe('createCodexPageAnalyzer', () => {
  test('describes its identity for logs and page stamps', () => {
    const analyzer = createCodexPageAnalyzer({
      codexBin: fixturePath,
      model: 'gpt-5',
      reasoningEffort: 'xhigh',
      timeoutMs: 1000
    })
    expect(analyzer.backend).toBe('codex')
    expect(analyzer.identity).toEqual({
      backend: 'codex',
      model: 'gpt-5',
      effort: 'xhigh'
    })
    expect(analyzer.describe()).toContain('xhigh')
  })

  test('preflight passes when the CLI is installed and logged in', async () => {
    const { env } = await fixture('page-analysis')
    const analyzer = createCodexPageAnalyzer({
      codexBin: fixturePath,
      reasoningEffort: 'xhigh',
      timeoutMs: 5000,
      env
    })
    await expect(analyzer.preflight()).resolves.toBeUndefined()
  })

  test('preflight fails when the CLI is not authenticated', async () => {
    const { env } = await fixture('login-unauthenticated')
    const analyzer = createCodexPageAnalyzer({
      codexBin: fixturePath,
      reasoningEffort: 'xhigh',
      timeoutMs: 5000,
      env
    })
    await expect(analyzer.preflight()).rejects.toThrow(/codex login/)
  })

  test('invokes codex exec with the verified read-only argument set', async () => {
    const { pngPath, argumentLogPath, env } = await fixture('page-analysis')
    const analyzer = createCodexPageAnalyzer({
      codexBin: fixturePath,
      model: 'gpt-5',
      reasoningEffort: 'xhigh',
      timeoutMs: 5000,
      env
    })

    await analyzer.analyzePage(pngPath)

    const args = JSON.parse(
      await fs.readFile(argumentLogPath, 'utf8')
    ) as string[]
    const flagValue = (flag: string) => args[args.indexOf(flag) + 1]
    expect(args.slice(0, 7)).toEqual([
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only'
    ])
    expect(flagValue('--image')).toBe(pngPath)
    expect(flagValue('--model')).toBe('gpt-5')
    expect(args).toContain('--json')
    expect(flagValue('-c')).toBe('model_reasoning_effort=xhigh')
    const schemaPath = flagValue('--output-schema')!
    expect(
      JSON.parse(await fs.readFile(schemaPath, 'utf8').catch(() => 'null'))
    ).toBeNull()
    expect(args.at(-1)).toBe(pageAnalysisPrompt)
    expect(schemaPath).toMatch(/schema\.json$/)
    expect(flagValue('--cd')).toBe(path.dirname(schemaPath))
  })

  test('returns the parsed page result from the output file', async () => {
    const { pngPath, env } = await fixture('page-analysis')
    const analyzer = createCodexPageAnalyzer({
      codexBin: fixturePath,
      reasoningEffort: 'xhigh',
      timeoutMs: 5000,
      env
    })
    await expect(analyzer.analyzePage(pngPath)).resolves.toEqual({
      text: 'Codex page text',
      visuals: [{ kind: 'formula', description: 'E = mc^2', region: null }]
    })
  })

  test('rejects when codex does not write an output file', async () => {
    const { pngPath, env } = await fixture('missing-output')
    const analyzer = createCodexPageAnalyzer({
      codexBin: fixturePath,
      reasoningEffort: 'xhigh',
      timeoutMs: 5000,
      env
    })
    await expect(analyzer.analyzePage(pngPath)).rejects.toThrow(
      /did not write an output file/
    )
  })

  test('rejects on a non-zero exit with the stderr sample', async () => {
    const { pngPath, env } = await fixture('nonzero')
    const analyzer = createCodexPageAnalyzer({
      codexBin: fixturePath,
      reasoningEffort: 'xhigh',
      timeoutMs: 5000,
      env
    })
    await expect(analyzer.analyzePage(pngPath)).rejects.toThrow(
      /exited with code 2.*fake process error/
    )
  })

  test('surfaces the turn.failed reason when the model is unsupported', async () => {
    const { pngPath, env } = await fixture('turn-failed-model')
    const analyzer = createCodexPageAnalyzer({
      codexBin: fixturePath,
      model: 'not-a-real-model',
      reasoningEffort: 'xhigh',
      timeoutMs: 5000,
      env
    })
    const failure = await analyzer
      .analyzePage(pngPath)
      .catch((err: Error) => err)
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toMatch(
      /'not-a-real-model' model is not supported when using Codex/
    )
    expect(message).not.toMatch(/cache TTL|stdin/)
  })

  test('terminates a hung process after the timeout', async () => {
    const { pngPath, env } = await fixture('hang-ignore-term')
    const analyzer = createCodexPageAnalyzer({
      codexBin: fixturePath,
      reasoningEffort: 'xhigh',
      timeoutMs: 300,
      terminationGraceMs: 100,
      env
    })
    await expect(analyzer.analyzePage(pngPath)).rejects.toThrow(/timed out/)
  })

  test('writes the shared output schema for codex to validate against', async () => {
    const { pngPath, env } = await fixture('page-analysis')
    const schemaCopyPath = path.join(path.dirname(pngPath), 'schema-copy.json')
    const analyzer = createCodexPageAnalyzer({
      codexBin: fixturePath,
      reasoningEffort: 'xhigh',
      timeoutMs: 5000,
      env: { ...env, FAKE_CODEX_SCHEMA_COPY: schemaCopyPath }
    })
    await analyzer.analyzePage(pngPath)
    expect(JSON.parse(await fs.readFile(schemaCopyPath, 'utf8'))).toEqual(
      pageAnalysisOutputSchema
    )
  })
})
