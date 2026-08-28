import { readFileSync } from 'node:fs'

import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js'

import type { RawCodexBatch, RawCodexPage } from './types'

const schema = JSON.parse(
  readFileSync(new URL('codex-output.schema.json', import.meta.url), 'utf8')
) as object

const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(
  schema
)

export class CodexOutputValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexOutputValidationError'
  }
}

export function validateRawCodexBatch(
  value: unknown,
  requestedPageIds: readonly string[]
): RawCodexBatch {
  if (!validateSchema(value)) {
    throw new CodexOutputValidationError(formatAjvErrors(validateSchema.errors))
  }

  const batch = value as RawCodexBatch
  const returned = batch.pages.map((page) => page.pageId)
  if (new Set(returned).size !== returned.length) {
    throw new CodexOutputValidationError('Codex returned duplicate page IDs')
  }

  if (!arraysEqual(returned, requestedPageIds)) {
    throw new CodexOutputValidationError(
      `Codex returned page IDs [${returned.join(', ')}]; expected [${requestedPageIds.join(', ')}]`
    )
  }

  for (const page of batch.pages) validatePageDomain(page)
  return batch
}

function validatePageDomain(page: RawCodexPage): void {
  for (const [index, block] of page.blocks.entries()) {
    if (block.order !== index) {
      throw new CodexOutputValidationError(
        `Page ${page.pageId} block order must be contiguous from zero`
      )
    }

    for (const run of block.runs) {
      if (run.text.length === 0) {
        throw new CodexOutputValidationError(
          `Page ${page.pageId} block ${block.order} text runs must be nonempty`
        )
      }
    }

    if (block.kind === 'heading' && block.headingLevel === null) {
      throw new CodexOutputValidationError(
        `Page ${page.pageId} block ${block.order} headings must have a heading level`
      )
    }

    if (block.kind !== 'heading' && block.headingLevel !== null) {
      throw new CodexOutputValidationError(
        `Page ${page.pageId} block ${block.order} may only have a heading level when kind is heading`
      )
    }

    if (
      block.mediaDescription !== null &&
      block.kind !== 'image' &&
      block.kind !== 'table'
    ) {
      throw new CodexOutputValidationError(
        `Page ${page.pageId} block ${block.order} may only have a media description when kind is image or table`
      )
    }

    if (
      block.region &&
      (block.region.x + block.region.width > 1000 ||
        block.region.y + block.region.height > 1000)
    ) {
      throw new CodexOutputValidationError(
        `Page ${page.pageId} block ${block.order} region must not exceed normalized page bounds`
      )
    }
  }
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  const details = errors
    ?.map(
      (error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`
    )
    .join('; ')

  return `Codex output failed schema validation${details ? `: ${details}` : ''}`
}
