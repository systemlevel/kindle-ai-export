import path from 'node:path'

import type { TocItem } from '../types'
import type {
  BookDocument,
  BookPageRecord,
  SucceededPageCheckpoint
} from './types'
import { atomicWriteJson } from './checkpoint-store'

const legacyContentFileName = 'content.json'

export const partialLegacyContentRejectionMessage =
  'Book processing is partial; set ALLOW_PARTIAL=true to export visible gaps'

/** Legacy `content.json` entry. `page` mirrors the source's `printedPage`
 * for a gap marker (which may be `null`); a projected chunk for a
 * succeeded page always carries a real page number, since projection
 * throws rather than inventing one. */
export interface LegacyContentChunk {
  index: number
  page: number | null
  text: string
  screenshot: string
}

export interface ProjectLegacyContentOptions {
  allowPartial: boolean
}

/**
 * Projects a canonical `BookDocument` into the legacy `content.json` shape
 * existing exporters consume: `{index, page, text, screenshot}` per
 * successful page. Canonical `NormalizedBlock` arrays are only read, never
 * mutated or reordered.
 *
 * A document that is not `complete` is rejected unless
 * `options.allowPartial` is set, in which case every non-succeeded page
 * (failed, pending, or cancelled) is represented by an explicit, deterministic
 * gap-marker chunk instead of being silently dropped, preserving page order.
 */
export function projectLegacyContent(
  document: BookDocument,
  toc: TocItem[],
  options: ProjectLegacyContentOptions
): LegacyContentChunk[] {
  if (document.status !== 'complete' && !options.allowPartial) {
    throw new Error(partialLegacyContentRejectionMessage)
  }

  const tocLabelByPage = tocLabelsByPage(toc)

  const chunks: LegacyContentChunk[] = []
  for (const page of document.pages) {
    if (page.status === 'succeeded') {
      chunks.push(projectSucceededPage(page, tocLabelByPage))
    } else if (options.allowPartial) {
      chunks.push(gapChunkFor(page))
    }
  }
  return chunks
}

/** Atomically writes `content.json` using the same private,
 * same-directory-rename helper as page checkpoints and the book document. */
export async function writeLegacyContent(
  outDir: string,
  chunks: readonly LegacyContentChunk[]
): Promise<void> {
  await atomicWriteJson(path.join(outDir, legacyContentFileName), chunks)
}

function tocLabelsByPage(toc: TocItem[]): Map<number, string> {
  const labels = new Map<number, string>()
  for (const item of toc) {
    if (item.page !== undefined) {
      labels.set(item.page, item.label)
    }
  }
  return labels
}

function projectSucceededPage(
  page: SucceededPageCheckpoint,
  tocLabelByPage: Map<number, string>
): LegacyContentChunk {
  const { source, document } = page
  if (source.printedPage === null) {
    throw new Error(
      `Cannot project legacy content for ${source.captureId}: canonical page is missing a printed page number`
    )
  }

  const contentBlocks = document.blocks.filter(
    (block) => block.kind !== 'page-number'
  )
  const leadingBlock = contentBlocks[0]
  const tocLabel = tocLabelByPage.get(source.printedPage)
  const leadingBlockDuplicatesTocHeading =
    tocLabel !== undefined &&
    leadingBlock?.kind === 'heading' &&
    leadingBlock.text.trim().toLowerCase() === tocLabel.trim().toLowerCase()

  const textBlocks = leadingBlockDuplicatesTocHeading
    ? contentBlocks.slice(1)
    : contentBlocks

  return {
    index: source.index,
    page: source.printedPage,
    screenshot: source.screenshotPath,
    text: textBlocks.map((block) => block.text).join('\n\n')
  }
}

/** A non-succeeded record's own status names the gap: `failed`, `pending`,
 * or `cancelled`. The marker never invents a printed-page number or
 * replacement text. */
function gapChunkFor(
  page: Exclude<BookPageRecord, { status: 'succeeded' }>
): LegacyContentChunk {
  return {
    index: page.source.index,
    page: page.source.printedPage,
    screenshot: page.source.screenshotPath,
    text: `[Missing captured page ${page.source.captureId}; processing ${page.status}]`
  }
}
