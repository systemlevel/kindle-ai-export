/* eslint-disable no-process-env */

import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  classifyServiceFailure,
  type CodexBatchInput,
  inspectCodexInstallation,
  runCodexBatch
} from '../../src/book-processing/codex-runner'
import {
  createProcessingFailure,
  sanitizeDiagnostic
} from '../../src/book-processing/failures'

const fixturePath = path.resolve('test/fixtures/fake-codex.mjs')
const schemaPath = path.resolve('src/book-processing/codex-output.schema.json')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

async function runScenario(
  scenario: string,
  overrides: Partial<Parameters<typeof runCodexBatch>[1]> = {},
  onPidPath?: (pidPath: string) => void
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-runner-test-'))
  temporaryDirectories.push(root)
  await chmod(fixturePath, 0o700)

  const pagePaths = [
    path.join(root, 'page-a.png'),
    path.join(root, 'page-b.png')
  ]
  await Promise.all(
    pagePaths.map((pagePath) => writeFile(pagePath, 'synthetic page'))
  )
  const argumentLogPath = path.join(root, 'arguments.json')
  const pidPath = path.join(root, 'fake-codex.pid')
  onPidPath?.(pidPath)
  const input: CodexBatchInput = {
    runId: 'run-1',
    batchId: 'batch-1',
    temporaryRoot: root,
    pageIds: ['c000000', 'c000001'],
    imagePaths: pagePaths,
    outputSchemaPath: schemaPath,
    prompt: 'Analyze exactly these page IDs in order: c000000, c000001'
  }
  const options = {
    codexBin: fixturePath,
    env: {
      ...process.env,
      FAKE_CODEX_SCENARIO: scenario,
      FAKE_CODEX_ARGUMENT_LOG: argumentLogPath,
      FAKE_CODEX_PID_PATH: pidPath
    },
    timeoutMs: 100,
    terminationGraceMs: 50,
    stdoutMaxBytes: 1024,
    stderrMaxBytes: 1024,
    ...overrides
  }

  const result = await runCodexBatch(input, options)
  return { argumentLogPath, input, pidPath, result, root }
}

async function readArgumentLog(argumentLogPath: string): Promise<string[]> {
  return JSON.parse(await readFile(argumentLogPath, 'utf8')) as string[]
}

async function expectFakeProcessExited(pidPath: string): Promise<void> {
  const pid = Number(await readFile(pidPath, 'utf8'))
  expect(() => process.kill(pid, 0)).toThrow()
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(filePath)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  throw new Error('Fake Codex did not start')
}

describe('failure diagnostics', () => {
  test('redacts secrets and caps failures to a single safe line', () => {
    const failure = createProcessingFailure({
      category: 'configuration',
      code: 'login-failed',
      message: `token=top-secret\n${'x'.repeat(2000)}`,
      secrets: ['top-secret'],
      attempts: 1,
      occurredAt: '2026-08-27T00:00:00.000Z',
      exitCode: 1,
      signal: null
    })

    expect(failure.message).toContain('[REDACTED]')
    expect(failure.message).not.toContain('top-secret')
    expect(failure.message).not.toContain('\n')
    expect(failure.message.length).toBeLessThanOrEqual(1000)
    expect(sanitizeDiagnostic('a\r\nb', [])).toBe('a b')
  })
})

describe('classifyServiceFailure', () => {
  test.each([
    // Regression guard: `--ignore-user-config` must NOT be treated as a
    // configuration fault, which would abort the whole run.
    ['--ignore-user-config', 'protocol'],
    ['unknown flag --ignore-user-config', 'protocol'],
    ['some unexpected parse error', 'protocol'],
    [
      'failed to renew cache TTL: missing field `supports_parallel_tool_calls`',
      'transient-service'
    ],
    ['failed to load models cache', 'transient-service'],
    ['ECONNRESET', 'transient-service'],
    ['socket hang up', 'transient-service'],
    ['429 Too Many Requests', 'transient-service'],
    ['503 Service Unavailable', 'transient-service'],
    ['rate limit exceeded', 'transient-service'],
    ['Not logged in', 'configuration'],
    ['invalid api key', 'configuration']
  ] as const)('classifies %j as %s', (message, category) => {
    expect(classifyServiceFailure(message)).toBe(category)
  })
})

describe('inspectCodexInstallation', () => {
  test('checks a parseable version and authenticated login without a shell', async () => {
    await chmod(fixturePath, 0o700)
    const result = await inspectCodexInstallation(fixturePath, {
      ...process.env,
      FAKE_CODEX_SCENARIO: 'success'
    })

    expect(result).toEqual({
      ok: true,
      installation: { cliVersion: '0.147.0', authentication: 'chatgpt' }
    })
  })

  test('returns a typed configuration failure for an unauthenticated login', async () => {
    await chmod(fixturePath, 0o700)
    const result = await inspectCodexInstallation(fixturePath, {
      ...process.env,
      FAKE_CODEX_SCENARIO: 'login-unauthenticated'
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { category: 'configuration', code: 'login-status-failed' }
    })
  })
})

describe('runCodexBatch', () => {
  test('passes private, noninteractive Codex arguments in image order', async () => {
    const { argumentLogPath, input, result, root } =
      await runScenario('success')

    expect(result.ok).toBe(true)
    expect(await readArgumentLog(argumentLogPath)).toEqual([
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--cd',
      path.join(root, '.codex-tmp', 'run-1', 'batch-1'),
      '--image',
      input.imagePaths[0],
      '--image',
      input.imagePaths[1],
      '--output-schema',
      schemaPath,
      '--output-last-message',
      path.join(root, '.codex-tmp', 'run-1', 'batch-1', 'result.json'),
      '--json',
      'Analyze exactly these page IDs in order: c000000, c000001'
    ])
    await expect(
      readFile(path.join(root, '.codex-tmp', 'run-1', 'batch-1'))
    ).rejects.toThrow()
  })

  test('requires turn.completed even when the child exits zero', async () => {
    const { result } = await runScenario('turn-failed-exit-zero')
    expect(result).toMatchObject({
      ok: false,
      failure: { category: 'protocol', code: 'turn-failed' }
    })
  })

  test.each([
    ['missing-output', 'protocol', 'missing-output'],
    ['malformed-output', 'protocol', 'malformed-output'],
    ['wrong-page-ids', 'content-validation', 'output-validation'],
    ['nonzero', 'protocol', 'process-exit'],
    ['rate-limit', 'transient-service', 'service-unavailable'],
    ['stderr-overflow', 'diagnostic-overflow', 'stderr-overflow'],
    ['stdout-overflow', 'diagnostic-overflow', 'stdout-overflow'],
    ['result-overflow', 'diagnostic-overflow', 'result-overflow']
  ])(
    'returns a bounded typed failure for %s',
    async (scenario, category, code) => {
      const { result } = await runScenario(scenario)
      expect(result).toMatchObject({ ok: false, failure: { category, code } })
    }
  )

  test('rejects an oversized result file without parsing its contents', async () => {
    // The fake Codex writes a result file full of non-JSON bytes ('x'
    // repeated) that exceeds stdoutMaxBytes. If the runner ever read and
    // JSON.parse'd it, that would surface as a 'malformed-output' failure
    // instead of the overflow rejected here before any read occurs.
    const { result } = await runScenario('result-overflow')
    expect(result).toMatchObject({
      ok: false,
      failure: { category: 'diagnostic-overflow', code: 'result-overflow' }
    })
    if (!result.ok) {
      expect(result.failure.code).not.toBe('malformed-output')
      expect(result.failure.message).not.toContain('x'.repeat(32))
    }
  })

  test('terminates a hung process after the timeout', async () => {
    const { pidPath, result } = await runScenario('hang-ignore-term', {
      timeoutMs: 50
    })
    expect(result).toMatchObject({
      ok: false,
      failure: { category: 'timeout', code: 'timeout' }
    })
    await expectFakeProcessExited(pidPath)
  })

  test('terminates a hung process when its abort signal is cancelled', async () => {
    const controller = new AbortController()
    let resolvePidPath: ((pidPath: string) => void) | undefined
    const pidReady = new Promise<string>((resolve) => {
      resolvePidPath = resolve
    })
    const invocation = runScenario(
      'hang-term',
      { signal: controller.signal },
      (pidPath) => resolvePidPath?.(pidPath)
    )
    const pidPath = await pidReady
    await waitForFile(pidPath)
    controller.abort()
    const { result } = await invocation
    expect(result).toMatchObject({
      ok: false,
      failure: { category: 'cancelled', code: 'cancelled' }
    })
    await expectFakeProcessExited(pidPath)
  })
})
