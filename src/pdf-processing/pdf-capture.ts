import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'

import { inspectPdf, renderPdfPage } from './pdf-renderer'

export interface PdfCaptureOptions {
  sourcePath: string
  outRoot: string
  bookName?: string
  dpi: number
  analyzeOnly?: boolean
  log?: { info: (message: string) => void }
}

export interface PdfCaptureDependencies {
  inspectPdf: typeof inspectPdf
  renderPdfPage: typeof renderPdfPage
}

interface PdfManifest {
  version: 1
  type: 'pdf'
  sourceHash: string
  pageCount: number
  dpi: number
  pages: Record<string, string>
}

const defaultDependencies = { inspectPdf, renderPdfPage }
const hashPattern = /^[a-f0-9]{64}$/

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function regularFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath)
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${filePath}`)
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${filePath}`)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true })
  const stat = await fs.lstat(directory)
  if (stat.isSymbolicLink())
    throw new Error(`Refusing symlink directory: ${directory}`)
  if (!stat.isDirectory()) throw new Error(`Expected a directory: ${directory}`)
}

async function assertSafeOutputTree(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink())
      throw new Error(`Refusing symlink in PDF output: ${entryPath}`)
    if (entry.isDirectory()) await assertSafeOutputTree(entryPath)
  }
}

export function validatePdfBookName(name: string): void {
  if (
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    /[/\\]/.test(name) ||
    [...name].some((character) => (character.codePointAt(0) ?? 0) < 32)
  ) {
    throw new Error(
      'PDF_BOOK must be a single folder name without path separators or traversal.'
    )
  }
}

async function writeManifest(
  filePath: string,
  manifest: PdfManifest
): Promise<void> {
  const temporaryPath = `${filePath}.tmp`
  await regularFileExists(temporaryPath)
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await fs.rename(temporaryPath, filePath)
}

function parseManifest(value: unknown): PdfManifest {
  const manifest = value as PdfManifest | null
  if (
    !manifest ||
    manifest.version !== 1 ||
    manifest.type !== 'pdf' ||
    typeof manifest.sourceHash !== 'string' ||
    !hashPattern.test(manifest.sourceHash) ||
    !Number.isSafeInteger(manifest.pageCount) ||
    manifest.pageCount < 1 ||
    manifest.pageCount > 100_000 ||
    !Number.isInteger(manifest.dpi) ||
    manifest.dpi < 72 ||
    manifest.dpi > 600 ||
    !manifest.pages ||
    typeof manifest.pages !== 'object' ||
    Array.isArray(manifest.pages)
  ) {
    throw new Error(
      'Invalid PDF capture manifest. Choose a new PDF_BOOK folder.'
    )
  }
  for (const [name, hash] of Object.entries(manifest.pages)) {
    if (
      !/^page-\d+\.png$/.test(name) ||
      typeof hash !== 'string' ||
      !hashPattern.test(hash)
    ) {
      throw new Error(
        'Invalid page entry in PDF capture manifest. Choose a new PDF_BOOK folder.'
      )
    }
  }
  return manifest
}

/** Bind resumable images and AI caches to an immutable PDF snapshot. */
export async function capturePdfBook(
  options: PdfCaptureOptions,
  dependencies: PdfCaptureDependencies = defaultDependencies,
  onCaptured?: (result: { bookDir: string; pageCount: number }) => Promise<void>
): Promise<{ bookDir: string; pageCount: number }> {
  if (!Number.isInteger(options.dpi) || options.dpi < 72 || options.dpi > 600) {
    throw new Error('PDF_DPI must be an integer between 72 and 600.')
  }
  const sourcePath = path.resolve(options.sourcePath)
  if (!(await fs.stat(sourcePath)).isFile())
    throw new Error(`Not a PDF file: ${sourcePath}`)
  const sourceHash = await hashFile(sourcePath)
  const slug =
    path
      .basename(sourcePath, path.extname(sourcePath))
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-|-$/g, '')
      .slice(0, 80) || 'book'
  const bookName = options.bookName ?? `pdf-${slug}-${sourceHash.slice(0, 12)}`
  validatePdfBookName(bookName)
  const bookDir = path.resolve(options.outRoot, bookName)
  const manifestPath = path.join(bookDir, 'pdf-capture.json')

  // Check provenance before making any changes to an existing book directory.
  let existingEntries: string[] = []
  try {
    if ((await fs.lstat(bookDir)).isSymbolicLink())
      throw new Error(`Refusing symlink directory: ${bookDir}`)
    existingEntries = await fs.readdir(bookDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (
    existingEntries.length > 0 &&
    !existingEntries.includes('pdf-capture.json')
  ) {
    throw new Error(
      `Destination is not a PDF capture folder: ${bookDir}. Choose a new PDF_BOOK.`
    )
  }
  if (options.analyzeOnly && !existingEntries.includes('pdf-capture.json')) {
    throw new Error('No PDF capture exists. Run without ANALYZE_ONLY first.')
  }
  await ensureDirectory(options.outRoot)
  await ensureDirectory(bookDir)
  const lockPath = path.join(bookDir, '.pdf-capture.lock')
  let lock
  try {
    lock = await fs.open(lockPath, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `PDF capture lock exists: ${lockPath}. Another run may be active. Remove this lock only after confirming that run has stopped.`
      )
    }
    throw err
  }
  try {
    await lock.writeFile(`${process.pid}\n`)
    await lock.close()
    await assertSafeOutputTree(bookDir)
    let manifest: PdfManifest
    if (await regularFileExists(manifestPath)) {
      manifest = parseManifest(
        JSON.parse(await fs.readFile(manifestPath, 'utf8'))
      )
      if (manifest.sourceHash !== sourceHash)
        throw new Error(
          'This folder belongs to a different PDF. Choose a new PDF_BOOK.'
        )
      if (manifest.dpi !== options.dpi)
        throw new Error(
          'PDF resolution differs from this capture. Use the original PDF_DPI or a new PDF_BOOK.'
        )
    } else {
      const { pageCount } = await dependencies.inspectPdf(sourcePath)
      manifest = parseManifest({
        version: 1,
        type: 'pdf',
        sourceHash,
        pageCount,
        dpi: options.dpi,
        pages: {}
      })
      await writeManifest(manifestPath, manifest)
    }

    const snapshotPath = path.join(bookDir, 'source.pdf')
    if (!(await regularFileExists(snapshotPath))) {
      if (options.analyzeOnly)
        throw new Error(
          'PDF source snapshot is missing. Run capture again first.'
        )
      const temporarySnapshot = path.join(bookDir, 'source.pdf.tmp')
      await regularFileExists(temporarySnapshot)
      await fs.copyFile(sourcePath, temporarySnapshot)
      if ((await hashFile(temporarySnapshot)) !== sourceHash)
        throw new Error(
          'PDF changed while taking its snapshot. Run again with a stable source file.'
        )
      await fs.rename(temporarySnapshot, snapshotPath)
    }
    if ((await hashFile(snapshotPath)) !== sourceHash)
      throw new Error(
        'PDF source snapshot has changed. Choose a new PDF_BOOK folder.'
      )

    const captureDir = path.join(bookDir, 'text-capture')
    await ensureDirectory(captureDir)
    const width = Math.max(4, String(manifest.pageCount).length)
    const pageNames = Array.from(
      { length: manifest.pageCount },
      (_, index) => `page-${String(index + 1).padStart(width, '0')}.png`
    )
    const expectedNames = new Set(pageNames)
    const temporaryNames = new Set(
      pageNames.map((name) => `${name.slice(0, -4)}.rendering.png`)
    )
    const unexpected = (await fs.readdir(captureDir)).filter(
      (name) =>
        /\.png$/i.test(name) &&
        !expectedNames.has(name) &&
        !temporaryNames.has(name)
    )
    if (
      unexpected.length ||
      Object.keys(manifest.pages).some((name) => !expectedNames.has(name))
    ) {
      throw new Error(
        `Unexpected PNG pages or manifest entries in PDF capture: ${unexpected.join(', ')}. Choose a new PDF_BOOK folder.`
      )
    }
    // A hard stop can leave an uncommitted render. Never let the analyzer see it.
    for (const name of temporaryNames) {
      const temporaryPath = path.join(captureDir, name)
      if (await regularFileExists(temporaryPath)) await fs.rm(temporaryPath)
    }

    for (const [index, name] of pageNames.entries()) {
      const imagePath = path.join(captureDir, name)
      const exists = await regularFileExists(imagePath)
      if (
        exists &&
        manifest.pages[name] &&
        (await hashFile(imagePath)) === manifest.pages[name]
      )
        continue
      if (options.analyzeOnly)
        throw new Error(
          `PDF capture page ${name} is missing or changed. Run without ANALYZE_ONLY to repair it.`
        )

      // The shared analyzer trusts cached JSON, so invalidate it before replacing an image.
      await fs.rm(imagePath.replace(/\.png$/, '.json'), { force: true })
      await fs.rm(path.join(bookDir, 'book-text.md'), { force: true })
      delete manifest.pages[name]
      await writeManifest(manifestPath, manifest)
      const temporaryImage = path.join(
        captureDir,
        `${name.slice(0, -4)}.rendering.png`
      )
      await regularFileExists(temporaryImage)
      options.log?.info(
        `[pdf] Rendering page ${index + 1}/${manifest.pageCount}`
      )
      try {
        await dependencies.renderPdfPage({
          pdfPath: snapshotPath,
          pageNumber: index + 1,
          dpi: options.dpi,
          outputPath: temporaryImage
        })
        const imageHash = await hashFile(temporaryImage)
        await fs.rename(temporaryImage, imagePath)
        manifest.pages[name] = imageHash
        await writeManifest(manifestPath, manifest)
      } finally {
        await fs.rm(temporaryImage, { force: true })
      }
    }
    const result = { bookDir, pageCount: manifest.pageCount }
    await onCaptured?.(result)
    return result
  } finally {
    await lock.close()
    await fs.rm(lockPath, { force: true })
  }
}
