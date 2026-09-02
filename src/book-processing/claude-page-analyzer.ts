/* eslint-disable no-process-env */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { diagnosticSample, runCliProcess } from './cli-process'
import { classifyServiceFailure } from './codex-runner'
import {
  coercePageResult,
  PageAnalysisError,
  pageAnalysisOutputSchema,
  pageAnalysisPrompt,
  type PageAnalyzer,
  type PageResult,
  parsePageResult
} from './page-analysis'

/**
 * Page analyzer backed by the locally installed Claude Code CLI (`claude -p`).
 *
 * Each page is one non-interactive print-mode run, locked down so it is fast
 * and independent of the operator's Claude Code setup:
 *
 *   claude -p --output-format json --json-schema <schema>
 *          --tools Read --allowedTools Read --permission-mode dontAsk
 *          --add-dir <dir containing the page PNG>
 *          --safe-mode --strict-mcp-config --no-session-persistence
 *          [--model M] [--effort E] "<prompt naming the image path>"
 *
 * The model views the page through the `Read` tool (which renders images) and
 * returns the shared `{ text, visuals }` object as `structured_output`.
 */
export interface ClaudePageAnalyzerOptions {
  claudeBin: string
  model?: string
  effort?: string
  timeoutMs: number
  terminationGraceMs?: number
  env?: NodeJS.ProcessEnv
}

const preflightTimeoutMs = 60_000

/** Environment handed to the spawned CLI. `CLAUDECODE` marks a shell running
 * inside a Claude Code session; a nested `claude` launch checks it, so it is
 * dropped to keep the page runs independent of where the script was started. */
function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env }
  delete copy.CLAUDECODE
  return copy
}
const resultMessageMaxLength = 500

interface ResultEnvelope {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: unknown
  structured_output?: unknown
  num_turns?: number
  duration_ms?: number
}

export function createClaudePageAnalyzer(
  options: ClaudePageAnalyzerOptions
): PageAnalyzer {
  const model = options.model?.trim() || undefined
  const effort = options.effort?.trim() || undefined
  const settings = { ...options, model, effort, env: childEnv(options.env) }
  return {
    backend: 'claude',
    identity: {
      backend: 'claude',
      model: model ?? null,
      effort: effort ?? null
    },
    describe: () =>
      `claude (bin=${options.claudeBin}, model=${model ?? 'CLI default'}, ` +
      `effort=${effort ?? 'CLI default'}, timeout=${options.timeoutMs}ms)`,
    preflight: () => preflightClaude(settings),
    analyzePage: (pngPath) => analyzePageWithClaude(pngPath, settings)
  }
}

async function preflightClaude(
  options: ClaudePageAnalyzerOptions
): Promise<void> {
  const limits = { env: options.env, timeoutMs: preflightTimeoutMs }

  const version = await runCliProcess(options.claudeBin, ['--version'], limits)
  if (version.spawnError || version.exitCode !== 0) {
    throw new Error(
      `could not run "${options.claudeBin} --version" — is the Claude Code ` +
        `CLI installed and on PATH (or set CLAUDE_CLI_BIN)? ${
          version.spawnError?.message ??
          diagnosticSample(version.stderr || version.stdout)
        }`
    )
  }
  const cliVersion =
    /\d+\.\d+\.\d+/.exec(version.stdout)?.[0] ?? version.stdout.trim()
  console.log(`[analyze] claude CLI version ${cliVersion}`)

  const auth = await runCliProcess(
    options.claudeBin,
    ['auth', 'status'],
    limits
  )
  if (auth.spawnError) {
    throw new Error(
      `"${options.claudeBin} auth status" failed: ${auth.spawnError.message}`
    )
  }
  // The CLI prints the status JSON on stdout and exits non-zero when logged
  // out, so inspect the JSON before treating the exit code as a failure.
  const status = parseAuthStatus(auth.stdout)
  if (status.loggedIn === false) {
    throw new Error(
      'Claude Code CLI is not authenticated; run "claude auth login" (or ' +
        'start "claude" and use /login) and try again'
    )
  }
  if (auth.exitCode !== 0 && status.loggedIn !== true) {
    throw new Error(
      `"${options.claudeBin} auth status" failed (exit ${auth.exitCode}): ${
        diagnosticSample(auth.stderr || auth.stdout) || '(no output)'
      }`
    )
  }
  console.log(
    `[analyze] claude CLI authenticated` +
      (status.authMethod ? ` (${status.authMethod})` : '')
  )
}

function parseAuthStatus(stdout: string): {
  loggedIn: boolean | undefined
  authMethod?: string
} {
  try {
    const parsed = JSON.parse(stdout) as {
      loggedIn?: unknown
      authMethod?: unknown
    }
    return {
      loggedIn:
        typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : undefined,
      authMethod:
        typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined
    }
  } catch {
    // Older CLIs print prose; only a clear "not logged in" is treated as fatal.
    return {
      loggedIn: /not logged in|logged out/i.test(stdout) ? false : undefined
    }
  }
}

function buildClaudeArgs(
  absImagePath: string,
  options: ClaudePageAnalyzerOptions
): string[] {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(pageAnalysisOutputSchema),
    // `--tools`, `--allowedTools` and `--add-dir` are variadic; each is
    // immediately followed by another flag so the trailing prompt can never be
    // swallowed as an extra value.
    '--tools',
    'Read',
    '--allowedTools',
    'Read',
    '--add-dir',
    path.dirname(absImagePath),
    '--permission-mode',
    'dontAsk',
    '--safe-mode',
    '--strict-mcp-config',
    '--no-session-persistence'
  ]
  if (options.model) args.push('--model', options.model)
  if (options.effort) args.push('--effort', options.effort)
  args.push(
    `${pageAnalysisPrompt}\n\n` +
      `The page image is the PNG file at: ${absImagePath}\n` +
      'Use the Read tool to view that image file first, then respond with ' +
      'ONLY the JSON object described above.'
  )
  return args
}

async function analyzePageWithClaude(
  pngPath: string,
  options: ClaudePageAnalyzerOptions
): Promise<PageResult> {
  const absImage = path.resolve(pngPath)
  // Private working directory so no project CLAUDE.md / settings are picked up
  // and the run leaves nothing behind.
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-claude-'))
  try {
    const run = await runCliProcess(
      options.claudeBin,
      buildClaudeArgs(absImage, options),
      {
        cwd: runDir,
        env: options.env,
        timeoutMs: options.timeoutMs,
        terminationGraceMs: options.terminationGraceMs
      }
    )

    if (run.spawnError) {
      throw new PageAnalysisError(
        `could not start the claude CLI (${options.claudeBin}): ${run.spawnError.message}`,
        { retryable: false }
      )
    }
    if (run.timedOut) {
      throw new PageAnalysisError(
        `claude timed out after ${options.timeoutMs}ms`
      )
    }
    if (run.overflow) {
      throw new PageAnalysisError(
        `claude ${run.overflow} exceeded its size limit`
      )
    }
    if (run.exitCode !== 0) {
      const sample = diagnosticSample(run.stderr || run.stdout)
      throw new PageAnalysisError(
        `claude exited with code ${run.exitCode}` +
          (run.signal ? ` (signal ${run.signal})` : '') +
          (sample ? `: ${sample}` : ''),
        {
          retryable:
            classifyServiceFailure(run.stderr || run.stdout) !== 'configuration'
        }
      )
    }

    const envelope = parseResultEnvelope(run.stdout)
    if (!envelope) {
      throw new Error(
        'claude did not print a JSON result envelope (expected ' +
          '--output-format json output)' +
          (run.stdout.trim()
            ? `: ${diagnosticSample(run.stdout, resultMessageMaxLength)}`
            : '')
      )
    }
    const resultText =
      typeof envelope.result === 'string' ? envelope.result.trim() : ''
    if (envelope.is_error) {
      // Auth/config problems and rejected models do not fix themselves; only
      // transient service errors are worth another attempt.
      throw new PageAnalysisError(
        `claude reported an error: ${
          diagnosticSample(resultText, resultMessageMaxLength) || '(no message)'
        }`,
        {
          retryable: classifyServiceFailure(resultText) === 'transient-service'
        }
      )
    }
    if (envelope.subtype && envelope.subtype !== 'success') {
      throw new Error(
        `claude result subtype was "${envelope.subtype}"` +
          (resultText
            ? `: ${diagnosticSample(resultText, resultMessageMaxLength)}`
            : '')
      )
    }

    if (
      envelope.structured_output &&
      typeof envelope.structured_output === 'object' &&
      !Array.isArray(envelope.structured_output)
    ) {
      return coercePageResult(envelope.structured_output)
    }
    if (!resultText) throw new Error('claude returned an empty result')
    return parsePageResult(resultText)
  } finally {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** The CLI prints one JSON object; tolerate stray lines around it by falling
 * back to the last non-empty line. */
function parseResultEnvelope(stdout: string): ResultEnvelope | undefined {
  const candidates = [stdout.trim()]
  const lines = stdout.split('\n').filter((line) => line.trim())
  if (lines.length > 1) candidates.push(lines.at(-1)!.trim())
  for (const candidate of candidates) {
    if (!candidate.startsWith('{')) continue
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as ResultEnvelope
      }
    } catch {}
  }
  return undefined
}
