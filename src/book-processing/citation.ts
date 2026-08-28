import { createHash } from 'node:crypto'

import type {
  AvailablePageSource,
  Citation,
  ProcessorIdentity,
  RawCodexBlock
} from './types'

export interface CitationInput {
  asin: string
  editionVersion: string
  editionHash: string
  source: AvailablePageSource
  processor: ProcessorIdentity
  block: RawCodexBlock
}

/**
 * Derives a stable per-edition hash from the book ASIN and its Kindle
 * metadata/edition version. This is independent of any single page, so
 * callers normalizing many pages for the same book should compute it once
 * and pass it into every {@link createCitation} call.
 */
export function createEditionHash(
  asin: string,
  editionVersion: string
): string {
  return createHash('sha256').update(`${asin}:${editionVersion}`).digest('hex')
}

/** Zero-padded, order-derived block identifier, e.g. `b0000`. */
export function createBlockId(order: number): string {
  return `b${String(order).padStart(4, '0')}`
}

/**
 * Builds a deterministic, locally-derived citation for a block. Codex never
 * supplies citation data; every field here is computed from already-trusted
 * local evidence (page source hashes, processor identity, block order).
 */
export function createCitation(input: CitationInput): Citation {
  const blockId = createBlockId(input.block.order)
  const id = [
    'knd',
    input.asin,
    input.editionHash.slice(0, 12),
    input.source.screenshotSha256.slice(0, 12),
    input.processor.configurationHash.slice(0, 12),
    blockId
  ].join(':')

  return {
    id,
    asin: input.asin,
    editionVersion: input.editionVersion,
    captureId: input.source.captureId,
    captureIndex: input.source.index,
    printedPage: input.source.printedPage,
    position: input.source.position,
    screenshotPath: input.source.screenshotPath,
    screenshotSha256: input.source.screenshotSha256,
    blockId,
    blockKind: input.block.kind,
    region: input.block.region,
    processorConfigurationHash: input.processor.configurationHash
  }
}
