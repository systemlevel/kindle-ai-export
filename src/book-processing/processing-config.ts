/**
 * Strict parsing of the Codex processing configuration from the environment.
 *
 * Every numeric knob is validated up front so an operator sees a clear,
 * variable-named error at startup instead of a confusing failure deep inside
 * the scheduler. Unset (or empty) variables fall back to the approved
 * defaults; present-but-invalid variables throw.
 */
export interface ProcessingConfig {
  codexBin: string
  requestedModel: string | null
  batchSize: number
  concurrency: number
  timeoutMs: number
  terminationGraceMs: number
  stdoutLimitBytes: number
  stderrLimitBytes: number
  allowPartial: boolean
}

const integerPattern = /^-?\d+$/

function parseInteger(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  if (trimmed === '') return fallback
  if (!integerPattern.test(trimmed)) {
    throw new Error(`${name} must be an integer, received "${raw}"`)
  }
  return Number(trimmed)
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  const value = parseInteger(raw, fallback, name)
  if (value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`)
  }
  return value
}

function minimumInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  name: string
): number {
  const value = parseInteger(raw, fallback, name)
  if (value < minimum) {
    throw new Error(
      `${name} must be an integer of at least ${minimum}, received "${raw}"`
    )
  }
  return value
}

export function loadProcessingConfig(env: NodeJS.ProcessEnv): ProcessingConfig {
  return {
    codexBin: env.CODEX_BIN || 'codex',
    requestedModel: env.CODEX_MODEL || null,
    batchSize: positiveInteger(env.CODEX_BATCH_SIZE, 8, 'CODEX_BATCH_SIZE'),
    concurrency: positiveInteger(env.CODEX_CONCURRENCY, 1, 'CODEX_CONCURRENCY'),
    timeoutMs: minimumInteger(
      env.CODEX_TIMEOUT_MS,
      300_000,
      10_000,
      'CODEX_TIMEOUT_MS'
    ),
    terminationGraceMs: positiveInteger(
      env.CODEX_TERMINATION_GRACE_MS,
      5000,
      'CODEX_TERMINATION_GRACE_MS'
    ),
    stdoutLimitBytes: positiveInteger(
      env.CODEX_STDOUT_LIMIT_BYTES,
      8 * 1024 * 1024,
      'CODEX_STDOUT_LIMIT_BYTES'
    ),
    stderrLimitBytes: positiveInteger(
      env.CODEX_STDERR_LIMIT_BYTES,
      1024 * 1024,
      'CODEX_STDERR_LIMIT_BYTES'
    ),
    allowPartial: env.ALLOW_PARTIAL === 'true'
  }
}
