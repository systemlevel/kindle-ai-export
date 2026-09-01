/* eslint-disable no-process-env */

import type { Readable } from 'node:stream'
import { type ChildProcessByStdio, spawn } from 'node:child_process'

/**
 * Bounded, cancellable execution of an external CLI (Codex, Claude Code) for
 * the page analyzers. Never rejects: every outcome (spawn failure, timeout,
 * output overflow, non-zero exit) is reported in the result so callers can
 * produce a precise error message.
 *
 * Discipline shared with the batch-scheduler Codex runner: `shell: false`,
 * stdin closed, stdout/stderr byte-capped, SIGTERM then SIGKILL on timeout.
 */
export interface CliProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  /** Grace period between SIGTERM and SIGKILL. Default 5 s. */
  terminationGraceMs?: number
  /** Default 8 MiB. */
  stdoutMaxBytes?: number
  /** Default 1 MiB. */
  stderrMaxBytes?: number
}

export interface CliProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  overflow: 'stdout' | 'stderr' | null
  spawnError: Error | null
  durationMs: number
}

const defaultTerminationGraceMs = 5000
const defaultStdoutMaxBytes = 8 * 1024 * 1024
const defaultStderrMaxBytes = 1024 * 1024

type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>

export function runCliProcess(
  command: string,
  args: readonly string[],
  options: CliProcessOptions
): Promise<CliProcessResult> {
  const started = Date.now()
  const stdoutMaxBytes = options.stdoutMaxBytes ?? defaultStdoutMaxBytes
  const stderrMaxBytes = options.stderrMaxBytes ?? defaultStderrMaxBytes
  const terminationGraceMs =
    options.terminationGraceMs ?? defaultTerminationGraceMs

  let child: SpawnedChild
  try {
    child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    return Promise.resolve({
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      overflow: null,
      spawnError: err as Error,
      durationMs: Date.now() - started
    })
  }

  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let overflow: CliProcessResult['overflow'] = null
    let spawnError: Error | null = null
    let settled = false
    let terminationStarted = false
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const terminate = () => {
      if (terminationStarted) return
      terminationStarted = true
      try {
        child.kill('SIGTERM')
      } catch {}
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
      }, terminationGraceMs)
    }

    const timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, options.timeoutMs)

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        overflow,
        spawnError,
        durationMs: Date.now() - started
      })
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > stdoutMaxBytes) {
        overflow = overflow ?? 'stdout'
        terminate()
        return
      }
      stdoutChunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > stderrMaxBytes) {
        overflow = overflow ?? 'stderr'
        terminate()
        return
      }
      stderrChunks.push(chunk)
    })
    child.once('error', (error) => {
      spawnError = error
      finish(null, null)
    })
    child.once('close', finish)
  })
}

/** First ~1000 characters of a diagnostic stream with whitespace collapsed,
 * suitable for one-line error messages. */
export function diagnosticSample(text: string, maxLength = 1000): string {
  return text.replaceAll(/\s+/g, ' ').trim().slice(0, maxLength)
}
