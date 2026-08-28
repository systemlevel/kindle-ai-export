import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, test } from 'vitest'

import type { BookMetadata } from '../../src/types'
import { buildPageSources } from '../../src/book-processing/page-source'

const temporaryDirectories: string[] = []

function metadataFor(screenshot: string, index = 0): BookMetadata {
  return {
    pages: [{ index, page: 1, screenshot }]
  } as BookMetadata
}

async function createOutDir(): Promise<string> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-page-source-'))
  temporaryDirectories.push(outDir)
  await fs.mkdir(path.join(outDir, 'pages'), { recursive: true })
  return outDir
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('buildPageSources', () => {
  test('builds immutable page evidence from metadata', async () => {
    const outDir = await createOutDir()
    const png = await sharp({
      create: { width: 20, height: 10, channels: 4, background: '#ffffff' }
    })
      .png()
      .toBuffer()
    await fs.writeFile(path.join(outDir, 'pages', '0000-0001.png'), png)

    const sources = await buildPageSources(
      metadataFor('pages/0000-0001.png'),
      outDir
    )

    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      captureId: 'c000000',
      index: 0,
      printedPage: 1,
      position: null,
      screenshotPath: 'pages/0000-0001.png',
      rendererBatch: null,
      availability: 'available',
      width: 20,
      height: 10,
      screenshotSha256: createHash('sha256').update(png).digest('hex')
    })
  })

  test('retains an expected page when its screenshot is unavailable', async () => {
    const outDir = await createOutDir()

    const [source] = await buildPageSources(
      metadataFor('pages/missing.png'),
      outDir
    )

    expect(source).toMatchObject({
      captureId: 'c000000',
      availability: 'unavailable',
      screenshotPath: 'pages/missing.png',
      screenshotSha256: null,
      width: null,
      height: null,
      sourceFailure: { category: 'source', code: 'screenshot-unreadable' }
    })
  })

  test('retains a path escape as unavailable evidence', async () => {
    const outDir = await createOutDir()

    const [source] = await buildPageSources(
      metadataFor('../outside.png'),
      outDir
    )

    expect(source).toMatchObject({
      captureId: 'c000000',
      availability: 'unavailable',
      screenshotSha256: null,
      width: null,
      height: null,
      sourceFailure: {
        category: 'source',
        code: 'screenshot-path-outside-book'
      }
    })
  })

  test('preserves metadata array order while assigning stable capture IDs', async () => {
    const outDir = await createOutDir()
    const metadata = {
      ...metadataFor('pages/missing-first.png', 9),
      pages: [
        { index: 9, page: 9, screenshot: 'pages/missing-first.png' },
        { index: 3, page: 3, screenshot: 'pages/missing-second.png' }
      ]
    }

    const sources = await buildPageSources(metadata, outDir)

    expect(
      sources.map((source) => [
        source.captureId,
        source.index,
        source.printedPage
      ])
    ).toEqual([
      ['c000000', 0, 9],
      ['c000001', 1, 3]
    ])
  })

  test('rejects duplicate metadata indexes', async () => {
    const outDir = await createOutDir()
    const metadata = {
      ...metadataFor('pages/missing-first.png'),
      pages: [
        { index: 1, page: 1, screenshot: 'pages/missing-first.png' },
        { index: 1, page: 2, screenshot: 'pages/missing-second.png' }
      ]
    }

    await expect(buildPageSources(metadata, outDir)).rejects.toThrow(
      'Metadata page indexes must be unique'
    )
  })
})
