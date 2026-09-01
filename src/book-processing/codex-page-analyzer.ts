/* eslint-disable no-process-env */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { diagnosticSample, runCliProcess } from './cli-process'
import { inspectCodexInstallation } from './codex-runner'
import {
  pageAnalysisOutputSchema,
  pageAnalysisPrompt,
  type PageAnalyzer,
  type PageResult,
  parsePageResult
} from './page-analysis'

/**
 * Page analyzer backed by the locally installed Codex CLI (`codex exec`), using
 * the verified invocation: stdin closed, read-only sandbox, private working
 * directory, `--output-schema` for structured JSON and `--output-last-message`
 * for the final result.
 */
export interface CodexPageAnalyzerOptions {
  codexBin: string
  model?: string
  /** `model_reasoning_effort` override (e.g. minimal | low | medium | high | xhigh). */
  reasoningEffort?: string
  timeoutMs: number
  terminationGraceMs?: number
  env?: NodeJS.ProcessEnv
}

const maxResultBytes = 8 * 1024 * 1024

export function createCodexPageAnalyzer(
  options: CodexPageAnalyzerOptions
): PageAnalyzer {
  const model = options.model?.trim() || undefined
  const reasoningEffort = options.reasoningEffort?.trim() || undefined
  const settings = { ...options, model, reasoningEffort }
  return {
    backend: 'codex',
    identity: {
      backend: 'codex',
      model: model ?? null,
      effort: reasoningEffort ?? null
    },
    describe: () =>
      `codex (bin=${options.codexBin}, model=${model ?? 'CLI default'}, ` +
      `reasoning_effort=${reasoningEffort ?? 'CLI default'}, ` +
      `timeout=${options.timeoutMs}ms)`,
    preflight: () => preflightCodex(settings),
    analyzePage: (pngPath) => analyzePageWithCodex(pngPath, settings)
  }
}

async function preflightCodex(
  options: CodexPageAnalyzerOptions
): Promise<void> {
  const inspection = await inspectCodexInstallation(
    options.codexBin,
    options.env ?? process.env
  )
  if (!inspection.ok) {
    throw new Error(
      `Codex CLI preflight failed (${inspection.failure.code}): ` +
        `${inspection.failure.message}. Check "codex --version" and ` +
        '"codex login status"; run "codex login" if it is not authenticated'
    )
  }
  console.log(
    `[analyze] codex CLI version ${inspection.installation.cliVersion} ` +
      `(auth: ${inspection.installation.authentication})`
  )
}

function buildCodexArgs(
  absImagePath: string,
  runDir: string,
  schemaPath: string,
  resultPath: string,
  options: CodexPageAnalyzerOptions
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
    runDir,
    '--image',
    absImagePath,
    '--output-schema',
    schemaPath,
    '--output-last-message',
    resultPath,
    '--json'
  ]
  // --ignore-user-config drops the user's config.toml, so set reasoning effort
  // explicitly. Passed as a `-c` override (bare value; codex treats a non-TOML
  // value as a literal string, e.g. model_reasoning_effort=xhigh).
  if (options.reasoningEffort) {
    args.push('-c', `model_reasoning_effort=${options.reasoningEffort}`)
  }
  if (options.model) args.push('--model', options.model)
  args.push(pageAnalysisPrompt)
  return args
}

async function analyzePageWithCodex(
  pngPath: string,
  options: CodexPageAnalyzerOptions
): Promise<PageResult> {
  const absImage = path.resolve(pngPath)
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-ocr-'))
  const resultPath = path.join(runDir, 'result.json')
  const schemaPath = path.join(runDir, 'schema.json')

  try {
    await fs.writeFile(
      schemaPath,
      JSON.stringify(pageAnalysisOutputSchema, null, 2)
    )
    const run = await runCliProcess(
      options.codexBin,
      buildCodexArgs(absImage, runDir, schemaPath, resultPath, options),
      {
        cwd: runDir,
        env: options.env,
        timeoutMs: options.timeoutMs,
        terminationGraceMs: options.terminationGraceMs
      }
    )

    if (run.spawnError) {
      throw new Error(
        `could not start the codex CLI (${options.codexBin}): ${run.spawnError.message}`
      )
    }
    if (run.timedOut) {
      throw new Error(`codex timed out after ${options.timeoutMs}ms`)
    }
    if (run.overflow) {
      throw new Error(`codex ${run.overflow} exceeded its size limit`)
    }
    if (run.exitCode !== 0) {
      const sample = diagnosticSample(run.stderr)
      throw new Error(
        `codex exited with code ${run.exitCode}` +
          (run.signal ? ` (signal ${run.signal})` : '') +
          (sample ? `: ${sample}` : '')
      )
    }
    if (!sawTurnCompleted(run.stdout)) {
      console.warn(
        '[analyze] codex exited 0 but no turn.completed event was seen; ' +
          'relying on the output file'
      )
    }

    // Bound the untrusted result file before reading it into memory.
    const stats = await fs.stat(resultPath).catch(() => undefined)
    if (!stats) throw new Error('codex did not write an output file')
    if (stats.size > maxResultBytes) {
      throw new Error(`codex output file too large (${stats.size} bytes)`)
    }
    if (stats.size === 0) throw new Error('codex produced an empty output file')

    const raw = (await fs.readFile(resultPath, 'utf8')).trim()
    if (!raw) throw new Error('codex output was blank after trimming')
    return parsePageResult(raw)
  } finally {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {})
  }
}

function sawTurnCompleted(stdoutJsonl: string): boolean {
  for (const line of stdoutJsonl.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as { type?: string }
      if (event.type === 'turn.completed') return true
    } catch {}
  }
  return false
}
