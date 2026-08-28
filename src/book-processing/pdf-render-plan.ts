import type { BookMetadata } from '../types'
import type {
  BookDocument,
  BookPageRecord,
  NormalizedBlock,
  RawTextRun
} from './types'
import { partialLegacyContentRejectionMessage } from './legacy-content'

/** A non-succeeded page's own status names the gap - see {@link PdfGapItem}. */
export type PdfGapStatus = 'failed' | 'pending' | 'cancelled'

export interface PdfTitleItem {
  kind: 'title'
  text: string
  authors: string[]
}

export interface PdfHeadingItem {
  kind: 'heading'
  level: number
  text: string
  citationId: string
}

export interface PdfParagraphItem {
  kind: 'paragraph'
  runs: RawTextRun[]
  citationId: string
}

/**
 * `path` is `null` when the block has no crop asset (an ineligible region,
 * or a failed crop) - mirroring the Markdown exporter's rule of never
 * inventing a substitute image. The renderer falls back to `caption` (if
 * any) plus the citation instead of embedding nothing.
 */
export interface PdfImageItem {
  kind: 'image'
  path: string | null
  caption: string | null
  citationId: string
}

/** A non-succeeded page's own status names the gap: `failed`, `pending`, or
 * `cancelled`. The item never invents a printed-page number or replacement
 * text, matching {@link renderGapBlockquote} in the Markdown exporter. */
export interface PdfGapItem {
  kind: 'gap'
  captureId: string
  printedPage: number | null
  status: PdfGapStatus
}

export type PdfRenderItem =
  | PdfTitleItem
  | PdfHeadingItem
  | PdfParagraphItem
  | PdfImageItem
  | PdfGapItem

/** PDFKit document `info` fields, carried separately from `items` because
 * they configure the `PDFDocument` constructor rather than being drawn as
 * page content. */
export interface PdfDocumentInfo {
  Title: string
  Author: string
}

export interface PdfRenderPlan {
  info: PdfDocumentInfo
  items: PdfRenderItem[]
}

export interface CreatePdfRenderPlanInput {
  document: BookDocument
  metadata: BookMetadata
  allowPartial: boolean
}

/** Maps one canonical block to its render item. Returns `null` for a
 * `page-number` block, which - like the Markdown exporter's projection - is
 * page furniture rather than book content, so it is dropped rather than
 * rendered. Every other block kind renders as a `paragraph` item using its
 * `runs` verbatim, since the PDF renderer only needs distinct treatment for
 * `heading` and `image` blocks. */
function renderItemForBlock(block: NormalizedBlock): PdfRenderItem | null {
  if (block.kind === 'page-number') return null

  if (block.kind === 'heading') {
    return {
      kind: 'heading',
      level: block.headingLevel ?? 1,
      text: block.text,
      citationId: block.citation.id
    }
  }

  if (block.kind === 'image') {
    return {
      kind: 'image',
      path: block.mediaAsset?.path ?? null,
      caption: block.caption,
      citationId: block.citation.id
    }
  }

  return {
    kind: 'paragraph',
    runs: block.runs,
    citationId: block.citation.id
  }
}

function gapItemForPage(
  page: Exclude<BookPageRecord, { status: 'succeeded' }>
): PdfGapItem {
  return {
    kind: 'gap',
    captureId: page.source.captureId,
    printedPage: page.source.printedPage,
    status: page.status
  }
}

/**
 * Builds a pure, ordered plan of `PdfRenderItem`s from a canonical
 * `BookDocument`: never reads PDF bytes, opens no file handles, and never
 * sorts or mutates `document.pages` or their blocks - `document.pages` is
 * walked in order, and each succeeded page's `blocks` are walked in their
 * own order, exactly as PDFKit should draw them.
 *
 * A document whose `status` is not `complete` is rejected with
 * {@link partialLegacyContentRejectionMessage} unless `input.allowPartial`
 * is set, in which case every non-succeeded page (failed, pending, or
 * cancelled) becomes an explicit `gap` item instead of being silently
 * dropped or replaced with invented text.
 */
export function createPdfRenderPlan(
  input: CreatePdfRenderPlanInput
): PdfRenderPlan {
  const { document, metadata, allowPartial } = input

  if (document.status !== 'complete' && !allowPartial) {
    throw new Error(partialLegacyContentRejectionMessage)
  }

  const items: PdfRenderItem[] = [
    {
      kind: 'title',
      text: metadata.meta.title,
      authors: metadata.meta.authorList
    }
  ]

  for (const page of document.pages) {
    if (page.status === 'succeeded') {
      for (const block of page.document.blocks) {
        const item = renderItemForBlock(block)
        if (item) items.push(item)
      }
    } else if (allowPartial) {
      items.push(gapItemForPage(page))
    }
  }

  return {
    info: {
      Title: metadata.meta.title,
      Author: metadata.meta.authorList.join(', ')
    },
    items
  }
}
