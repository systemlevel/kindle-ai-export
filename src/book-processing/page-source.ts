import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import sharp from 'sharp'

import type { BookMetadata } from '../types'
import type { PageSource, ProcessingFailure } from './types'

class ScreenshotPathOutsideBookError extends Error {}

function isWithinDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate)
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  )
}

function resolveBookScreenshotPath(
  screenshotPath: string,
  outDir: string
): string {
  const absoluteOutDir = path.resolve(outDir)
  const candidates = path.isAbsolute(screenshotPath)
    ? [path.resolve(screenshotPath)]
    : [
        path.resolve(screenshotPath),
        path.resolve(absoluteOutDir, screenshotPath)
      ]
  const resolvedPath = candidates.find((candidate) =>
    isWithinDirectory(candidate, absoluteOutDir)
  )

  if (!resolvedPath) {
    throw new ScreenshotPathOutsideBookError()
  }

  return resolvedPath
}

async function resolvePhysicalBookScreenshotPath(
  screenshotPath: string,
  outDir: string
): Promise<string> {
  const absolutePath = resolveBookScreenshotPath(screenshotPath, outDir)
  const [realOutDir, realScreenshotPath] = await Promise.all([
    fs.realpath(outDir),
    fs.realpath(absolutePath)
  ])

  if (!isWithinDirectory(realScreenshotPath, realOutDir)) {
    throw new ScreenshotPathOutsideBookError()
  }

  return realScreenshotPath
}

function normalizeBookRelativePath(
  screenshotPath: string,
  outDir: string
): string {
  return path
    .relative(
      path.resolve(outDir),
      resolveBookScreenshotPath(screenshotPath, outDir)
    )
    .split(path.sep)
    .join('/')
}

function sourceFailureFor(
  error: unknown,
  captureId: string
): ProcessingFailure {
  const pathOutsideBook = error instanceof ScreenshotPathOutsideBookError

  return {
    category: 'source',
    code: pathOutsideBook
      ? 'screenshot-path-outside-book'
      : 'screenshot-unreadable',
    message: pathOutsideBook
      ? `Screenshot for ${captureId} is outside the book output directory`
      : `Screenshot for ${captureId} could not be read or decoded`,
    attempts: 1,
    occurredAt: new Date().toISOString(),
    exitCode: null,
    signal: null
  }
}

function unavailableScreenshotPath(captureId: string): string {
  return `pages/${captureId}.unavailable.png`
}

function assertUniqueMetadataIndexes(metadata: BookMetadata): void {
  const indexes = new Set<number>()

  for (const page of metadata.pages) {
    if (indexes.has(page.index)) {
      throw new Error('Metadata page indexes must be unique')
    }
    indexes.add(page.index)
  }
}

export async function buildPageSources(
  metadata: BookMetadata,
  outDir: string
): Promise<PageSource[]> {
  assertUniqueMetadataIndexes(metadata)

  return Promise.all(
    metadata.pages.map(async (page, index) => {
      const captureId = `c${String(index).padStart(6, '0')}`
      let screenshotPath = unavailableScreenshotPath(captureId)

      try {
        screenshotPath = normalizeBookRelativePath(page.screenshot, outDir)
        const absolutePath = await resolvePhysicalBookScreenshotPath(
          screenshotPath,
          outDir
        )
        const bytes = await fs.readFile(absolutePath)
        const image = await sharp(bytes).metadata()

        if (image.format !== 'png' || !image.width || !image.height) {
          throw new Error('Screenshot dimensions are missing')
        }

        return {
          captureId,
          index,
          printedPage: page.page ?? null,
          position: null,
          screenshotPath,
          rendererBatch: null,
          availability: 'available' as const,
          screenshotSha256: createHash('sha256').update(bytes).digest('hex'),
          width: image.width,
          height: image.height
        }
      } catch (err) {
        return {
          captureId,
          index,
          printedPage: page.page ?? null,
          position: null,
          screenshotPath,
          rendererBatch: null,
          availability: 'unavailable' as const,
          screenshotSha256: null,
          width: null,
          height: null,
          sourceFailure: sourceFailureFor(err, captureId)
        }
      }
    })
  )
}
