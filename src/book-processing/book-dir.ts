import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Locates a book's output directory under `out/`.
 *
 * Books are captured into `out/<ASIN>/`, but the folder may later be renamed
 * to the book's title. A book can therefore be addressed either way:
 *
 *   - by folder name (the title, or the ASIN when it was never renamed), or
 *   - by ASIN, which is matched against `text-capture/capture-state.json`
 *     inside every folder under `out/`.
 *
 * Folder-name matches are case-insensitive so `BOOK="the options playbook"`
 * finds `out/The Options Playbook/`.
 */
export interface ResolvedBookDir {
  /** Absolute directory holding the book (`text-capture/`, `book-text.md`). */
  outDir: string
  /** Folder name as it appears under `out/` (title or ASIN). */
  folder: string
  /** Amazon ASIN, read from `capture-state.json` when the folder is a title. */
  asin: string
}

const captureStateRelativePath = path.join('text-capture', 'capture-state.json')

export async function resolveBookDir(
  cwd: string,
  book: string
): Promise<ResolvedBookDir> {
  const reference = book.trim()
  if (!reference) throw new Error('book reference must not be empty')

  const outRoot = path.resolve(cwd, 'out')
  const direct = path.resolve(outRoot, reference)
  if (!direct.startsWith(outRoot + path.sep)) {
    throw new Error(
      `book reference "${book}" must name a folder inside ${outRoot}`
    )
  }

  // Always go through the directory listing so the returned folder name keeps
  // its on-disk casing, even on case-insensitive file systems such as macOS.
  const books = await listBooks(outRoot)
  const wanted = reference.toLowerCase()
  const match =
    books.find((candidate) => candidate.folder === reference) ??
    books.find((candidate) => candidate.asin?.toLowerCase() === wanted) ??
    books.find((candidate) => candidate.folder.toLowerCase() === wanted)
  if (match) {
    return {
      outDir: match.outDir,
      folder: match.folder,
      asin: match.asin ?? match.folder
    }
  }

  const available = books.length
    ? books
        .map((candidate) =>
          candidate.asin && candidate.asin !== candidate.folder
            ? `${candidate.folder} (${candidate.asin})`
            : candidate.folder
        )
        .join(', ')
    : '(none)'
  throw new Error(
    `no book "${reference}" under ${outRoot}: no folder with that name and ` +
      `no capture-state.json with that ASIN. Available books: ${available}`
  )
}

interface BookCandidate {
  outDir: string
  folder: string
  asin: string | undefined
}

async function listBooks(outRoot: string): Promise<BookCandidate[]> {
  const entries = await fs
    .readdir(outRoot, { withFileTypes: true })
    .catch(() => [])
  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b))
  return Promise.all(
    folders.map(async (folder) => {
      const outDir = path.join(outRoot, folder)
      return { outDir, folder, asin: await readCapturedAsin(outDir) }
    })
  )
}

async function readCapturedAsin(outDir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(
      path.join(outDir, captureStateRelativePath),
      'utf8'
    )
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { asin?: unknown }).asin === 'string'
    ) {
      const asin = (parsed as { asin: string }).asin.trim()
      return asin || undefined
    }
  } catch {
    // Missing or unreadable state: the folder is still a valid book directory.
  }
  return undefined
}
