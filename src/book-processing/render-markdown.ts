import type { BookMetadata, TocItem } from '../types'
import type {
  BookDocument,
  BookPageRecord,
  NormalizedBlock,
  RawTextRun
} from './types'
import { partialLegacyContentRejectionMessage } from './legacy-content'

export interface RenderBookMarkdownInput {
  document: BookDocument
  metadata: BookMetadata
  allowPartial: boolean
  /**
   * Optional pre-rendered Table of Contents section (its `## Table of
   * Contents` heading plus an anchor-linked bullet list), inserted between
   * the byline and the chapter body with the same `---` separators the
   * legacy exporter used. Omitted/empty by default, which renders exactly
   * as before - the shape the pinned snapshot tests below exercise.
   */
  tocMarkdown?: string
}

/** Markdown metacharacters that must be escaped in plain text and image alt
 * text so OCR'd content can never be mistaken for Markdown syntax. */
const markdownEscapePattern = /[\\`*_{}[\]()#+\-.!|>~<]/g

function escapeMarkdown(text: string): string {
  return text.replaceAll(markdownEscapePattern, '\\$&')
}

/** Wraps escaped run text in deterministic emphasis markers: italics use
 * underscores and bold uses double asterisks, applied italic-then-bold so a
 * run with both styles nests as `**_text_**` rather than the ambiguous
 * `***text***`. */
function renderRun(run: RawTextRun): string {
  let text = escapeMarkdown(run.text)
  if (run.styles.includes('italic')) text = `_${text}_`
  if (run.styles.includes('bold')) text = `**${text}**`
  return text
}

function renderRuns(runs: RawTextRun[]): string {
  return runs.map(renderRun).join('')
}

/**
 * Renders one block's own Markdown content (no citation comment). Returns
 * `null` for blocks that intentionally produce no visible content:
 * `page-number` blocks are page furniture, not book content, so - like the
 * legacy `content.json` projection - they are dropped rather than rendered.
 */
function renderBlockBody(block: NormalizedBlock): string | null {
  if (block.kind === 'page-number') return null

  if (block.kind === 'image') {
    if (block.mediaAsset) {
      const alt = escapeMarkdown(block.caption ?? block.mediaDescription ?? '')
      return `![${alt}](${block.mediaAsset.path})`
    }

    // No crop asset exists (ineligible region, or the crop failed): fall
    // back to the model's media description plus a link to the full page
    // screenshot, so a reader can always find the original evidence. When
    // neither a media description nor a caption is available, emit just the
    // link - inventing a placeholder like "Image" would misrepresent what
    // the model actually reported.
    const description = block.mediaDescription ?? block.caption
    const link = `[View source page](${block.citation.screenshotPath})`
    return description ? `${escapeMarkdown(description)} ${link}` : link
  }

  return renderRuns(block.runs)
}

function renderCitation(id: string): string {
  return `<!-- kindle-citation: ${id} -->`
}

/** Renders a block plus its mandatory citation comment as one section, or
 * `null` when the block itself renders no content (see
 * {@link renderBlockBody}). */
function renderBlockSection(block: NormalizedBlock): string | null {
  const body = renderBlockBody(block)
  if (body === null) return null
  return `${body}\n${renderCitation(block.citation.id)}`
}

/** A non-succeeded page's own status names the gap: `failed`, `pending`, or
 * `cancelled`. The marker never invents a printed-page number or
 * replacement text - mirroring the legacy gap-marker projection. */
function renderGapBlockquote(
  page: Exclude<BookPageRecord, { status: 'succeeded' }>
): string {
  const printedPagePart =
    page.source.printedPage === null
      ? ''
      : ` (printed page ${page.source.printedPage})`
  return `> Capture ${page.source.captureId}${printedPagePart}: processing ${page.status}`
}

/**
 * Splits `document.pages` into chapters using the same TOC-page-threshold
 * scheme as the legacy exporter: for each TOC entry with a `page`, its
 * chapter runs from the current offset up to (but excluding) the first page
 * whose printed page number reaches the *next* TOC entry's page. A next
 * entry with no `page` (e.g. a location-only back-matter bookmark) means
 * "extend to the end of the document" - which is also how an entry whose
 * threshold page is never reached is treated here, a deliberate
 * simplification of the legacy loop's `findIndex` semantics (where an
 * unmatched threshold silently dropped the chapter's content instead).
 */
function renderChapters(
  pages: BookPageRecord[],
  toc: TocItem[],
  allowPartial: boolean
): string[] {
  const sections: string[] = []

  for (let i = 0, index = 0; i < toc.length - 1; i++) {
    const tocItem = toc[i]!
    if (tocItem.page === undefined) continue

    const nextTocItem = toc[i + 1]!
    const nextIndex =
      nextTocItem.page === undefined
        ? pages.length
        : pages.findIndex(
            (page) =>
              page.source.printedPage !== null &&
              page.source.printedPage >= nextTocItem.page!
          )
    const resolvedNextIndex = nextIndex === -1 ? pages.length : nextIndex
    if (resolvedNextIndex < index) continue

    sections.push(
      `${'#'.repeat(tocItem.depth + 2)} ${escapeMarkdown(tocItem.label)}`
    )

    for (const page of pages.slice(index, resolvedNextIndex)) {
      if (page.status === 'succeeded') {
        for (const block of page.document.blocks) {
          const section = renderBlockSection(block)
          if (section) sections.push(section)
        }
      } else if (allowPartial) {
        sections.push(renderGapBlockquote(page))
      }
    }

    index = resolvedNextIndex
  }

  return sections
}

/**
 * Renders a canonical `BookDocument` as citation-rich Markdown: title,
 * byline, then each TOC chapter's blocks with a machine-readable
 * `<!-- kindle-citation: ... -->` comment immediately after every
 * successfully rendered block.
 *
 * A document whose `status` is not `complete` is rejected with
 * {@link partialLegacyContentRejectionMessage} unless `input.allowPartial`
 * is set, in which case failed/pending/cancelled pages are rendered as
 * explicit blockquote gap markers instead of being silently dropped or
 * replaced with invented text.
 */
export function renderBookMarkdown(input: RenderBookMarkdownInput): string {
  const { document, metadata, allowPartial, tocMarkdown } = input

  if (document.status !== 'complete' && !allowPartial) {
    throw new Error(partialLegacyContentRejectionMessage)
  }

  // The brief only requires escaping plain text and image alt text; escaping
  // the title/byline too is a deliberate superset, applied here so every
  // piece of OCR'd metadata gets the same Markdown-safety guarantee.
  const sections: string[] = [
    `# ${escapeMarkdown(metadata.meta.title)}`,
    `> By ${metadata.meta.authorList.map((author) => escapeMarkdown(author)).join(', ')}`
  ]

  if (tocMarkdown) {
    sections.push('---', tocMarkdown, '---')
  }

  sections.push(...renderChapters(document.pages, metadata.toc, allowPartial))

  return sections.join('\n\n')
}
