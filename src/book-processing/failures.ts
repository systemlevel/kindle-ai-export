import type { ProcessingFailure, ProcessingFailureCategory } from './types'

export interface CreateProcessingFailureInput {
  category: ProcessingFailureCategory
  code: string
  message: string
  secrets?: readonly string[]
  attempts: number
  occurredAt: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

const maxDiagnosticLength = 1000

export function sanitizeDiagnostic(
  message: string,
  secrets: readonly string[] = []
): string {
  let safe = message
  for (const secret of [...secrets]
    .filter((value) => value.length > 0)
    .toSorted((left, right) => right.length - left.length)) {
    safe = safe.split(secret).join('[REDACTED]')
  }

  safe = safe
    .replaceAll(/[\r\n]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
  return safe.slice(0, maxDiagnosticLength)
}

export function createProcessingFailure(
  input: CreateProcessingFailureInput
): ProcessingFailure {
  return {
    category: input.category,
    code: input.code,
    message: sanitizeDiagnostic(input.message, input.secrets),
    attempts: input.attempts,
    occurredAt: input.occurredAt,
    exitCode: input.exitCode,
    signal: input.signal
  }
}
