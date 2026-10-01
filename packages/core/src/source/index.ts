import type {
  FileViewerFileRef,
  FileViewerFolderEntry,
  FileViewerFolderFile,
  FileViewerSource,
  FileViewerSourceKind,
  NormalizedFileViewerFolderEntry,
  NormalizedFileViewerSource,
} from '../contracts/types';

export {
  createFileViewerTextDecoder,
  decodeFileViewerTextBuffer,
  isValidFileViewerUtf8,
  resolveFileViewerTextEncoding,
} from './textEncoding';
export type {
  DecodedFileViewerText,
  FileViewerTextEncoding,
  ResolvedFileViewerTextEncoding,
  ResolvedFileViewerTextSource,
} from './textEncoding';

export type FileViewerReadResult = string | ArrayBuffer | undefined | null;

export const DEFAULT_FILE_VIEWER_SOURCE_FILENAME = 'preview.bin';

export const normalizeFileExtension = (extension: string) => {
  return extension.trim().replace(/^\./, '').toLowerCase();
};

export const decodeFilename = (name: string) => {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

export const getExtension = (name: string) => {
  const clean = name.split(/[?#]/)[0] || name;
  const dot = clean.lastIndexOf('.');
  return dot === -1 ? '' : normalizeFileExtension(clean.slice(dot + 1));
};

export const normalizeFilename = (value: string | undefined, fallback = DEFAULT_FILE_VIEWER_SOURCE_FILENAME) => {
  const next = (value || '').split(/[?#]/)[0].trim();
  if (!next) {
    return fallback;
  }
  const slash = Math.max(next.lastIndexOf('/'), next.lastIndexOf('\\'));
  return decodeFilename(slash === -1 ? next : next.slice(slash + 1));
};

const getBlobName = (file: FileViewerFileRef | undefined) => {
  return file && 'name' in file && typeof file.name === 'string' ? file.name : undefined;
};

/** Reserved STR manifest filename; also used to auto-detect a `.str` folder. */
export const FILE_VIEWER_STR_BUNDLE_META_FILENAME = '.str.toml';

const STR_BUNDLE_SUFFIX_PATTERN = /\.str$/i;
/** macOS names the ZIP it delivers for a `.str` package `<bundle>.str.zip`. */
const STR_BUNDLE_ZIP_PATTERN = /\.str\.zip$/i;

const isFolderFileEntry = (entry: FileViewerFolderEntry): entry is FileViewerFolderFile =>
  !!entry && typeof entry === 'object' && 'file' in entry && 'path' in entry;

const getFolderEntryBlob = (entry: FileViewerFolderEntry): File | Blob | undefined => {
  if (isFolderFileEntry(entry)) {
    return entry.file || undefined;
  }
  return entry && typeof entry === 'object' ? entry as File | Blob : undefined;
};

const getBlobRelativePath = (blob: File | Blob) => {
  const relative = (blob as { webkitRelativePath?: unknown }).webkitRelativePath;
  return typeof relative === 'string' ? relative : '';
};

/** Normalizes a directory-source path into a `/`-separated, dot-free path. */
export const normalizeFileViewerFolderPath = (value: string) => {
  const segments = String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment && segment !== '.');
  if (segments.some(segment => segment === '..')) {
    return '';
  }
  return segments.join('/');
};

/**
 * Normalizes `FileViewerSource.files` into entries with resolvable paths.
 *
 * Browser folder pickers and directory drag-and-drop expose
 * `webkitRelativePath`; plain `Blob` inputs fall back to `name`, and
 * `{ path, file }` inputs always win. Entries without a usable path are dropped
 * because a directory without paths cannot be reconstructed.
 */
export const resolveFileViewerFolderEntries = (
  files?: readonly FileViewerFolderEntry[] | null
): NormalizedFileViewerFolderEntry[] => {
  if (!files?.length) {
    return [];
  }

  const entries: NormalizedFileViewerFolderEntry[] = [];
  files.forEach(entry => {
    const blob = getFolderEntryBlob(entry);
    if (!blob) {
      return;
    }
    const declaredPath = isFolderFileEntry(entry) ? entry.path : '';
    const path = normalizeFileViewerFolderPath(
      declaredPath || getBlobRelativePath(blob) || getBlobName(blob) || ''
    );
    if (!path) {
      return;
    }
    entries.push({
      path,
      file: blob,
      name: getBlobName(blob) || path.slice(path.lastIndexOf('/') + 1),
      size: typeof blob.size === 'number' ? blob.size : 0,
    });
  });

  return entries;
};

/**
 * Returns the shared leading directory name of a directory source, e.g.
 * `客户运营.str`. An empty string means the entries do not share one root.
 */
export const resolveFileViewerFolderRoot = (
  entries: readonly NormalizedFileViewerFolderEntry[]
) => {
  const first = entries[0]?.path.split('/')[0];
  if (!first || !entries.every(entry => entry.path.split('/')[0] === first)) {
    return '';
  }
  return entries.some(entry => entry.path.includes('/')) ? first : '';
};

/**
 * Strips the shared root directory so renderers receive bundle-relative paths.
 * Paths already relative to a bundle root are returned unchanged.
 */
export const stripFileViewerFolderRoot = (
  entries: readonly NormalizedFileViewerFolderEntry[],
  root: string
): NormalizedFileViewerFolderEntry[] => {
  if (!root) {
    return entries.map(entry => ({ ...entry }));
  }
  return entries.map(entry =>
    entry.path.startsWith(`${root}/`)
      ? { ...entry, path: entry.path.slice(root.length + 1) }
      : { ...entry, path: entry.path }
  );
};

/**
 * Detects an STR bundle without touching the disk: either the folder root is
 * named `<name>.str`, or a `.str.toml` manifest sits at the folder root.
 */
export const isFileViewerStrBundleFolder = (
  entries: readonly NormalizedFileViewerFolderEntry[],
  rootName = ''
) => {
  if (STR_BUNDLE_SUFFIX_PATTERN.test(rootName)) {
    return true;
  }
  return entries.some(entry => entry.path === FILE_VIEWER_STR_BUNDLE_META_FILENAME);
};

/**
 * Normalises an explicit folder source exactly like `FileViewerSource.files`.
 *
 * Hosts that cannot hand the viewer a directory (a drag-and-drop traversal, a
 * remote listing, `options.str.files`) get the same root detection and
 * bundle-relative paths instead of re-implementing it per integration.
 */
export const normalizeFileViewerFolderEntries = (
  input?: readonly FileViewerFolderEntry[] | null
): {
  entries: NormalizedFileViewerFolderEntry[];
  rootName: string;
  isStrBundle: boolean;
} => {
  const folderEntries = resolveFileViewerFolderEntries(input);
  const rootName = resolveFileViewerFolderRoot(folderEntries);
  const entries = stripFileViewerFolderRoot(folderEntries, rootName);
  return {
    entries,
    rootName,
    isStrBundle: isFileViewerStrBundleFolder(entries, rootName),
  };
};

/**
 * Detects the archive name macOS produces when it hands a bundle package to a
 * file input: `<bundle>.str` becomes `<bundle>.str.zip`.
 */
export const isFileViewerStrBundleZipName = (name: string) =>
  STR_BUNDLE_ZIP_PATTERN.test(name);

/**
 * Detects the macOS "bundle presented as a package" case.
 *
 * Finder - and `str reveal`, which runs `SetFile -a B` - can make a `.str`
 * directory look like a single file. File inputs and drag-and-drop then hand the
 * browser a zero-byte entry with no directory listing, so there is nothing to
 * parse. Hosts and renderers use this to explain the situation with an
 * actionable remedy instead of failing silently.
 */
export const isFileViewerBundlePackageSource = (
  source: Pick<FileViewerSource, 'file' | 'filename' | 'files' | 'size'> | NormalizedFileViewerSource
) => {
  const entries = 'files' in source ? source.files : undefined;
  if (entries?.length) {
    return false;
  }

  const name = source.filename || getBlobName(source.file) || '';
  if (!name || getExtension(name).toLowerCase() !== 'str') {
    return false;
  }

  const size = typeof source.size === 'number' ? source.size : source.file?.size;
  return size === 0;
};

const getSourceKind = (
  source: FileViewerSource,
  folderEntries: readonly NormalizedFileViewerFolderEntry[]
): FileViewerSourceKind => {
  if (folderEntries.length) {
    return 'folder';
  }
  if (source.file) {
    return 'file';
  }
  if (source.buffer) {
    return 'buffer';
  }
  if (source.url) {
    return 'url';
  }
  return 'empty';
};

export const resolveFileViewerSourceFilename = ({
  filename,
  file,
  url,
  fallback = '',
}: {
  filename?: string;
  file?: FileViewerFileRef;
  url?: string;
  fallback?: string;
}) => {
  if (filename) {
    return normalizeFilename(filename, fallback);
  }

  const fileName = getBlobName(file);
  if (fileName) {
    return normalizeFilename(fileName, fallback);
  }

  if (url) {
    return normalizeFilename(url, fallback);
  }

  return fallback;
};

export const normalizeSource = (source: FileViewerSource): NormalizedFileViewerSource => {
  const folderEntries = resolveFileViewerFolderEntries(source.files);
  const kind = getSourceKind(source, folderEntries);

  if (kind === 'folder') {
    const { entries, rootName, isStrBundle } = normalizeFileViewerFolderEntries(source.files);
    const declaredName = source.filename || rootName || (isStrBundle ? 'bundle.str' : '');
    const filename = normalizeFilename(
      declaredName,
      source.type ? `preview.${normalizeFileExtension(source.type)}` : DEFAULT_FILE_VIEWER_SOURCE_FILENAME
    );
    const extension = normalizeFileExtension(
      source.type || (isStrBundle ? 'str' : getExtension(filename))
    );

    return {
      kind,
      filename,
      extension,
      files: entries,
      size: typeof source.size === 'number'
        ? source.size
        : entries.reduce((total, entry) => total + entry.size, 0),
    };
  }

  const filename = normalizeFilename(
    source.filename || getBlobName(source.file) || source.url,
    source.type ? `preview.${normalizeFileExtension(source.type)}` : DEFAULT_FILE_VIEWER_SOURCE_FILENAME
  );
  // A `<bundle>.str.zip` remains a STR bundle: the container is just how macOS
  // delivered the package, so the filename wins over `application/zip`.
  const extension = normalizeFileExtension(
    STR_BUNDLE_ZIP_PATTERN.test(filename) ? 'str' : source.type || getExtension(filename)
  );
  const sourceSize =
    typeof source.size === 'number'
      ? source.size
      : source.file
        ? source.file.size
        : source.buffer
          ? source.buffer.byteLength
          : undefined;

  return {
    kind,
    filename,
    extension,
    url: source.url,
    file: source.file,
    buffer: source.buffer,
    size: sourceSize,
  };
};

export const wrapFileViewerFileRef = (
  data: FileViewerFileRef,
  filename = DEFAULT_FILE_VIEWER_SOURCE_FILENAME
): File => {
  if (typeof File !== 'undefined' && data instanceof File) {
    return data;
  }

  const safeFilename = normalizeFilename(filename || DEFAULT_FILE_VIEWER_SOURCE_FILENAME);

  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new File([data], safeFilename, { type: data.type });
  }

  if (data instanceof ArrayBuffer) {
    return new File([data], safeFilename, {});
  }

  throw new Error('Unsupported file source input.');
};

export const readFileViewerBuffer = async (file: Blob): Promise<ArrayBuffer> => {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => {
      const result = event.target?.result;
      if (result instanceof ArrayBuffer) {
        resolve(result);
        return;
      }
      reject(new Error('Failed to read file as ArrayBuffer.'));
    };
    reader.onerror = error => reject(error);
    reader.readAsArrayBuffer(file);
  });
};

const toFileViewerBlob = (source: Blob | ArrayBuffer) => {
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    return source;
  }
  if (typeof Blob === 'undefined') {
    throw new Error('Blob is not available in the current execution environment.');
  }
  return new Blob([source]);
};

export const readFileViewerDataUrl = async (source: Blob | ArrayBuffer): Promise<string> => {
  const blob = toFileViewerBlob(source);

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => {
      const result = event.target?.result;
      if (typeof result === 'string') {
        resolve(result);
        return;
      }
      reject(new Error('Failed to read file as data URL.'));
    };
    reader.onerror = error => reject(error);
    reader.readAsDataURL(blob);
  });
};

export const readFileViewerText = async (
  source: Blob | ArrayBuffer,
  encoding = 'utf-8'
): Promise<string> => {
  const blob = toFileViewerBlob(source);
  if (typeof blob.text === 'function' && encoding.toLowerCase() === 'utf-8') {
    return blob.text();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => {
      const result = event.target?.result;
      if (typeof result === 'string') {
        resolve(result);
        return;
      }
      reject(new Error('Failed to read file as text.'));
    };
    reader.onerror = error => reject(error);
    reader.readAsText(blob, encoding);
  });
};
