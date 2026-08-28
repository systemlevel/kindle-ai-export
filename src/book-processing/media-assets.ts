import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import sharp from 'sharp'

import type {
  AvailablePageSource,
  MediaAsset,
  NormalizedRegion,
  PixelCrop,
  RawCodexBlock
} from './types'

/** Region coordinates are normalized to a 0-1000 scale in both axes. */
const normalizedSpan = 1000
/** Minimum region width/height, in normalized units, eligible for cropping. */
const minimumRegionUnits = 10

interface CropEligibility {
  eligible: boolean
  /** Human-readable reason the block was not cropped, or null when eligible
   * or when the block kind never produces media (e.g. a paragraph). */
  reason: string | null
}

export interface MediaAssetInput {
  source: AvailablePageSource
  outDir: string
  block: RawCodexBlock
  blockId: string
}

function evaluateCropEligibility(block: RawCodexBlock): CropEligibility {
  if (block.kind !== 'image' && block.kind !== 'table') {
    return { eligible: false, reason: null }
  }
  if (!block.region) {
    return { eligible: false, reason: 'has no region' }
  }
  if (
    block.regionConfidence !== 'high' &&
    block.regionConfidence !== 'medium'
  ) {
    return {
      eligible: false,
      reason: `region confidence is ${block.regionConfidence}`
    }
  }
  if (
    block.region.width < minimumRegionUnits ||
    block.region.height < minimumRegionUnits
  ) {
    return {
      eligible: false,
      reason: 'region is smaller than the minimum crop size'
    }
  }
  return { eligible: true, reason: null }
}

/**
 * Converts a normalized 0-1000 region into a pixel rectangle against the
 * source image's actual dimensions. Uses floor for the top-left corner and
 * ceil for the bottom-right corner so the crop never excludes partial
 * pixels covered by the region, then clamps the result to the source image
 * bounds to absorb any rounding overshoot at the edges.
 */
function pixelCropFor(
  region: NormalizedRegion,
  width: number,
  height: number
): PixelCrop {
  const left = Math.floor((region.x / normalizedSpan) * width)
  const top = Math.floor((region.y / normalizedSpan) * height)
  const right = Math.ceil(((region.x + region.width) / normalizedSpan) * width)
  const bottom = Math.ceil(
    ((region.y + region.height) / normalizedSpan) * height
  )

  const clampedLeft = Math.min(Math.max(left, 0), width)
  const clampedTop = Math.min(Math.max(top, 0), height)
  const clampedRight = Math.min(Math.max(right, clampedLeft), width)
  const clampedBottom = Math.min(Math.max(bottom, clampedTop), height)

  return {
    left: clampedLeft,
    top: clampedTop,
    width: clampedRight - clampedLeft,
    height: clampedBottom - clampedTop
  }
}

/**
 * Crops an eligible image/table block's region out of the page screenshot
 * and writes it as a validated evidence asset. Returns null (never throws)
 * for any block that is not eligible for cropping or whose crop could not
 * be produced and verified; the full-page screenshot remains the canonical
 * evidence in that case.
 */
export async function createMediaAsset(
  input: MediaAssetInput
): Promise<MediaAsset | null> {
  const { block, blockId, source, outDir } = input
  const eligibility = evaluateCropEligibility(block)
  if (!eligibility.eligible || !block.region) return null

  const pixelCrop = pixelCropFor(block.region, source.width, source.height)
  if (pixelCrop.width <= 0 || pixelCrop.height <= 0) return null

  const screenshotAbsolutePath = path.resolve(outDir, source.screenshotPath)

  let croppedBuffer: Buffer
  try {
    croppedBuffer = await sharp(screenshotAbsolutePath)
      .extract(pixelCrop)
      .png()
      .toBuffer()
  } catch (err) {
    console.error(
      `media crop (extract) failed for ${source.captureId}/${blockId} at ${screenshotAbsolutePath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return null
  }

  const assetRelativePath = path.posix.join(
    'assets',
    source.captureId,
    `${blockId}.png`
  )
  const assetAbsolutePath = path.resolve(outDir, assetRelativePath)

  try {
    await fs.mkdir(path.dirname(assetAbsolutePath), { recursive: true })
    await fs.writeFile(assetAbsolutePath, croppedBuffer, { mode: 0o600 })
    // fs.writeFile only applies `mode` when creating a new file, so an
    // overwrite of a pre-existing crop asset would silently keep its old
    // permissions. Force 0600 unconditionally after every write.
    await fs.chmod(assetAbsolutePath, 0o600)
  } catch (err) {
    console.error(
      `media crop (write) failed for ${source.captureId}/${blockId} at ${assetAbsolutePath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return null
  }

  let metadata: sharp.Metadata
  try {
    metadata = await sharp(assetAbsolutePath).metadata()
  } catch (err) {
    console.error(
      `media crop (verify) failed for ${source.captureId}/${blockId} at ${assetAbsolutePath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return null
  }
  if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
    return null
  }

  const writtenBytes = await fs.readFile(assetAbsolutePath)

  return {
    path: assetRelativePath,
    mimeType: 'image/png',
    width: metadata.width,
    height: metadata.height,
    sha256: createHash('sha256').update(writtenBytes).digest('hex'),
    sourceScreenshotSha256: source.screenshotSha256,
    pixelCrop,
    derivation: 'page-crop'
  }
}

/**
 * Describes why an image/table block retained full-page evidence instead
 * of a crop. Returns null for non-media blocks, which never warrant this
 * warning. Callers should only invoke this for blocks whose media asset
 * ended up null.
 */
export function describeMissingMediaAsset(
  block: RawCodexBlock,
  blockId: string
): string | null {
  if (block.kind !== 'image' && block.kind !== 'table') return null

  const eligibility = evaluateCropEligibility(block)
  const label = block.kind === 'image' ? 'Image' : 'Table'
  const reason = eligibility.reason ?? 'region crop could not be generated'
  return `${label} block ${blockId} ${reason}; retained full-page evidence`
}
