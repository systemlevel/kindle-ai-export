import { describe, expect, test } from 'vitest'

import {
  createPageAnalyzer,
  loadAnalyzerConfig
} from '../../src/book-processing/analyzer-config'

describe('loadAnalyzerConfig', () => {
  test('defaults to the codex backend in resume mode with the documented knobs', () => {
    const config = loadAnalyzerConfig({})
    expect(config).toEqual({
      backend: 'codex',
      reprocess: false,
      pages: undefined,
      codex: {
        codexBin: 'codex',
        model: undefined,
        reasoningEffort: 'xhigh',
        timeoutMs: 300_000
      },
      claude: {
        claudeBin: 'claude',
        model: undefined,
        effort: 'high',
        timeoutMs: 300_000
      }
    })
  })

  test('selects the claude backend case-insensitively', () => {
    expect(loadAnalyzerConfig({ ANALYZER: ' Claude ' }).backend).toBe('claude')
  })

  test('rejects an unknown backend by variable name', () => {
    expect(() => loadAnalyzerConfig({ ANALYZER: 'gemini' })).toThrow(
      /ANALYZER.*codex.*claude/
    )
  })

  test('parses REPROCESS as a boolean flag', () => {
    for (const raw of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(loadAnalyzerConfig({ REPROCESS: raw }).reprocess, raw).toBe(true)
    }
    for (const raw of ['0', 'false', 'no', 'off', '']) {
      expect(loadAnalyzerConfig({ REPROCESS: raw }).reprocess, raw).toBe(false)
    }
    expect(() => loadAnalyzerConfig({ REPROCESS: 'maybe' })).toThrow(
      /REPROCESS/
    )
  })

  test('parses PAGES into a page selection and ignores it when empty', () => {
    expect([...loadAnalyzerConfig({ PAGES: '2-3,9' }).pages!]).toEqual([
      2, 3, 9
    ])
    expect(loadAnalyzerConfig({ PAGES: '  ' }).pages).toBeUndefined()
    expect(() => loadAnalyzerConfig({ PAGES: 'x' })).toThrow(/PAGES/)
  })

  test('reads per-backend overrides', () => {
    const config = loadAnalyzerConfig({
      CODEX_BIN: '/opt/codex',
      CODEX_MODEL: 'gpt-5',
      CODEX_REASONING_EFFORT: 'high',
      CODEX_TIMEOUT_MS: '1000',
      CLAUDE_CLI_BIN: '/opt/claude',
      CLAUDE_CLI_MODEL: 'opus',
      CLAUDE_CLI_EFFORT: 'xhigh',
      CLAUDE_CLI_TIMEOUT_MS: '2000'
    })
    expect(config.codex).toEqual({
      codexBin: '/opt/codex',
      model: 'gpt-5',
      reasoningEffort: 'high',
      timeoutMs: 1000
    })
    expect(config.claude).toEqual({
      claudeBin: '/opt/claude',
      model: 'opus',
      effort: 'xhigh',
      timeoutMs: 2000
    })
  })

  test('rejects non-positive-integer timeouts by variable name', () => {
    expect(() => loadAnalyzerConfig({ CODEX_TIMEOUT_MS: 'abc' })).toThrow(
      /CODEX_TIMEOUT_MS/
    )
    expect(() => loadAnalyzerConfig({ CLAUDE_CLI_TIMEOUT_MS: '0' })).toThrow(
      /CLAUDE_CLI_TIMEOUT_MS/
    )
  })
})

describe('createPageAnalyzer', () => {
  test('builds the analyzer for the configured backend', () => {
    const codex = createPageAnalyzer(loadAnalyzerConfig({}))
    expect(codex.backend).toBe('codex')
    expect(codex.identity).toEqual({
      backend: 'codex',
      model: null,
      effort: 'xhigh'
    })

    const claude = createPageAnalyzer(
      loadAnalyzerConfig({ ANALYZER: 'claude', CLAUDE_CLI_MODEL: 'opus' })
    )
    expect(claude.backend).toBe('claude')
    expect(claude.identity).toEqual({
      backend: 'claude',
      model: 'opus',
      effort: 'high'
    })
  })
})
