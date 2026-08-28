import { createHash } from 'node:crypto'

import type { AvailablePageSource, ProcessorIdentity } from './types'

export interface ProcessorIdentityInput {
  codexCliVersion: string
  requestedModel: string | null
  promptVersion: string
  prompt: string
  outputSchemaVersion: string
  outputSchema: unknown
  normalizerVersion: string
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    )
  }

  return value
}

function sha256Json(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
}

export function createProcessorIdentity(
  input: ProcessorIdentityInput
): ProcessorIdentity {
  const promptSha256 = createHash('sha256').update(input.prompt).digest('hex')
  const outputSchemaSha256 = sha256Json(input.outputSchema)
  const requestedModel = input.requestedModel ?? 'cli-default'
  const identity = {
    runnerKind: 'codex-cli' as const,
    codexCliVersion: input.codexCliVersion,
    requestedModel,
    promptVersion: input.promptVersion,
    promptSha256,
    outputSchemaVersion: input.outputSchemaVersion,
    outputSchemaSha256,
    normalizerVersion: input.normalizerVersion
  }

  return {
    ...identity,
    configurationHash: sha256Json(identity)
  }
}

export function createPageCacheKey(
  source: AvailablePageSource,
  processor: ProcessorIdentity
): string {
  return sha256Json({
    screenshotSha256: source.screenshotSha256,
    codexCliVersion: processor.codexCliVersion,
    requestedModel: processor.requestedModel,
    promptVersion: processor.promptVersion,
    promptSha256: processor.promptSha256,
    outputSchemaVersion: processor.outputSchemaVersion,
    outputSchemaSha256: processor.outputSchemaSha256,
    normalizerVersion: processor.normalizerVersion
  })
}
