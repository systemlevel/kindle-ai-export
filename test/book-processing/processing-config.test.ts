import { describe, expect, test } from 'vitest'

import { loadProcessingConfig } from '../../src/book-processing/processing-config'

describe('loadProcessingConfig', () => {
  test('uses approved defaults', () => {
    expect(loadProcessingConfig({})).toMatchObject({
      batchSize: 8,
      concurrency: 1,
      timeoutMs: 300_000,
      terminationGraceMs: 5000,
      stdoutLimitBytes: 8 * 1024 * 1024,
      stderrLimitBytes: 1024 * 1024,
      requestedModel: null,
      allowPartial: false
    })
  })

  test('defaults the Codex binary to codex', () => {
    expect(loadProcessingConfig({}).codexBin).toBe('codex')
  })

  test('reads every supported override', () => {
    expect(
      loadProcessingConfig({
        CODEX_BIN: '/opt/codex',
        CODEX_MODEL: 'gpt-5-codex',
        CODEX_BATCH_SIZE: '4',
        CODEX_CONCURRENCY: '2',
        CODEX_TIMEOUT_MS: '120000',
        CODEX_TERMINATION_GRACE_MS: '2500',
        CODEX_STDOUT_LIMIT_BYTES: '2048',
        CODEX_STDERR_LIMIT_BYTES: '1024',
        ALLOW_PARTIAL: 'true'
      })
    ).toEqual({
      codexBin: '/opt/codex',
      requestedModel: 'gpt-5-codex',
      batchSize: 4,
      concurrency: 2,
      timeoutMs: 120_000,
      terminationGraceMs: 2500,
      stdoutLimitBytes: 2048,
      stderrLimitBytes: 1024,
      allowPartial: true
    })
  })

  test('treats ALLOW_PARTIAL other than "true" as false', () => {
    expect(loadProcessingConfig({ ALLOW_PARTIAL: 'TRUE' }).allowPartial).toBe(
      false
    )
    expect(loadProcessingConfig({ ALLOW_PARTIAL: '1' }).allowPartial).toBe(
      false
    )
  })

  test.each(['0', '-1', '-8'])(
    'rejects a non-positive batch size %s',
    (value) => {
      expect(() => loadProcessingConfig({ CODEX_BATCH_SIZE: value })).toThrow(
        /CODEX_BATCH_SIZE/
      )
    }
  )

  test('rejects a non-positive concurrency', () => {
    expect(() => loadProcessingConfig({ CODEX_CONCURRENCY: '0' })).toThrow(
      /CODEX_CONCURRENCY/
    )
  })

  test.each(['abc', '8.5', '1e3', '0x10'])(
    'rejects the nonnumeric batch size %j',
    (value) => {
      expect(() => loadProcessingConfig({ CODEX_BATCH_SIZE: value })).toThrow(
        /CODEX_BATCH_SIZE/
      )
    }
  )

  test.each(['5000', '9999'])(
    'rejects a timeout under ten seconds (%s)',
    (value) => {
      expect(() => loadProcessingConfig({ CODEX_TIMEOUT_MS: value })).toThrow(
        /CODEX_TIMEOUT_MS/
      )
    }
  )

  test('accepts a timeout of exactly ten seconds', () => {
    expect(loadProcessingConfig({ CODEX_TIMEOUT_MS: '10000' }).timeoutMs).toBe(
      10_000
    )
  })

  test('rejects a nonnumeric timeout', () => {
    expect(() => loadProcessingConfig({ CODEX_TIMEOUT_MS: 'soon' })).toThrow(
      /CODEX_TIMEOUT_MS/
    )
  })
})
