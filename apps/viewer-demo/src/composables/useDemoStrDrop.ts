import type { FileViewerFolderEntry } from '@file-viewer/core'

export type DemoDropPayload = {
  /** Bundle-relative entries, already normalised for the viewer. */
  entries: FileViewerFolderEntry[]
  /** Loose files, kept for the degenerate single-file cases. */
  files: File[]
  /** How many real directories were traversed (0 means only plain files). */
  directories: number
  /** True when at least one dropped item was a directory the OS refused to open. */
  blockedDirectories: number
}

const DEFAULT_MAX_ENTRIES = 5000
const DEFAULT_MAX_DEPTH = 16

type DirectoryEntryLike = {
  isDirectory: boolean
  isFile: boolean
  name: string
  fullPath?: string
  file?: (callback: (file: File) => void, error?: (error: unknown) => void) => void
  createReader?: () => { readEntries: (callback: (entries: DirectoryEntryLike[]) => void, error?: (error: unknown) => void) => void }
}

const readEntryFile = (entry: DirectoryEntryLike) =>
  new Promise<File | null>(resolve => {
    if (typeof entry.file !== 'function') {
      resolve(null)
      return
    }
    try {
      entry.file(file => resolve(file), () => resolve(null))
    } catch {
      resolve(null)
    }
  })

const readDirectoryEntries = (entry: DirectoryEntryLike) =>
  new Promise<DirectoryEntryLike[]>(resolve => {
    if (typeof entry.createReader !== 'function') {
      resolve([])
      return
    }
    const reader = entry.createReader()
    const all: DirectoryEntryLike[] = []
    const readBatch = () => {
      try {
        reader.readEntries(batch => {
          if (!batch.length) {
            resolve(all)
            return
          }
          all.push(...batch)
          // `readEntries` returns chunks and must be called until it is empty.
          readBatch()
        }, () => resolve(all))
      } catch {
        resolve(all)
      }
    }
    readBatch()
  })

/**
 * Reads a drop payload into viewer-ready folder entries.
 *
 * Directories are traversed with `webkitGetAsEntry`, which is the only browser
 * API that can walk a dropped folder. A macOS bundle package (for example a
 * `.str` directory that Finder presents as one file) arrives as a *file* entry
 * with no content, so it is counted in `blockedDirectories` instead of being
 * silently dropped.
 */
export const readDemoDropPayload = async (
  dataTransfer: DataTransfer | null | undefined,
  options: { maxEntries?: number; maxDepth?: number } = {}
): Promise<DemoDropPayload> => {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const payload: DemoDropPayload = { entries: [], files: [], directories: 0, blockedDirectories: 0 }
  if (!dataTransfer) {
    return payload
  }

  const items = Array.from(dataTransfer.items || [])
  const getEntry = (item: DataTransferItem): DirectoryEntryLike | null => {
    const getter = (item as unknown as { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry
    if (typeof getter !== 'function') {
      return null
    }
    try {
      const entry = getter.call(item)
      return entry && typeof entry === 'object' ? (entry as DirectoryEntryLike) : null
    } catch {
      return null
    }
  }

  const walk = async (entry: DirectoryEntryLike, prefix: string, depth: number) => {
    if (payload.entries.length >= maxEntries || depth > maxDepth) {
      return
    }
    if (entry.isDirectory) {
      payload.directories += 1
      const children = await readDirectoryEntries(entry)
      if (!children.length) {
        return
      }
      await Promise.all(children.map(child => walk(child, prefix ? `${prefix}/${child.name}` : child.name, depth + 1)))
      return
    }

    const file = await readEntryFile(entry)
    if (!file) {
      return
    }
    // A bundle package is reported as a zero-byte file we can never read.
    if (file.size === 0 && /\.str$/i.test(file.name)) {
      payload.blockedDirectories += 1
      payload.files.push(file)
      return
    }
    payload.files.push(file)
    payload.entries.push({ path: prefix || file.name, file })
  }

  const walked = items
    .map(getEntry)
    .filter((entry): entry is DirectoryEntryLike => !!entry)

  if (walked.length) {
    await Promise.all(walked.map(entry => walk(entry, '', 0)))
    if (payload.entries.length || payload.files.length) {
      return payload
    }
  }

  // Fallback for browsers or sources without the entries API.
  Array.from(dataTransfer.files || []).forEach(file => {
    payload.files.push(file)
    payload.entries.push({ path: file.name, file })
  })
  return payload
}
