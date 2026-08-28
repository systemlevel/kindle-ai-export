import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookDocument, BookPageRecord } from './book-processing/types'
import type { BookMetadata, TocItem } from './types'
import { renderBookMarkdown } from './book-processing/render-markdown'
import { assert, getEnv, readJsonFile } from './utils'

/**
 * Determines the index of the last TOC entry whose chapter boundary was
 * actually resolvable, exactly reproducing the legacy exporter's own
 * `lastTocItemIndex` loop (see `git show b34af2f:src/export-book-markdown.ts`):
 * an entry is included only while its next-chapter page threshold is either
 * absent (a back-matter bookmark) or actually reached by some page. This is
 * intentionally the *legacy* semantics - narrower than the "extend to end of
 * book" behavior `renderBookMarkdown` now uses for the rendered chapters
 * themselves - because the visible Table of Contents should only ever list
 * entries whose boundary is known.
 */
function findLastTocEntryIndex(
  toc: TocItem[],
  pages: BookPageRecord[]
): number {
  let lastTocItemIndex = 0

  for (let i = 0; i < toc.length - 1; i++) {
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
    if (nextIndex === -1) continue

    lastTocItemIndex = i
  }

  return lastTocItemIndex
}

/** Slugifies a TOC label into the same anchor the legacy exporter used. */
function tocAnchor(label: string): string {
  return label.toLowerCase().replaceAll(/[^\da-z]+/g, '-')
}

/**
 * Builds the `## Table of Contents` section (heading plus an anchor-linked
 * bullet list) using the legacy exporter's exact formatting, filtered to the
 * last resolvable TOC entry so the list never references a chapter that
 * couldn't be located in the book's pages.
 */
export function buildTocMarkdown(
  toc: TocItem[],
  pages: BookPageRecord[]
): string {
  const lastTocItemIndex = findLastTocEntryIndex(toc, pages)

  const list = toc
    .filter(
      (tocItem, index) =>
        tocItem.page !== undefined && index <= lastTocItemIndex
    )
    .map(
      (tocItem) =>
        `${'  '.repeat(tocItem.depth)}- [${tocItem.label}](#${tocAnchor(tocItem.label)})`
    )
    .join('\n')

  return `## Table of Contents\n\n${list}`
}

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)

  const document = await readJsonFile<BookDocument>(
    path.join(outDir, 'book-document.json')
  )
  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  assert(metadata.meta, 'invalid book metadata: missing meta')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const allowPartial = getEnv('ALLOW_PARTIAL') === 'true'

  console.log(
    `[export-markdown] rendering ${asin} (${document.status}, ${document.counts.succeeded}/${document.counts.expected} pages succeeded)`
  )

  const tocMarkdown = buildTocMarkdown(metadata.toc, document.pages)
  console.log(
    `[export-markdown] built table of contents (${metadata.toc.length} toc entries)`
  )

  const output = renderBookMarkdown({
    document,
    metadata,
    allowPartial,
    tocMarkdown
  })

  await fs.writeFile(path.join(outDir, 'book.md'), output)
  console.log(`[export-markdown] wrote ${path.join(outDir, 'book.md')}`)
  console.log(output)
}

await main()
