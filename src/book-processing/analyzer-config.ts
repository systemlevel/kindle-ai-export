import { createClaudePageAnalyzer } from './claude-page-analyzer'
import { createCodexPageAnalyzer } from './codex-page-analyzer'
import {
  type AnalyzerBackend,
  analyzerBackends,
  type PageAnalyzer,
  parsePageSelection
} from './page-analysis'

/**
 * Environment-driven configuration for the page-analysis phase, shared by
 * `capture-book-text.ts` (OCR=1) and `analyze-book-text.ts`.
 *
 * Every knob is validated up front and errors name the offending variable so
 * an operator sees the fix immediately instead of a failure mid-run.
 */
export interface AnalyzerConfig {
  /** Which CLI performs the analysis. `ANALYZER`, default `codex`. */
  backend: AnalyzerBackend
  /** Re-analyze pages that already have results. `REPROCESS`, default off. */
  reprocess: boolean
  /** Pages allowed to reach the analyzer. `PAGES`, default all. */
  pages: Set<number> | undefined
  codex: {
    codexBin: string
    model: string | undefined
    reasoningEffort: string
    timeoutMs: number
  }
  /** Claude Code CLI knobs. Named `CLAUDE_CLI_*` because Claude Code itself
   * exports `CLAUDE_*` / `CLAUDE_CODE_*` variables (e.g. `CLAUDE_EFFORT`) into
   * the terminals it runs, which would otherwise silently override ours. */
  claude: {
    claudeBin: string
    model: string | undefined
    effort: string
    timeoutMs: number
  }
}

const defaultTimeoutMs = 300_000
const defaultCodexReasoningEffort = 'xhigh'
// Effort levels above `high` are model-dependent on Claude, so the default
// stays universally valid; raise it with CLAUDE_CLI_EFFORT=xhigh when supported.
const defaultClaudeEffort = 'high'

function optionalString(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  return trimmed || undefined
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  const trimmed = optionalString(raw)
  if (trimmed === undefined) return fallback
  if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`)
  }
  return Number(trimmed)
}

function booleanFlag(raw: string | undefined, name: string): boolean {
  const value = (raw ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['', '0', 'false', 'no', 'off'].includes(value)) return false
  throw new Error(
    `${name} must be one of 1/true/yes/on or 0/false/no/off, received "${raw}"`
  )
}

export function loadAnalyzerConfig(env: NodeJS.ProcessEnv): AnalyzerConfig {
  const backendRaw = optionalString(env.ANALYZER)?.toLowerCase() ?? 'codex'
  if (!(analyzerBackends as readonly string[]).includes(backendRaw)) {
    throw new Error(
      `ANALYZER must be one of ${analyzerBackends.join(', ')} ` +
        `(codex or claude), received "${env.ANALYZER}"`
    )
  }
  const pagesRaw = optionalString(env.PAGES)

  return {
    backend: backendRaw as AnalyzerBackend,
    reprocess: booleanFlag(env.REPROCESS, 'REPROCESS'),
    pages: pagesRaw === undefined ? undefined : parsePageSelection(pagesRaw),
    codex: {
      codexBin: optionalString(env.CODEX_BIN) ?? 'codex',
      model: optionalString(env.CODEX_MODEL),
      reasoningEffort:
        optionalString(env.CODEX_REASONING_EFFORT) ??
        defaultCodexReasoningEffort,
      timeoutMs: positiveInteger(
        env.CODEX_TIMEOUT_MS,
        defaultTimeoutMs,
        'CODEX_TIMEOUT_MS'
      )
    },
    claude: {
      claudeBin: optionalString(env.CLAUDE_CLI_BIN) ?? 'claude',
      model: optionalString(env.CLAUDE_CLI_MODEL),
      effort: optionalString(env.CLAUDE_CLI_EFFORT) ?? defaultClaudeEffort,
      timeoutMs: positiveInteger(
        env.CLAUDE_CLI_TIMEOUT_MS,
        defaultTimeoutMs,
        'CLAUDE_CLI_TIMEOUT_MS'
      )
    }
  }
}

/** Instantiates the analyzer for `config.backend`. `env` is inherited by the
 * spawned CLI (defaults to the current process environment). */
export function createPageAnalyzer(
  config: AnalyzerConfig,
  env?: NodeJS.ProcessEnv
): PageAnalyzer {
  switch (config.backend) {
    case 'claude':
      return createClaudePageAnalyzer({
        claudeBin: config.claude.claudeBin,
        model: config.claude.model,
        effort: config.claude.effort,
        timeoutMs: config.claude.timeoutMs,
        env
      })
    case 'codex':
      return createCodexPageAnalyzer({
        codexBin: config.codex.codexBin,
        model: config.codex.model,
        reasoningEffort: config.codex.reasoningEffort,
        timeoutMs: config.codex.timeoutMs,
        env
      })
  }
}
