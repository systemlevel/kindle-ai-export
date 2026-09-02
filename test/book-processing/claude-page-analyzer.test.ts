/* eslint-disable no-process-env */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, test } from 'vitest'

import { createClaudePageAnalyzer } from '../../src/book-processing/claude-page-analyzer'
import {
  PageAnalysisError,
  pageAnalysisOutputSchema,
  pageAnalysisPrompt
} from '../../src/book-processing/page-analysis'

const fixturePath = path.resolve('test/fixtures/fake-claude.mjs')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

async function fixture(scenario: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-analyzer-'))
  temporaryDirectories.push(root)
  const pngPath = path.join(root, 'page-0001.png')
  await fs.writeFile(
    pngPath,
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    })
      .png()
      .toBuffer()
  )
  const argumentLogPath = path.join(root, 'arguments.json')
  const pidPath = path.join(root, 'fake-claude.pid')
  const env = {
    ...process.env,
    FAKE_CLAUDE_SCENARIO: scenario,
    FAKE_CLAUDE_ARGUMENT_LOG: argumentLogPath,
    FAKE_CLAUDE_PID_PATH: pidPath
  }
  return { root, pngPath, argumentLogPath, pidPath, env }
}

async function loggedArguments(argumentLogPath: string): Promise<string[]> {
  return JSON.parse(await fs.readFile(argumentLogPath, 'utf8')) as string[]
}

describe('createClaudePageAnalyzer', () => {
  test('describes its identity for logs and page stamps', () => {
    const analyzer = createClaudePageAnalyzer({
      claudeBin: fixturePath,
      model: 'opus',
      effort: 'xhigh',
      timeoutMs: 1000
    })
    expect(analyzer.backend).toBe('claude')
    expect(analyzer.identity).toEqual({
      backend: 'claude',
      model: 'opus',
      effort: 'xhigh'
    })
    expect(analyzer.describe()).toContain('opus')
    expect(analyzer.describe()).toContain('xhigh')
  })

  test('preflight passes when the CLI is installed and logged in', async () => {
    const { env } = await fixture('success')
    const analyzer = createClaudePageAnalyzer({
      claudeBin: fixturePath,
      timeoutMs: 5000,
      env
    })
    await expect(analyzer.preflight()).resolves.toBeUndefined()
  })

  test('preflight fails with a login hint when not authenticated', async () => {
    const { env } = await fixture('not-logged-in')
    const analyzer = createClaudePageAnalyzer({
      claudeBin: fixturePath,
      timeoutMs: 5000,
      env
    })
    await expect(analyzer.preflight()).rejects.toThrow(/claude auth login/)
  })

  test('preflight fails when the binary cannot be started', async () => {
    const analyzer = createClaudePageAnalyzer({
      claudeBin: path.join(os.tmpdir(), 'definitely-not-a-claude-binary'),
      timeoutMs: 5000
    })
    await expect(analyzer.preflight()).rejects.toThrow(/could not run/i)
  })

  test('invokes claude -p in a locked-down print mode with the page image', async () => {
    const { pngPath, argumentLogPath, env } = await fixture('success')
    const analyzer = createClaudePageAnalyzer({
      claudeBin: fixturePath,
      model: 'opus',
      effort: 'high',
      timeoutMs: 5000,
      env
    })

    await analyzer.analyzePage(pngPath)

    const args = await loggedArguments(argumentLogPath)
    const flagValue = (flag: string) => args[args.indexOf(flag) + 1]
    expect(args[0]).toBe('-p')
    expect(flagValue('--output-format')).toBe('json')
    expect(JSON.parse(flagValue('--json-schema')!)).toEqual(
      pageAnalysisOutputSchema
    )
    expect(flagValue('--tools')).toBe('Read')
    expect(flagValue('--allowedTools')).toBe('Read')
    expect(flagValue('--permission-mode')).toBe('dontAsk')
    expect(flagValue('--add-dir')).toBe(path.dirname(pngPath))
    expect(flagValue('--model')).toBe('opus')
    expect(flagValue('--effort')).toBe('high')
    for (const flag of [
      '--safe-mode',
      '--strict-mcp-config',
      '--no-session-persistence'
    ]) {
      expect(args, flag).toContain(flag)
    }
    const prompt = args.at(-1)!
    expect(prompt).toContain(pageAnalysisPrompt)
    expect(prompt).toContain(pngPath)
    expect(prompt).toMatch(/Read tool/)
  })

  test('omits --model and --effort when they are not configured', async () => {
    const { pngPath, argumentLogPath, env } = await fixture('success')
    const analyzer = createClaudePageAnalyzer({
      claudeBin: fixturePath,
      timeoutMs: 5000,
      env
    })
    await analyzer.analyzePage(pngPath)
    const args = await loggedArguments(argumentLogPath)
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--effort')
    expect(analyzer.identity).toEqual({
      backend: 'claude',
      model: null,
      effort: null
    })
  })

  test('returns the structured output as the page result', async () => {
    const { pngPath, env } = await fixture('success')
    const analyzer = createClaudePageAnalyzer({
      claudeBin: fixturePath,
      timeoutMs: 5000,
      env
    })
    await expect(analyzer.analyzePage(pngPath)).resolves.toEqual({
      text: 'Claude page text',
      visuals: [
        {
          kind: 'chart',
          description: 'A rising line chart.',
          region: { x: 100, y: 200, width: 300, height: 400 }
        }
      ]
    })
  })

  test('falls back to parsing the result text when structured output is absent', async () => {
    const { pngPath, env } = await fixture('result-text-json')
    const analyzer = createClaudePageAnalyzer({
      claudeBin: fixturePath,
      timeoutMs: 5000,
      env
    })
    const result = await analyzer.analyzePage(pngPath)
    expect(result.text).toBe('Claude page text')
    expect(result.visuals).toHaveLength(1)
  })

  test('keeps plain-text results as text with no visuals', async () => {
    const { pngPath, env } = await fixture('result-plain-text')
    const analyzer = createClaudePageAnalyzer({
      claudeBin: fixturePath,
      timeoutMs: 5000,
      env
    })
    await expect(analyzer.analyzePage(pngPath)).resolves.toEqual({
      text: 'Just some transcribed prose.',
      visuals: []
    })
  })

  test('rejects when the CLI reports an error result', async () => {
    const { pngPath, env } = await fixture('is-error')
    const analyzer = createClaudePageAnalyzer({
      claudeBin: fixturePath,
      timeoutMs: 5000,
      env
    })
    const failure = await analyzer
      .analyzePage(pngPath)
      .catch((err: Error) => err)
    expect(failure).toBeInstanceOf(PageAnalysisError)
    expect((failure as PageAnalysisError).message).toMatch(
      /Failed to authenticate/
    )
    // An auth failure will not fix itself between attempts.
    expect((failure as PageAnalysisError).retryable).toBe(false)
  })

  test('rejects when the result subtype is not success', async () => {
    const { pngPath, env } = await fixture('error-subtype')
    const analyzer = createClaudePageAnalyzer({
      claudeBin: fixturePath,
      timeoutMs: 5000,
      env
    })
    await expect(analyzer.analyzePage(pngPath)).rejects.toThrow(
      /error_max_turns/
    )
  })

  test('rejects on a non-zero exit with the stderr sample', async () => {
    const { pngPath, env } = await fixture('nonzero')
    const analyzer = createClaudePageAnalyzer({
      claudeBin: fixturePath,
      timeoutMs: 5000,
      env
    })
    await expect(analyzer.analyzePage(pngPath)).rejects.toThrow(
      /exited with code 2.*fake claude process error/
    )
  })

  test('rejects when stdout is not a JSON result envelope', async () => {
    const { pngPath, env } = await fixture('malformed')
    const analyzer = createClaudePageAnalyzer({
      claudeBin: fixturePath,
      timeoutMs: 5000,
      env
    })
    await expect(analyzer.analyzePage(pngPath)).rejects.toThrow(/JSON/)
  })

  test('terminates a hung process after the timeout', async () => {
    const { pngPath, pidPath, env } = await fixture('hang')
    const analyzer = createClaudePageAnalyzer({
      claudeBin: fixturePath,
      timeoutMs: 300,
      terminationGraceMs: 100,
      env
    })
    await expect(analyzer.analyzePage(pngPath)).rejects.toThrow(/timed out/)
    const pid = Number(await fs.readFile(pidPath, 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
