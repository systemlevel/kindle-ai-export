/* eslint-disable no-process-env */

import type { Readable } from 'node:stream'
import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type {
  ProcessingFailure,
  ProcessingFailureCategory,
  RawCodexBatch
} from './types'
import { createProcessingFailure } from './failures'
import { validateRawCodexBatch } from './validate-codex-output'

const defaultTimeoutMs = 300_000
const defaultTerminationGraceMs = 5000
const defaultStdoutMaxBytes = 8 * 1024 * 1024
const defaultStderrMaxBytes = 1024 * 1024
const maximumDiagnosticSampleBytes = 4096
const unwrittenResultMarker = '__CODEX_RESULT_NOT_WRITTEN__'

export interface CodexBatchInput {
  runId: string
  batchId: string
  temporaryRoot: string
  pageIds: readonly string[]
  imagePaths: readonly string[]
  outputSchemaPath: string
  prompt: string
  model?: string
}

export interface CodexRunnerOptions {
  codexBin: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  terminationGraceMs?: number
  stdoutMaxBytes?: number
  stderrMaxBytes?: number
  signal?: AbortSignal
}

export interface CodexExecution {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdoutBytes: number
  stderrBytes: number
  turnCompleted: boolean
}

export type CodexRunResult =
  | { ok: true; output: RawCodexBatch; execution: CodexExecution }
  | { ok: false; failure: ProcessingFailure; execution: CodexExecution }

export interface CodexInstallation {
  cliVersion: string
  authentication: 'chatgpt' | 'api-key' | 'unknown'
}

export type CodexInstallationResult =
  | { ok: true; installation: CodexInstallation }
  | { ok: false; failure: ProcessingFailure }

interface ProcessLimits {
  timeoutMs: number
  terminationGraceMs: number
  stdoutMaxBytes: number
  stderrMaxBytes: number
  signal?: AbortSignal
}

interface CollectedProcess extends CodexExecution {
  stdout: string
  stderr: string
  lastTerminalEvent: 'turn.completed' | 'turn.failed' | null
  terminalMessage: string | null
  overflow: 'stdout' | 'stderr' | null
  endedBy: 'timeout' | 'cancelled' | null
  spawnError: Error | null
  malformedJsonl: boolean
}

export async function inspectCodexInstallation(
  codexBin: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<CodexInstallationResult> {
  const limits = defaultLimits()
  const version = await runCommand(codexBin, ['--version'], env, limits)
  if (version.spawnError || version.exitCode !== 0 || version.overflow) {
    return installationFailure('version-failed', version)
  }

  const cliVersion = parseCliVersion(version.stdout)
  if (!cliVersion) {
    return installationFailure('invalid-version', version)
  }

  const login = await runCommand(codexBin, ['login', 'status'], env, limits)
  if (login.spawnError || login.exitCode !== 0 || login.overflow) {
    return installationFailure('login-status-failed', login)
  }

  return {
    ok: true,
    installation: {
      cliVersion,
      authentication: parseAuthentication(`${login.stdout} ${login.stderr}`)
    }
  }
}

export async function runCodexBatch(
  input: CodexBatchInput,
  options: CodexRunnerOptions
): Promise<CodexRunResult> {
  const invalidInput = validateInput(input)
  if (invalidInput)
    return failureResult('configuration', 'invalid-input', invalidInput)

  const runDirectory = privateRunDirectory(input)
  try {
    await mkdir(path.dirname(runDirectory), { recursive: true, mode: 0o700 })
    await mkdir(runDirectory, { mode: 0o700 })
  } catch {
    return failureResult(
      'configuration',
      'temporary-storage-failed',
      'Could not create private temporary storage'
    )
  }

  try {
    const resultPath = path.join(runDirectory, 'result.json')
    try {
      await writeFile(resultPath, unwrittenResultMarker, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      })
    } catch {
      return failureResult(
        'configuration',
        'temporary-storage-failed',
        'Could not initialize private result storage'
      )
    }
    const execution = await runCommand(
      options.codexBin,
      buildCodexArgs(input, runDirectory, resultPath),
      options.env ?? process.env,
      limitsFor(options),
      runDirectory
    )
    const executionSummary = executionSummaryOf(execution)
    const executionFailure = failureFromExecution(execution)
    if (executionFailure)
      return {
        ok: false,
        failure: executionFailure,
        execution: executionSummary
      }

    let resultText: string
    try {
      resultText = await readFile(resultPath, 'utf8')
    } catch (err) {
      const code = isMissingFile(err) ? 'missing-output' : 'malformed-output'
      return {
        ok: false,
        failure: createFailure(
          'protocol',
          code,
          outputMessageFor(code),
          execution
        ),
        execution: executionSummary
      }
    }

    if (resultText === unwrittenResultMarker) {
      return {
        ok: false,
        failure: createFailure(
          'protocol',
          'missing-output',
          outputMessageFor('missing-output'),
          execution
        ),
        execution: executionSummary
      }
    }

    let rawResult: unknown
    try {
      rawResult = JSON.parse(resultText)
    } catch {
      return {
        ok: false,
        failure: createFailure(
          'protocol',
          'malformed-output',
          outputMessageFor('malformed-output'),
          execution
        ),
        execution: executionSummary
      }
    }

    try {
      return {
        ok: true,
        output: validateRawCodexBatch(rawResult, input.pageIds),
        execution: executionSummary
      }
    } catch {
      return {
        ok: false,
        failure: createFailure(
          'content-validation',
          'output-validation',
          'Codex output failed local validation',
          execution
        ),
        execution: executionSummary
      }
    }
  } finally {
    await rm(runDirectory, { recursive: true, force: true }).catch(
      () => undefined
    )
  }
}

function buildCodexArgs(
  input: CodexBatchInput,
  runDirectory: string,
  resultPath: string
): string[] {
  const args = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--cd',
    runDirectory
  ]
  for (const imagePath of input.imagePaths) args.push('--image', imagePath)
  args.push('--output-schema', input.outputSchemaPath)
  args.push('--output-last-message', resultPath)
  args.push('--json')
  if (input.model) args.push('--model', input.model)
  args.push(input.prompt)
  return args
}

type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  limits: ProcessLimits,
  cwd?: string
): Promise<CollectedProcess> {
  let child: SpawnedChild
  try {
    child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    return Promise.resolve(emptyCollected(err as Error))
  }
  return collectBoundedProcess(child, limits)
}

function collectBoundedProcess(
  child: SpawnedChild,
  limits: ProcessLimits
): Promise<CollectedProcess> {
  return new Promise((resolve) => {
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdout = ''
    let stderr = ''
    let pendingJsonl = ''
    let turnCompleted = false
    let lastTerminalEvent: CollectedProcess['lastTerminalEvent'] = null
    let terminalMessage: string | null = null
    let overflow: CollectedProcess['overflow'] = null
    let endedBy: CollectedProcess['endedBy'] = null
    let spawnError: Error | null = null
    let malformedJsonl = false
    let settled = false
    let terminationStarted = false

    const consumeJsonlLine = (line: string) => {
      if (!line.trim()) return
      try {
        const event = JSON.parse(line) as {
          type?: string
          error?: { message?: string }
        }
        if (event.type === 'turn.completed') {
          turnCompleted = true
          lastTerminalEvent = 'turn.completed'
        }
        if (event.type === 'turn.failed') {
          lastTerminalEvent = 'turn.failed'
          terminalMessage = event.error?.message ?? null
        }
      } catch {
        malformedJsonl = true
      }
    }

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      consumeJsonlLine(pendingJsonl)
      clearTimeout(timeout)
      clearTimeout(killTimer)
      limits.signal?.removeEventListener('abort', abort)
      resolve({
        exitCode,
        signal,
        stdoutBytes,
        stderrBytes,
        stdout,
        stderr,
        turnCompleted,
        lastTerminalEvent,
        terminalMessage,
        overflow,
        endedBy,
        spawnError,
        malformedJsonl
      })
    }

    const terminate = (reason: 'timeout' | 'cancelled' | 'overflow') => {
      if (terminationStarted) return
      terminationStarted = true
      if (reason === 'overflow') overflow = overflow ?? 'stdout'
      else endedBy = reason
      child.kill('SIGTERM')
      killTimer = setTimeout(
        () => child.kill('SIGKILL'),
        limits.terminationGraceMs
      )
    }

    const timeout = setTimeout(() => terminate('timeout'), limits.timeoutMs)
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const abort = () => terminate('cancelled')
    limits.signal?.addEventListener('abort', abort, { once: true })
    if (limits.signal?.aborted) abort()

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > limits.stdoutMaxBytes) {
        overflow = 'stdout'
        terminate('overflow')
        return
      }
      if (stdout.length < maximumDiagnosticSampleBytes) {
        stdout += chunk
          .toString('utf8')
          .slice(0, maximumDiagnosticSampleBytes - stdout.length)
      }
      pendingJsonl += chunk.toString('utf8')
      const lines = pendingJsonl.split('\n')
      pendingJsonl = lines.pop() ?? ''
      for (const line of lines) consumeJsonlLine(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > limits.stderrMaxBytes) {
        overflow = 'stderr'
        terminate('overflow')
        return
      }
      if (stderr.length < maximumDiagnosticSampleBytes) {
        stderr += chunk
          .toString('utf8')
          .slice(0, maximumDiagnosticSampleBytes - stderr.length)
      }
    })
    child.once('error', (error) => {
      spawnError = error
      finish(null, null)
    })
    child.once('close', finish)
  })
}

function failureFromExecution(
  execution: CollectedProcess
): ProcessingFailure | null {
  if (execution.overflow) {
    return createFailure(
      'diagnostic-overflow',
      `${execution.overflow}-overflow`,
      'Codex diagnostic output exceeded its configured limit',
      execution
    )
  }
  if (execution.endedBy === 'cancelled') {
    return createFailure(
      'cancelled',
      'cancelled',
      'Codex invocation was cancelled',
      execution
    )
  }
  if (execution.endedBy === 'timeout') {
    return createFailure(
      'timeout',
      'timeout',
      'Codex invocation timed out',
      execution
    )
  }
  if (execution.spawnError) {
    return createFailure(
      'configuration',
      'spawn-failed',
      'Could not start the Codex CLI',
      execution
    )
  }
  if (execution.malformedJsonl) {
    return createFailure(
      'protocol',
      'malformed-jsonl',
      'Codex emitted malformed event JSONL',
      execution
    )
  }
  if (execution.lastTerminalEvent === 'turn.failed') {
    const category = classifyServiceFailure(
      execution.terminalMessage ?? execution.stderr
    )
    return createFailure(
      category,
      category === 'transient-service' ? 'service-unavailable' : 'turn-failed',
      category === 'transient-service'
        ? 'Codex service was temporarily unavailable'
        : 'Codex reported a failed turn',
      execution
    )
  }
  if (execution.exitCode !== 0) {
    const category = classifyServiceFailure(execution.stderr)
    return createFailure(
      category,
      category === 'transient-service' ? 'service-unavailable' : 'process-exit',
      category === 'transient-service'
        ? 'Codex service was temporarily unavailable'
        : 'Codex process exited unsuccessfully',
      execution
    )
  }
  if (
    !execution.turnCompleted ||
    execution.lastTerminalEvent !== 'turn.completed'
  ) {
    return createFailure(
      'protocol',
      'missing-turn-completed',
      'Codex did not complete the turn',
      execution
    )
  }
  return null
}

function classifyServiceFailure(message: string): ProcessingFailureCategory {
  const normalized = message.toLowerCase()
  if (
    /rate limit|temporar(?:y|ily)|network|backend|service unavailable|overloaded/.test(
      normalized
    )
  ) {
    return 'transient-service'
  }
  if (/not logged|auth|api key|config/.test(normalized)) return 'configuration'
  return 'protocol'
}

function createFailure(
  category: ProcessingFailureCategory,
  code: string,
  message: string,
  execution: Pick<CollectedProcess, 'exitCode' | 'signal'>
): ProcessingFailure {
  return createProcessingFailure({
    category,
    code,
    message,
    attempts: 1,
    occurredAt: new Date().toISOString(),
    exitCode: execution.exitCode,
    signal: execution.signal
  })
}

function failureResult(
  category: ProcessingFailureCategory,
  code: string,
  message: string
): CodexRunResult {
  const execution = executionSummaryOf(emptyCollected(null))
  return {
    ok: false,
    failure: createFailure(category, code, message, execution),
    execution
  }
}

function installationFailure(
  code: string,
  execution: CollectedProcess
): CodexInstallationResult {
  return {
    ok: false,
    failure: createFailure(
      'configuration',
      code,
      'Codex CLI installation check failed',
      execution
    )
  }
}

function defaultLimits(): ProcessLimits {
  return {
    timeoutMs: defaultTimeoutMs,
    terminationGraceMs: defaultTerminationGraceMs,
    stdoutMaxBytes: defaultStdoutMaxBytes,
    stderrMaxBytes: defaultStderrMaxBytes
  }
}

function limitsFor(options: CodexRunnerOptions): ProcessLimits {
  return {
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
    terminationGraceMs: options.terminationGraceMs ?? defaultTerminationGraceMs,
    stdoutMaxBytes: options.stdoutMaxBytes ?? defaultStdoutMaxBytes,
    stderrMaxBytes: options.stderrMaxBytes ?? defaultStderrMaxBytes,
    signal: options.signal
  }
}

function privateRunDirectory(input: CodexBatchInput): string {
  return path.resolve(
    input.temporaryRoot,
    '.codex-tmp',
    input.runId,
    input.batchId
  )
}

function validateInput(input: CodexBatchInput): string | null {
  if (!isSafeIdentifier(input.runId) || !isSafeIdentifier(input.batchId))
    return 'Invalid run identifier'
  if (
    input.pageIds.length === 0 ||
    input.pageIds.length !== input.imagePaths.length
  ) {
    return 'Page input is incomplete'
  }
  if (
    !path.isAbsolute(input.temporaryRoot) ||
    !path.isAbsolute(input.outputSchemaPath)
  ) {
    return 'Private storage and schema paths must be absolute'
  }
  if (input.imagePaths.some((imagePath) => !path.isAbsolute(imagePath))) {
    return 'Image paths must be absolute'
  }
  return null
}

function isSafeIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes(path.sep)
  )
}

function parseCliVersion(stdout: string): string | null {
  return stdout.match(/\bcodex(?:-cli)?\s+v?(\d+\.\d+\.\d+)\b/i)?.[1] ?? null
}

function parseAuthentication(
  value: string
): CodexInstallation['authentication'] {
  if (/chatgpt/i.test(value)) return 'chatgpt'
  if (/api[ -]?key/i.test(value)) return 'api-key'
  return 'unknown'
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

function outputMessageFor(code: 'missing-output' | 'malformed-output'): string {
  return code === 'missing-output'
    ? 'Codex did not produce a result file'
    : 'Codex result file was not valid JSON'
}

function executionSummaryOf(
  execution: Pick<CollectedProcess, keyof CodexExecution>
): CodexExecution {
  return {
    exitCode: execution.exitCode,
    signal: execution.signal,
    stdoutBytes: execution.stdoutBytes,
    stderrBytes: execution.stderrBytes,
    turnCompleted: execution.turnCompleted
  }
}

function emptyCollected(error: Error | null): CollectedProcess {
  return {
    exitCode: null,
    signal: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    turnCompleted: false,
    stdout: '',
    stderr: '',
    lastTerminalEvent: null,
    terminalMessage: null,
    overflow: null,
    endedBy: null,
    spawnError: error,
    malformedJsonl: false
  }
}
