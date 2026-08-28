import type {
  AvailablePageSource,
  NormalizedBlock,
  NormalizedPageDocument,
  ProcessorIdentity,
  RawCodexPage
} from './types'
import { createBlockId, createCitation, createEditionHash } from './citation'
import { createMediaAsset, describeMissingMediaAsset } from './media-assets'

export interface NormalizePageInput {
  page: RawCodexPage
  source: AvailablePageSource
  processor: ProcessorIdentity
  asin: string
  editionVersion: string
  /** Book output directory; screenshots are read and crop assets are
   * written relative to this directory. */
  outDir: string
}

/**
 * Turns a validated, untrusted `RawCodexPage` model observation into a
 * `NormalizedPageDocument`: deterministic block IDs, concatenated block
 * text, locally-derived citations, and validated media crops. Block order
 * is already validated as contiguous-from-zero upstream and is preserved
 * exactly as received; this function never sorts or reorders blocks.
 */
export async function normalizePage(
  input: NormalizePageInput
): Promise<NormalizedPageDocument> {
  const editionHash = createEditionHash(input.asin, input.editionVersion)

  const blocks: NormalizedBlock[] = await Promise.all(
    input.page.blocks.map(async (block) => {
      const blockId = createBlockId(block.order)
      const citation = createCitation({
        asin: input.asin,
        editionVersion: input.editionVersion,
        editionHash,
        source: input.source,
        processor: input.processor,
        block
      })
      const mediaAsset = await createMediaAsset({
        source: input.source,
        outDir: input.outDir,
        block,
        blockId
      })

      return {
        ...block,
        blockId,
        text: block.runs.map((run) => run.text).join(''),
        citation,
        mediaAsset
      }
    })
  )

  return {
    source: input.source,
    blocks,
    warnings: collectWarnings(input.page, blocks)
  }
}

function collectWarnings(
  page: RawCodexPage,
  blocks: NormalizedBlock[]
): string[] {
  const cropWarnings = blocks
    .filter((block) => block.mediaAsset === null)
    .map((block) => describeMissingMediaAsset(block, block.blockId))
    .filter((warning): warning is string => warning !== null)

  return [...page.warnings, ...cropWarnings]
}
