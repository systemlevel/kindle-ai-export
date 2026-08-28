import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, test } from 'vitest'

import type {
  AvailablePageSource,
  NormalizedRegion,
  ProcessorIdentity,
  RawBlockKind,
  RawCodexPage,
  RegionConfidence
} from '../../src/book-processing/types'
import { normalizePage } from '../../src/book-processing/normalize-page'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

const asin = 'TESTASIN'
const editionVersion = 'edition-1'

const processor: ProcessorIdentity = {
  runnerKind: 'codex-cli',
  codexCliVersion: '0.1.0',
  requestedModel: 'cli-default',
  promptVersion: '1',
  promptSha256: 'a'.repeat(64),
  outputSchemaVersion: '1',
  outputSchemaSha256: 'b'.repeat(64),
  normalizerVersion: '1',
  configurationHash: 'c'.repeat(64)
}

async function createOutDirWithSyntheticPage(): Promise<{
  outDir: string
  source: AvailablePageSource
}> {
  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kindle-normalize-page-')
  )
  temporaryDirectories.push(outDir)
  await fs.mkdir(path.join(outDir, 'pages'), { recursive: true })

  const rightHalf = await sharp({
    create: { width: 50, height: 50, channels: 4, background: '#ff0000ff' }
  })
    .png()
    .toBuffer()
  const png = await sharp({
    create: { width: 100, height: 50, channels: 4, background: '#ffffffff' }
  })
    .composite([{ input: rightHalf, left: 50, top: 0 }])
    .png()
    .toBuffer()

  const screenshotPath = 'pages/0000-0001.png'
  await fs.writeFile(path.join(outDir, screenshotPath), png)

  const source: AvailablePageSource = {
    captureId: 'c000000',
    index: 0,
    printedPage: 1,
    position: null,
    screenshotPath,
    rendererBatch: null,
    availability: 'available',
    screenshotSha256: createHash('sha256').update(png).digest('hex'),
    width: 100,
    height: 50
  }

  return { outDir, source }
}

function rawPageWithImage(
  options: {
    region?: NormalizedRegion | null
    regionConfidence?: RegionConfidence
    imageKind?: RawBlockKind
  } = {}
): RawCodexPage {
  const region =
    options.region === undefined
      ? { x: 500, y: 0, width: 500, height: 1000 }
      : options.region

  return {
    pageId: 'c000000',
    warnings: [],
    blocks: [
      {
        order: 0,
        kind: 'heading',
        runs: [
          { text: 'Synthetic', styles: [] },
          { text: ' heading', styles: [] }
        ],
        alignment: 'left',
        indentLevel: 0,
        headingLevel: 1,
        region: null,
        regionConfidence: 'unknown',
        mediaDescription: null,
        caption: null
      },
      {
        order: 1,
        kind: options.imageKind ?? 'image',
        runs: [],
        alignment: 'left',
        indentLevel: 0,
        headingLevel: null,
        region,
        regionConfidence: options.regionConfidence ?? 'high',
        mediaDescription: 'A colored rectangle',
        caption: null
      }
    ]
  }
}

describe('normalizePage', () => {
  test('derives text, citation, and a validated page crop', async () => {
    const { outDir, source } = await createOutDirWithSyntheticPage()
    const page = rawPageWithImage({
      region: { x: 500, y: 0, width: 500, height: 1000 },
      regionConfidence: 'high'
    })

    const result = await normalizePage({
      page,
      source,
      processor,
      asin,
      editionVersion,
      outDir
    })

    expect(result.blocks[0]).toMatchObject({
      blockId: 'b0000',
      text: 'Synthetic heading',
      citation: {
        id: expect.stringMatching(
          /^knd:TESTASIN:[a-f0-9]{12}:[a-f0-9]{12}:[a-f0-9]{12}:b0000$/
        )
      }
    })
    expect(result.blocks[1]!.mediaAsset).toMatchObject({
      width: 50,
      height: 50,
      derivation: 'page-crop'
    })
  })

  test('keeps full-page evidence without cropping low-confidence regions', async () => {
    const { outDir, source } = await createOutDirWithSyntheticPage()

    const result = await normalizePage({
      page: rawPageWithImage({ regionConfidence: 'low' }),
      source,
      processor,
      asin,
      editionVersion,
      outDir
    })

    expect(result.blocks[1]!.mediaAsset).toBeNull()
    expect(result.warnings).toContain(
      'Image block b0001 region confidence is low; retained full-page evidence'
    )
  })

  test('keeps full-page evidence and warns when a media block has no region', async () => {
    const { outDir, source } = await createOutDirWithSyntheticPage()

    const result = await normalizePage({
      page: rawPageWithImage({ region: null }),
      source,
      processor,
      asin,
      editionVersion,
      outDir
    })

    expect(result.blocks[1]!.mediaAsset).toBeNull()
    expect(result.warnings).toContain(
      'Image block b0001 has no region; retained full-page evidence'
    )
  })

  test('keeps full-page evidence and warns when a region is smaller than the minimum crop size', async () => {
    const { outDir, source } = await createOutDirWithSyntheticPage()

    const result = await normalizePage({
      page: rawPageWithImage({
        region: { x: 500, y: 0, width: 5, height: 5 },
        regionConfidence: 'high'
      }),
      source,
      processor,
      asin,
      editionVersion,
      outDir
    })

    expect(result.blocks[1]!.mediaAsset).toBeNull()
    expect(result.warnings).toContain(
      'Image block b0001 region is smaller than the minimum crop size; retained full-page evidence'
    )
  })

  test('labels a table block distinctly from an image block in warnings', async () => {
    const { outDir, source } = await createOutDirWithSyntheticPage()

    const result = await normalizePage({
      page: rawPageWithImage({ regionConfidence: 'low', imageKind: 'table' }),
      source,
      processor,
      asin,
      editionVersion,
      outDir
    })

    expect(result.warnings).toContain(
      'Table block b0001 region confidence is low; retained full-page evidence'
    )
  })

  test('never attaches a media asset or warning to non-media blocks', async () => {
    const { outDir, source } = await createOutDirWithSyntheticPage()

    const result = await normalizePage({
      page: rawPageWithImage({ regionConfidence: 'low' }),
      source,
      processor,
      asin,
      editionVersion,
      outDir
    })

    expect(result.blocks[0]!.mediaAsset).toBeNull()
    expect(result.warnings.some((warning) => warning.includes('b0000'))).toBe(
      false
    )
  })

  test('preserves block array order without sorting', async () => {
    const { outDir, source } = await createOutDirWithSyntheticPage()
    const page: RawCodexPage = {
      pageId: 'c000000',
      warnings: [],
      blocks: [
        {
          order: 0,
          kind: 'paragraph',
          runs: [{ text: 'first', styles: [] }],
          alignment: 'left',
          indentLevel: 0,
          headingLevel: null,
          region: null,
          regionConfidence: 'unknown',
          mediaDescription: null,
          caption: null
        },
        {
          order: 1,
          kind: 'paragraph',
          runs: [{ text: 'second', styles: [] }],
          alignment: 'left',
          indentLevel: 0,
          headingLevel: null,
          region: null,
          regionConfidence: 'unknown',
          mediaDescription: null,
          caption: null
        },
        {
          order: 2,
          kind: 'paragraph',
          runs: [{ text: 'third', styles: [] }],
          alignment: 'left',
          indentLevel: 0,
          headingLevel: null,
          region: null,
          regionConfidence: 'unknown',
          mediaDescription: null,
          caption: null
        }
      ]
    }

    const result = await normalizePage({
      page,
      source,
      processor,
      asin,
      editionVersion,
      outDir
    })

    expect(result.blocks.map((block) => [block.blockId, block.text])).toEqual([
      ['b0000', 'first'],
      ['b0001', 'second'],
      ['b0002', 'third']
    ])
  })

  test('merges model-reported page warnings with locally-derived warnings', async () => {
    const { outDir, source } = await createOutDirWithSyntheticPage()
    const page = rawPageWithImage({ regionConfidence: 'low' })
    page.warnings = ['Codex reported low overall confidence for this page']

    const result = await normalizePage({
      page,
      source,
      processor,
      asin,
      editionVersion,
      outDir
    })

    expect(result.warnings).toEqual([
      'Codex reported low overall confidence for this page',
      'Image block b0001 region confidence is low; retained full-page evidence'
    ])
  })

  test('writes a hashed, mode-0600 crop asset that matches the file on disk', async () => {
    const { outDir, source } = await createOutDirWithSyntheticPage()
    const page = rawPageWithImage({
      region: { x: 500, y: 0, width: 500, height: 1000 },
      regionConfidence: 'medium'
    })

    const result = await normalizePage({
      page,
      source,
      processor,
      asin,
      editionVersion,
      outDir
    })

    const mediaAsset = result.blocks[1]!.mediaAsset
    expect(mediaAsset).not.toBeNull()
    expect(mediaAsset!.path).toBe('assets/c000000/b0001.png')
    expect(mediaAsset!.mimeType).toBe('image/png')
    expect(mediaAsset!.sourceScreenshotSha256).toBe(source.screenshotSha256)
    expect(mediaAsset!.pixelCrop).toEqual({
      left: 50,
      top: 0,
      width: 50,
      height: 50
    })

    const writtenPath = path.join(outDir, mediaAsset!.path)
    const writtenBytes = await fs.readFile(writtenPath)
    expect(mediaAsset!.sha256).toBe(
      createHash('sha256').update(writtenBytes).digest('hex')
    )

    const stat = await fs.stat(writtenPath)
    expect(stat.mode & 0o777).toBe(0o600)

    const writtenMetadata = await sharp(writtenBytes).metadata()
    expect(writtenMetadata.width).toBe(50)
    expect(writtenMetadata.height).toBe(50)
  })

  test('crop dimensions equal the floor/ceil pixel rectangle computed from the region', async () => {
    const outDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'kindle-normalize-page-')
    )
    temporaryDirectories.push(outDir)
    await fs.mkdir(path.join(outDir, 'pages'), { recursive: true })

    // Deliberately non-round source dimensions and region bounds so the
    // floor/ceil pixel conversion in pixelCropFor doesn't collapse to a
    // trivial exact multiple.
    const sourceWidth = 137
    const sourceHeight = 101
    const png = await sharp({
      create: {
        width: sourceWidth,
        height: sourceHeight,
        channels: 4,
        background: '#123456ff'
      }
    })
      .png()
      .toBuffer()

    const screenshotPath = 'pages/0000-0002.png'
    await fs.writeFile(path.join(outDir, screenshotPath), png)

    const source: AvailablePageSource = {
      captureId: 'c000001',
      index: 0,
      printedPage: 1,
      position: null,
      screenshotPath,
      rendererBatch: null,
      availability: 'available',
      screenshotSha256: createHash('sha256').update(png).digest('hex'),
      width: sourceWidth,
      height: sourceHeight
    }

    const region: NormalizedRegion = { x: 210, y: 130, width: 460, height: 540 }
    const page = rawPageWithImage({ region, regionConfidence: 'high' })

    const result = await normalizePage({
      page,
      source,
      processor,
      asin,
      editionVersion,
      outDir
    })

    // Mirrors pixelCropFor in media-assets.ts: floor the top-left corner,
    // ceil the bottom-right corner (before edge clamping, which doesn't
    // engage for this in-bounds region).
    const expectedLeft = Math.floor((region.x / 1000) * sourceWidth)
    const expectedTop = Math.floor((region.y / 1000) * sourceHeight)
    const expectedRight = Math.ceil(
      ((region.x + region.width) / 1000) * sourceWidth
    )
    const expectedBottom = Math.ceil(
      ((region.y + region.height) / 1000) * sourceHeight
    )
    const expectedWidth = expectedRight - expectedLeft
    const expectedHeight = expectedBottom - expectedTop

    const mediaAsset = result.blocks[1]!.mediaAsset
    expect(mediaAsset).not.toBeNull()
    expect(mediaAsset!.pixelCrop).toEqual({
      left: expectedLeft,
      top: expectedTop,
      width: expectedWidth,
      height: expectedHeight
    })
    expect(mediaAsset!.width).toBe(expectedWidth)
    expect(mediaAsset!.height).toBe(expectedHeight)
  })

  test('produces a different citation id when processor configuration changes', async () => {
    const { outDir, source } = await createOutDirWithSyntheticPage()
    const page = rawPageWithImage({ regionConfidence: 'low' })

    const first = await normalizePage({
      page,
      source,
      processor,
      asin,
      editionVersion,
      outDir
    })
    const second = await normalizePage({
      page,
      source,
      processor: { ...processor, configurationHash: 'f'.repeat(64) },
      asin,
      editionVersion,
      outDir
    })

    expect(first.blocks[0]!.citation.id).not.toBe(second.blocks[0]!.citation.id)
    expect(first.blocks[0]!.citation.processorConfigurationHash).toBe(
      processor.configurationHash
    )
  })
})
