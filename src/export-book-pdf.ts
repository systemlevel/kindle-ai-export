import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

import PDFDocument from 'pdfkit'

import type { BookDocument } from './book-processing/types'
import type { BookMetadata } from './types'
import {
  createPdfRenderPlan,
  type PdfGapItem,
  type PdfHeadingItem,
  type PdfImageItem,
  type PdfParagraphItem,
  type PdfRenderItem,
  type PdfTitleItem
} from './book-processing/pdf-render-plan'
import { assert, getEnv, readJsonFile } from './utils'

export interface RenderBookPdfInput {
  document: BookDocument
  metadata: BookMetadata
  allowPartial: boolean
  /** Absolute or cwd-relative path to write the rendered PDF to. */
  outputPath: string
  /** Book output directory that every `PdfImageItem.path` is relative to. */
  outDir: string
}

const bodyFontSize = 12

/** Selects one of PDFKit's built-in Helvetica faces for a run's style
 * metadata. `small-caps` and `unknown` styles have no dedicated built-in
 * face, so they render in the regular weight rather than inventing a
 * substitute. */
function fontForRunStyles(styles: RawTextRunStyles): string {
  const bold = styles.includes('bold')
  const italic = styles.includes('italic')
  if (bold && italic) return 'Helvetica-BoldOblique'
  if (bold) return 'Helvetica-Bold'
  if (italic) return 'Helvetica-Oblique'
  return 'Helvetica'
}

type RawTextRunStyles = PdfParagraphItem['runs'][number]['styles']

function headingFontSize(level: number): number {
  if (level <= 1) return 22
  if (level === 2) return 18
  return 14
}

/** Shortens a full `knd:...` citation id to its first and last segments so
 * the per-item citation line stays compact and visually muted rather than
 * dominating the page - the full id remains recoverable from the exported
 * canonical `book-document.json`. */
function compactCitationId(citationId: string): string {
  const segments = citationId.split(':')
  if (segments.length <= 2) return citationId
  return `${segments[0]}:…:${segments.at(-1)}`
}

function renderCitationLine(doc: PDFKit.PDFDocument, citationId: string): void {
  doc.font('Helvetica').fontSize(8).fillColor('#888888')
  doc.text(compactCitationId(citationId))
  doc.fillColor('black').font('Helvetica').fontSize(bodyFontSize)
}

function renderTitleItem(doc: PDFKit.PDFDocument, item: PdfTitleItem): void {
  ;(doc as any).outline.addItem('Title Page')

  doc.font('Helvetica-Bold').fontSize(48)
  doc.y = doc.page.height / 2 - doc.heightOfString(item.text) / 2
  doc.text(item.text, { align: 'center' })
  const titleWidth = doc.widthOfString(item.text)

  if (item.authors.length) {
    const byline = `By ${item.authors.join(',\n')}`
    doc.font('Helvetica').fontSize(20)
    doc.y -= doc.heightOfString(byline) / 2
    doc.text(byline, {
      align: 'center',
      indent: titleWidth - doc.widthOfString(byline)
    })
  }

  doc.addPage()
  doc.font('Helvetica').fontSize(bodyFontSize)
}

function renderHeadingItem(
  doc: PDFKit.PDFDocument,
  item: PdfHeadingItem
): void {
  ;(doc as any).outline.addItem(item.text)

  doc.moveDown(1)
  doc.font('Helvetica-Bold').fontSize(headingFontSize(item.level))
  doc.text(item.text, { lineGap: 8 })

  doc.moveDown(0.25)
  renderCitationLine(doc, item.citationId)
  doc.moveDown(0.5)
}

function renderParagraphItem(
  doc: PDFKit.PDFDocument,
  item: PdfParagraphItem
): void {
  doc.font('Helvetica').fontSize(bodyFontSize)

  const lastRunIndex = item.runs.length - 1
  for (const [index, run] of item.runs.entries()) {
    doc.font(fontForRunStyles(run.styles))
    doc.text(run.text, {
      continued: index < lastRunIndex,
      lineGap: 4,
      paragraphGap: 8
    })
  }

  doc.moveDown(0.25)
  renderCitationLine(doc, item.citationId)
  doc.moveDown(0.5)
}

function renderImageItem(
  doc: PDFKit.PDFDocument,
  item: PdfImageItem,
  outDir: string
): void {
  if (item.path) {
    const contentWidth =
      doc.page.width - doc.page.margins.left - doc.page.margins.right
    // Only `width` is passed, so PDFKit scales the image's height
    // proportionally - the crop's aspect ratio is preserved while its
    // rendered width is bounded by the page's content area.
    doc.image(path.resolve(outDir, item.path), {
      width: contentWidth,
      align: 'center'
    })
    doc.moveDown(0.25)
  }

  if (item.caption) {
    doc.font('Helvetica-Oblique').fontSize(10)
    doc.text(item.caption, { align: 'center' })
    doc.font('Helvetica').fontSize(bodyFontSize)
    doc.moveDown(0.25)
  }

  renderCitationLine(doc, item.citationId)
  doc.moveDown(0.5)
}

/** Renders a non-succeeded page's gap marker inside a bordered warning
 * block, so a missing/failed page is visibly distinct from real content
 * rather than silently absent. Never invents replacement text - the
 * message only ever names the page's own capture id, printed page (when
 * known), and processing status. */
function renderGapItem(doc: PDFKit.PDFDocument, item: PdfGapItem): void {
  const contentWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right
  const printedPagePart =
    item.printedPage === null ? '' : ` (printed page ${item.printedPage})`
  const message = `Capture ${item.captureId}${printedPagePart}: processing ${item.status}`

  doc.moveDown(0.5)
  const top = doc.y

  doc.font('Helvetica-Oblique').fontSize(10).fillColor('#b00020')
  doc.text(message, { width: contentWidth })
  const bottom = doc.y

  doc
    .rect(
      doc.page.margins.left - 6,
      top - 6,
      contentWidth + 12,
      bottom - top + 12
    )
    .stroke('#b00020')

  doc.fillColor('black').font('Helvetica').fontSize(bodyFontSize)
  doc.moveDown(0.5)
}

export function renderPdfItem(
  doc: PDFKit.PDFDocument,
  item: PdfRenderItem,
  outDir: string
): void {
  switch (item.kind) {
    case 'title':
      renderTitleItem(doc, item)
      return
    case 'heading':
      renderHeadingItem(doc, item)
      return
    case 'paragraph':
      renderParagraphItem(doc, item)
      return
    case 'image':
      renderImageItem(doc, item, outDir)
      return
    case 'gap':
      renderGapItem(doc, item)
      return
  }
}

/**
 * Drives PDFKit around a pure {@link createPdfRenderPlan} plan: constructs
 * the document with the plan's title/author metadata, renders every item
 * in order (with a matching outline entry for the title page and every
 * heading), and awaits the output stream's `finish` event before
 * resolving. The output file is written with mode `0600` since a Kindle
 * book's page screenshots and OCR'd text are private to the owner.
 */
export async function renderBookPdf(input: RenderBookPdfInput): Promise<void> {
  const plan = createPdfRenderPlan(input)

  const doc = new PDFDocument({
    autoFirstPage: true,
    displayTitle: true,
    info: plan.info
  })
  const stream = doc.pipe(
    fs.createWriteStream(input.outputPath, { mode: 0o600 })
  )

  for (const item of plan.items) renderPdfItem(doc, item, input.outDir)

  doc.end()
  await finished(stream)
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

  const allowPartial = getEnv('ALLOW_PARTIAL') === 'true'
  const outputPath = path.join(outDir, 'book.pdf')

  console.log(
    `[export-pdf] rendering ${asin} (${document.status}, ${document.counts.succeeded}/${document.counts.expected} pages succeeded)`
  )

  await renderBookPdf({ document, metadata, allowPartial, outputPath, outDir })

  console.log(`[export-pdf] wrote ${outputPath}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  await main()
}
