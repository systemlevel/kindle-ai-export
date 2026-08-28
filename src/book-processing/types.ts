export const rawBlockKinds = [
  'heading',
  'paragraph',
  'list-item',
  'quote',
  'caption',
  'image',
  'table',
  'footnote',
  'page-number',
  'other'
] as const

export type RawBlockKind = (typeof rawBlockKinds)[number]
export type TextStyle = 'bold' | 'italic' | 'small-caps' | 'unknown'
export type RegionConfidence = 'high' | 'medium' | 'low' | 'unknown'
export type Alignment = 'left' | 'center' | 'right' | 'justified' | 'unknown'

export interface NormalizedRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface RawTextRun {
  text: string
  styles: TextStyle[]
}

export interface RawCodexBlock {
  order: number
  kind: RawBlockKind
  runs: RawTextRun[]
  alignment: Alignment
  indentLevel: number
  headingLevel: number | null
  region: NormalizedRegion | null
  regionConfidence: RegionConfidence
  mediaDescription: string | null
  caption: string | null
}

export interface RawCodexPage {
  pageId: string
  blocks: RawCodexBlock[]
  warnings: string[]
}

export interface RawCodexBatch {
  schemaVersion: '1'
  pages: RawCodexPage[]
}

export type ProcessingFailureCategory =
  | 'configuration'
  | 'source'
  | 'transient-service'
  | 'timeout'
  | 'protocol'
  | 'content-validation'
  | 'diagnostic-overflow'
  | 'cancelled'

export interface ProcessingFailure {
  category: ProcessingFailureCategory
  code: string
  message: string
  attempts: number
  occurredAt: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface PageSourceBase {
  captureId: string
  index: number
  printedPage: number | null
  position: { start: number; end: number } | null
  screenshotPath: string
  rendererBatch: string | null
}

export interface AvailablePageSource extends PageSourceBase {
  availability: 'available'
  screenshotSha256: string
  width: number
  height: number
}

export interface UnavailablePageSource extends PageSourceBase {
  availability: 'unavailable'
  screenshotSha256: null
  width: null
  height: null
  sourceFailure: ProcessingFailure
}

export type PageSource = AvailablePageSource | UnavailablePageSource

export interface ProcessorIdentity {
  runnerKind: 'codex-cli'
  codexCliVersion: string
  requestedModel: string
  promptVersion: string
  promptSha256: string
  outputSchemaVersion: string
  outputSchemaSha256: string
  normalizerVersion: string
  configurationHash: string
}

export interface ProcessingProvenance {
  runnerKind: 'codex-cli'
  codexCliVersion: string
  requestedModel: string
  promptVersion: string
  outputSchemaVersion: string
  normalizerVersion: string
  configurationHash: string
  pageCacheKey: string
  runId: string
  batchId: string
  attempts: number
  completedAt: string
}

export interface PixelCrop {
  left: number
  top: number
  width: number
  height: number
}

export interface MediaAsset {
  path: string
  mimeType: 'image/png'
  width: number
  height: number
  sha256: string
  sourceScreenshotSha256: string
  pixelCrop: PixelCrop
  derivation: 'page-crop'
}

export interface Citation {
  id: string
  asin: string
  editionVersion: string
  captureId: string
  captureIndex: number
  printedPage: number | null
  position: { start: number; end: number } | null
  screenshotPath: string
  screenshotSha256: string
  blockId: string
  blockKind: RawBlockKind
  region: NormalizedRegion | null
  processorConfigurationHash: string
}

export interface NormalizedBlock extends RawCodexBlock {
  blockId: string
  text: string
  citation: Citation
  mediaAsset: MediaAsset | null
}

export interface NormalizedPageDocument {
  source: AvailablePageSource
  blocks: NormalizedBlock[]
  warnings: string[]
}

export interface SucceededPageCheckpoint {
  status: 'succeeded'
  source: AvailablePageSource
  provenance: ProcessingProvenance
  document: NormalizedPageDocument
}

export interface FailedPageCheckpoint {
  status: 'failed'
  source: PageSource
  provenance: ProcessingProvenance
  failure: ProcessingFailure
}

export type PageCheckpoint = SucceededPageCheckpoint | FailedPageCheckpoint

export interface PendingBookPageRecord {
  status: 'pending'
  source: PageSource
}

export interface CancelledBookPageRecord {
  status: 'cancelled'
  source: PageSource
}

export type BookPageRecord =
  | PageCheckpoint
  | PendingBookPageRecord
  | CancelledBookPageRecord

export interface AggregateCounts {
  expected: number
  captured: number
  succeeded: number
  failed: number
  pending: number
}

export type BookStatus = 'complete' | 'partial' | 'failed' | 'cancelled'

export interface BookIdentity {
  asin: string
  editionVersion: string
  title: string
  authors: string[]
}

export interface BookDocument {
  schemaVersion: '1'
  book: BookIdentity
  processor: ProcessorIdentity
  status: BookStatus
  counts: AggregateCounts
  pages: BookPageRecord[]
}

export type ProcessingRunStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'partial'
  | 'failed'
  | 'cancelled'

export interface ProcessingState {
  runId: string
  status: ProcessingRunStatus
  startedAt: string
  completedAt: string | null
  activeBatchIds: string[]
  counts: AggregateCounts
}
