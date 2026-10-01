// STR bundle model: turns a flat directory listing into the node/branch tree
// described by the STR specification (SPEC.md, STR 1.x).
//
// The browser never gives a renderer a real directory, so the source is a flat
// list of `{ path, blob }` entries. Manifests (`.str.toml`) are decoded to text
// before this module runs, which keeps the whole model synchronous, pure and
// unit-testable without a DOM.

import {
  getExtension,
  normalizeFileViewerFolderPath,
  readFileViewerText,
  type NormalizedFileViewerFolderEntry,
} from '@file-viewer/core';
import {
  parseToml,
  readTomlNumber,
  readTomlString,
  readTomlStringArray,
  readTomlTableArray,
  type TomlTable,
  type TomlValue,
} from './toml.js';

/** STR manifest filename (spec 1.17.0 renamed the reserved prefix to `.str.`). */
export const STR_MANIFEST_FILENAME = '.str.toml';

/** Hard cap that keeps pathological bundles (deep mounts, huge trees) bounded. */
export const MAX_STR_TREE_NODES = 20000;

/** Maximum number of files listed inside a single `role = "dir"` content folder. */
const MAX_STR_CONTENT_FOLDER_FILES = 500;

export type StrBranchKind = 'root' | 'node' | 'branch' | 'unknown';

export type StrEntryRole =
  | 'node'
  | 'branch'
  | 'payload'
  | 'asset'
  | 'dir'
  | 'bundle'
  | 'link'
  | 'other';

export type StrIssueLevel = 'warning' | 'error';

export interface StrIssue {
  level: StrIssueLevel;
  code: string;
  path: string;
  message: string;
}

export interface StrAuthor {
  id: string;
  name?: string;
  role?: string;
  at?: string;
}

export interface StrRef {
  id: string;
  target: string;
  rel: string;
  title?: string;
  order?: number;
  note?: string;
}

export interface StrEntry {
  path: string;
  role: StrEntryRole;
  rawRole: string;
  mode?: string;
  target?: string;
  id?: string;
  type?: string;
  title?: string;
  summary?: string;
  note?: string;
  order?: number;
  mediaType?: string;
  schema?: string;
  size?: number;
  sha256?: string;
  count?: number;
  optional?: boolean;
}

export interface StrBranchMeta {
  strVersion?: number;
  spec?: string;
  kind: StrBranchKind;
  id?: string;
  name?: string;
  type?: string;
  title?: string;
  summary?: string;
  tags: string[];
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
  authors: StrAuthor[];
  refs: StrRef[];
  entries: StrEntry[];
  policies: TomlTable;
  /** Raw manifest text, so the viewer can show the source verbatim. */
  text: string;
}

export interface StrBundleFileNode {
  kind: 'file';
  /** Bundle-relative path. */
  path: string;
  name: string;
  depth: number;
  role: StrEntryRole;
  registered: boolean;
  extension: string;
  size: number;
  entry: StrEntry | null;
  blob?: File | Blob;
}

export interface StrBundleDirNode {
  kind: 'dir';
  path: string;
  name: string;
  depth: number;
  entry: StrEntry | null;
  rows: StrBundleNode[];
}

export interface StrBundleLink {
  mode: string;
  targetId: string;
  title?: string;
}

export interface StrBundleBranchNode {
  kind: 'branch';
  /** Unique key across the rendered tree (a mount can repeat one directory). */
  key: string;
  path: string;
  name: string;
  depth: number;
  branchKind: StrBranchKind;
  title: string;
  type?: string;
  summary?: string;
  tags: string[];
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
  authors: StrAuthor[];
  refs: StrRef[];
  policies: TomlTable;
  manifestPath: string;
  manifestText: string;
  rows: StrBundleNode[];
  issues: StrIssue[];
  link: StrBundleLink | null;
  /** True for hard links, whose content rows are read-only views of the target. */
  contentReadOnly: boolean;
  cycle: boolean;
  unregisteredCount: number;
}

export type StrBundleNode = StrBundleBranchNode | StrBundleDirNode | StrBundleFileNode;

export interface StrBundle {
  name: string;
  root: StrBundleBranchNode;
  branches: Map<string, StrBundleBranchNode>;
  branchCount: number;
  entryCount: number;
  fileCount: number;
  depth: number;
  issues: StrIssue[];
}

export interface StrBundleSourceFile {
  /** Bundle-relative path. */
  path: string;
  /** Decoded text; required for `.str.toml` entries. */
  text?: string;
  blob?: File | Blob;
}

export interface ParseStrBundleInput {
  name?: string;
  files: readonly StrBundleSourceFile[];
}

const STR_ROLE_BY_NAME: Record<string, StrEntryRole> = {
  node: 'node',
  branch: 'branch',
  payload: 'payload',
  asset: 'asset',
  dir: 'dir',
  bundle: 'bundle',
  link: 'link',
};

const IGNORED_SEGMENTS = new Set([
  '.git',
  '.github',
  '.hg',
  '.svn',
  '.str.schema',
  '.str.cache',
]);

const IGNORED_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.hgignore',
  '.lock',
]);

/** True for entries the STR system-level ignore layer never surfaces. */
export const isIgnoredStrPath = (path: string) => {
  const segments = path.split('/').filter(Boolean);
  if (!segments.length) {
    return true;
  }
  const name = segments[segments.length - 1];
  if (name.startsWith('._')) {
    return true;
  }
  if (IGNORED_NAMES.has(name)) {
    return true;
  }
  return segments.some(segment => IGNORED_SEGMENTS.has(segment));
};

export const isStrManifestPath = (path: string) => {
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] === STR_MANIFEST_FILENAME;
};

export const getStrBranchDir = (manifestPath: string) => {
  const index = manifestPath.lastIndexOf('/');
  return index === -1 ? '' : manifestPath.slice(0, index);
};

export const joinStrPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export const getStrLeafName = (path: string) => {
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] || path;
};

export const formatStrBytes = (size: number) => {
  if (!Number.isFinite(size) || size <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
};

const normalizeRole = (raw: string): StrEntryRole => STR_ROLE_BY_NAME[raw] || 'other';

const readEntry = (table: TomlTable): StrEntry | null => {
  const path = readTomlString(table.path);
  if (!path) {
    return null;
  }
  const rawRole = readTomlString(table.role) || 'other';
  return {
    path,
    role: normalizeRole(rawRole),
    rawRole,
    mode: readTomlString(table.mode),
    target: readTomlString(table.target),
    id: readTomlString(table.id),
    type: readTomlString(table.type),
    title: readTomlString(table.title),
    summary: readTomlString(table.summary),
    note: readTomlString(table.note),
    order: readTomlNumber(table.order),
    mediaType: readTomlString(table.media_type),
    schema: readTomlString(table.schema),
    size: readTomlNumber(table.size),
    sha256: readTomlString(table.sha256),
    count: readTomlNumber(table.count),
    optional: table.optional === true,
  };
};

const readKind = (value: TomlValue | undefined): StrBranchKind => {
  const kind = readTomlString(value);
  return kind === 'root' || kind === 'node' || kind === 'branch' ? kind : 'unknown';
};

const readPolicies = (value: TomlValue | undefined): TomlTable =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as TomlTable : {};

/** Maps a `.str.toml` document onto the model the viewer renders. */
export const parseStrBranchMeta = (text: string): StrBranchMeta => {
  const table = parseToml(text);

  const authors = readTomlTableArray(table.authors)
    .map(row => ({
      id: readTomlString(row.id) || '',
      name: readTomlString(row.name),
      role: readTomlString(row.role),
      at: readTomlString(row.at),
    }))
    .filter(author => !!author.id);

  const refs = readTomlTableArray(table.refs)
    .map(row => ({
      id: readTomlString(row.id) || '',
      target: readTomlString(row.target) || '',
      rel: readTomlString(row.rel) || 'related',
      title: readTomlString(row.title),
      order: readTomlNumber(row.order),
      note: readTomlString(row.note),
    }))
    .filter(ref => !!ref.id && !!ref.target);

  const entries = readTomlTableArray(table.entries)
    .map(readEntry)
    .filter((entry): entry is StrEntry => !!entry);

  return {
    strVersion: readTomlNumber(table.str),
    spec: readTomlString(table.spec),
    kind: readKind(table.kind),
    id: readTomlString(table.id),
    name: readTomlString(table.name),
    type: readTomlString(table.type),
    title: readTomlString(table.title),
    summary: readTomlString(table.summary),
    tags: readTomlStringArray(table.tags),
    revision: readTomlNumber(table.revision),
    createdAt: readTomlString(table.created_at),
    updatedAt: readTomlString(table.updated_at),
    authors,
    refs,
    entries,
    policies: readPolicies(table.policies),
    text,
  };
};

interface StrSourceIndex {
  fileByPath: Map<string, StrBundleSourceFile>;
  dirChildren: Map<string, string[]>;
  manifestByDir: Map<string, StrBranchMeta>;
  manifestFailedDirs: Set<string>;
  dirById: Map<string, string>;
}

const buildStrSourceIndex = (files: readonly StrBundleSourceFile[]): StrSourceIndex => {
  const fileByPath = new Map<string, StrBundleSourceFile>();
  const dirChildren = new Map<string, Set<string>>();
  const manifestByDir = new Map<string, StrBranchMeta>();
  const manifestFailedDirs = new Set<string>();
  const dirById = new Map<string, string>();

  const registerChild = (dir: string, name: string) => {
    const children = dirChildren.get(dir) ?? new Set<string>();
    children.add(name);
    dirChildren.set(dir, children);
  };

  files.forEach(file => {
    const path = normalizeFileViewerFolderPath(file.path);
    if (!path || isIgnoredStrPath(path)) {
      return;
    }
    fileByPath.set(path, { ...file, path });

    const segments = path.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      registerChild(segments.slice(0, index).join('/'), segments[index]);
    }

    if (isStrManifestPath(path) && typeof file.text === 'string') {
      const dir = getStrBranchDir(path);
      try {
        const meta = parseStrBranchMeta(file.text);
        manifestByDir.set(dir, meta);
        if (meta.id && !dirById.has(meta.id)) {
          dirById.set(meta.id, dir);
        }
      } catch {
        manifestFailedDirs.add(dir);
      }
    }
  });

  const resolvedChildren = new Map<string, string[]>();
  dirChildren.forEach((children, dir) => {
    resolvedChildren.set(dir, Array.from(children).sort((left, right) => left.localeCompare(right)));
  });

  return { fileByPath, dirChildren: resolvedChildren, manifestByDir, manifestFailedDirs, dirById };
};

const compareEntries = (left: StrEntry, right: StrEntry) => {
  const leftOrder = typeof left.order === 'number' ? left.order : Number.POSITIVE_INFINITY;
  const rightOrder = typeof right.order === 'number' ? right.order : Number.POSITIVE_INFINITY;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.path.localeCompare(right.path);
};

interface StrBuildState {
  index: StrSourceIndex;
  branches: Map<string, StrBundleBranchNode>;
  nodeCount: number;
  branchCount: number;
  entryCount: number;
  fileCount: number;
  maxDepth: number;
  instance: number;
  truncated: boolean;
}

const createBranchNode = (
  path: string,
  depth: number,
  key: string
): StrBundleBranchNode => ({
  kind: 'branch',
  key,
  path,
  name: path ? getStrLeafName(path) : 'ROOT',
  depth,
  branchKind: 'unknown',
  title: path ? getStrLeafName(path) : 'ROOT',
  tags: [],
  authors: [],
  refs: [],
  policies: {},
  manifestPath: joinStrPath(path, STR_MANIFEST_FILENAME),
  manifestText: '',
  rows: [],
  issues: [],
  link: null,
  contentReadOnly: false,
  cycle: false,
  unregisteredCount: 0,
});

const applyMetaToBranch = (node: StrBundleBranchNode, meta: StrBranchMeta | null) => {
  if (!meta) {
    return;
  }
  node.branchKind = meta.kind;
  node.title = meta.title || meta.name || node.name;
  node.type = meta.type;
  node.summary = meta.summary;
  node.tags = meta.tags;
  node.revision = meta.revision;
  node.createdAt = meta.createdAt;
  node.updatedAt = meta.updatedAt;
  node.authors = meta.authors;
  node.refs = meta.refs;
  node.policies = meta.policies;
  node.manifestText = meta.text;
};

const resolveBranchMeta = (index: StrSourceIndex, dir: string): StrBranchMeta | null =>
  index.manifestByDir.get(dir) || null;

const buildFileNode = (
  path: string,
  depth: number,
  entry: StrEntry | null,
  source: StrBundleSourceFile | undefined,
  role: StrEntryRole
): StrBundleFileNode => {
  const size = typeof entry?.size === 'number'
    ? entry.size
    : typeof source?.blob?.size === 'number'
      ? source.blob.size
      : 0;
  const leaf = getStrLeafName(path);
  return {
    kind: 'file',
    path,
    name: leaf,
    depth,
    role,
    registered: !!entry,
    extension: getExtension(leaf),
    size,
    entry,
    blob: source?.blob,
  };
};

const listDescendantFiles = (
  index: StrSourceIndex,
  dir: string,
  limit: number
): Array<{ path: string; source: StrBundleSourceFile }> => {
  const results: Array<{ path: string; source: StrBundleSourceFile }> = [];
  const walk = (current: string) => {
    (index.dirChildren.get(current) || []).forEach(name => {
      if (results.length >= limit) {
        return;
      }
      const path = joinStrPath(current, name);
      const source = index.fileByPath.get(path);
      if (source) {
        if (!isStrManifestPath(path)) {
          results.push({ path, source });
        }
        return;
      }
      walk(path);
    });
  };
  walk(dir);
  return results;
};

const buildBranchLevel = (
  state: StrBuildState,
  dir: string,
  depth: number,
  link: StrBundleLink | null,
  stack: readonly string[],
  keyOverride?: string
): StrBundleBranchNode => {
  const key = keyOverride ?? dir;
  const node = createBranchNode(dir, depth, key);
  node.link = link;
  if (link?.title) {
    node.name = link.title;
    node.title = link.title;
  }

  const meta = resolveBranchMeta(state.index, dir);
  const manifestPath = node.manifestPath;
  if (meta) {
    applyMetaToBranch(node, meta);
    if (meta.kind === 'unknown') {
      node.issues.push({
        level: 'warning',
        code: 'W_KIND_UNKNOWN',
        path: manifestPath,
        message: 'The manifest declares no valid `kind`.',
      });
    }
  } else if (state.index.manifestFailedDirs.has(dir)) {
    node.issues.push({
      level: 'error',
      code: 'E_META_PARSE',
      path: manifestPath,
      message: 'The .str.toml manifest could not be parsed.',
    });
  } else if (state.index.fileByPath.has(manifestPath)) {
    node.issues.push({
      level: 'error',
      code: 'E_META_PARSE',
      path: manifestPath,
      message: 'The .str.toml manifest is empty.',
    });
  } else {
    node.issues.push({
      level: 'warning',
      code: 'E_META_MISSING',
      path: manifestPath,
      message: 'Branch directory has no .str.toml manifest.',
    });
  }

  state.branches.set(key, node);
  state.branchCount += 1;
  state.maxDepth = Math.max(state.maxDepth, depth);

  // Hard links own their structure but borrow the target branch's content rows.
  let contentDir = dir;
  if (link && link.mode === 'hard') {
    const targetDir = state.index.dirById.get(link.targetId);
    if (targetDir === undefined) {
      node.issues.push({
        level: 'error',
        code: 'E_LINK_NO_TARGET',
        path: dir,
        message: 'The hard link target branch could not be resolved.',
      });
    } else {
      contentDir = targetDir;
      node.contentReadOnly = true;
    }
  }

  const contentMeta = contentDir === dir ? meta : resolveBranchMeta(state.index, contentDir);
  const claimed = new Set<string>([STR_MANIFEST_FILENAME]);
  const rows: StrBundleNode[] = [];

  const pushRow = (row: StrBundleNode) => {
    if (state.nodeCount >= MAX_STR_TREE_NODES) {
      state.truncated = true;
      return;
    }
    state.nodeCount += 1;
    rows.push(row);
  };

  const structuralEntries = (meta?.entries || [])
    .filter(entry => entry.role === 'node' || entry.role === 'branch' || entry.role === 'link')
    .slice()
    .sort(compareEntries);
  const contentEntries = (contentMeta?.entries || [])
    .filter(entry =>
      entry.role === 'payload' ||
      entry.role === 'asset' ||
      entry.role === 'dir' ||
      entry.role === 'bundle' ||
      entry.role === 'other'
    )
    .slice()
    .sort(compareEntries);

  contentEntries.forEach(entry => claimed.add(entry.path));

  structuralEntries.forEach(entry => {
    const targetPath = joinStrPath(dir, entry.path);
    state.entryCount += 1;

    if (entry.role === 'link') {
      const targetId = entry.target || '';
      const targetDir = state.index.dirById.get(targetId);
      if (targetDir === undefined) {
        node.issues.push({
          level: 'error',
          code: 'E_LINK_NO_TARGET',
          path: targetPath,
          message: `Linked branch \`${targetId || '?'}\` is not present in this bundle.`,
        });
        return;
      }
      const mode = entry.mode === 'hard' ? 'hard' : 'soft';
      state.instance += 1;
      const mountKey = `${targetDir}@mount${state.instance}`;

      if (mode === 'hard') {
        pushRow(buildBranchLevel(
          state,
          targetPath,
          depth + 1,
          { mode, targetId, title: entry.title },
          stack,
          mountKey
        ));
        return;
      }

      if (stack.includes(targetDir)) {
        const cyc = createBranchNode(targetPath, depth + 1, mountKey);
        cyc.link = { mode, targetId, title: entry.title };
        cyc.title = entry.title || cyc.title;
        cyc.cycle = true;
        cyc.issues.push({
          level: 'error',
          code: 'E_LINK_CYCLE',
          path: targetPath,
          message: 'This mount points back at one of its own ancestors.',
        });
        state.branches.set(mountKey, cyc);
        state.branchCount += 1;
        pushRow(cyc);
        return;
      }

      pushRow(buildBranchLevel(
        state,
        targetDir,
        depth + 1,
        { mode, targetId, title: entry.title },
        [...stack, dir],
        mountKey
      ));
      return;
    }

    if (stack.includes(targetPath)) {
      node.issues.push({
        level: 'error',
        code: 'E_LINK_CYCLE',
        path: targetPath,
        message: 'This branch is already being expanded higher up the tree.',
      });
      return;
    }

    pushRow(buildBranchLevel(state, targetPath, depth + 1, null, [...stack, dir], targetPath));
  });

  contentEntries.forEach(entry => {
    const targetPath = joinStrPath(contentDir, entry.path);
    const source = state.index.fileByPath.get(targetPath);
    state.entryCount += 1;

    if (entry.role === 'dir') {
      const dirNode: StrBundleDirNode = {
        kind: 'dir',
        path: targetPath,
        name: entry.path,
        depth: depth + 1,
        entry,
        rows: [],
      };
      listDescendantFiles(state.index, targetPath, MAX_STR_CONTENT_FOLDER_FILES).forEach(child => {
        state.fileCount += 1;
        dirNode.rows.push(buildFileNode(child.path, depth + 2, null, child.source, 'payload'));
      });
      pushRow(dirNode);
      return;
    }

    if (entry.role === 'bundle') {
      if (stack.includes(targetPath)) {
        return;
      }
      state.instance += 1;
      pushRow(buildBranchLevel(
        state,
        targetPath,
        depth + 1,
        null,
        [...stack, dir],
        `${targetPath}@bundle${state.instance}`
      ));
      return;
    }

    if (!source && !entry.optional) {
      node.issues.push({
        level: 'warning',
        code: 'E_MANIFEST_GHOST',
        path: targetPath,
        message: 'The manifest registers an entry that is missing on disk.',
      });
    }
    if (source) {
      state.fileCount += 1;
    }
    pushRow(buildFileNode(targetPath, depth + 1, entry, source, entry.role));
  });

  // Files that exist on disk but are absent from the manifest. Hard links skip
  // this because their rows come from another directory.
  if (!node.contentReadOnly) {
    const structuralNames = new Set(structuralEntries.map(entry => entry.path));
    const leftovers = (state.index.dirChildren.get(dir) || [])
      .filter(name => !claimed.has(name) && !structuralNames.has(name));

    leftovers.forEach(name => {
      const path = joinStrPath(dir, name);
      const source = state.index.fileByPath.get(path);
      if (source) {
        if (isStrManifestPath(path)) {
          return;
        }
        state.fileCount += 1;
        node.unregisteredCount += 1;
        pushRow(buildFileNode(path, depth + 1, null, source, 'payload'));
        return;
      }
      if (state.index.dirChildren.has(path)) {
        const nested = buildBranchLevel(state, path, depth + 1, null, [...stack, dir], path);
        nested.issues.push({
          level: 'warning',
          code: 'E_ENTRY_UNREGISTERED',
          path,
          message: 'This directory holds a .str.toml but is not registered in the parent manifest.',
        });
        pushRow(nested);
      }
    });
  }

  node.rows = rows;
  if (node.unregisteredCount) {
    node.issues.push({
      level: 'warning',
      code: 'E_MANIFEST_MISSING',
      path: dir,
      message: `${node.unregisteredCount} file(s) exist on disk without a manifest entry.`,
    });
  }

  return node;
};

/** Builds the STR structure tree from an already-decoded directory listing. */
export const parseStrBundle = (input: ParseStrBundleInput): StrBundle => {
  const index = buildStrSourceIndex(input.files);
  const state: StrBuildState = {
    index,
    branches: new Map(),
    nodeCount: 1,
    branchCount: 0,
    entryCount: 0,
    fileCount: 0,
    maxDepth: 0,
    instance: 0,
    truncated: false,
  };

  const root = buildBranchLevel(state, '', 0, null, []);
  if (state.truncated) {
    root.issues.push({
      level: 'warning',
      code: 'W_TREE_TRUNCATED',
      path: '',
      message: `The structure tree stopped at ${MAX_STR_TREE_NODES} nodes.`,
    });
  }

  return {
    name: input.name || 'bundle.str',
    root,
    branches: state.branches,
    branchCount: state.branchCount,
    entryCount: state.entryCount,
    fileCount: state.fileCount,
    depth: state.maxDepth,
    issues: root.issues,
  };
};

/**
 * Decodes the manifests of a normalized directory source.
 *
 * Only `.str.toml` files are read into memory; every other entry keeps its
 * `Blob` so previews stream straight from the original handle.
 */
export const readStrBundleSources = async (
  entries: readonly NormalizedFileViewerFolderEntry[]
): Promise<StrBundleSourceFile[]> => {
  const sources: StrBundleSourceFile[] = [];
  for (const entry of entries) {
    if (isStrManifestPath(entry.path)) {
      let text = '';
      try {
        text = await readFileViewerText(entry.file);
      } catch {
        text = '';
      }
      sources.push({ path: entry.path, text, blob: entry.file });
      continue;
    }
    sources.push({ path: entry.path, blob: entry.file });
  }
  return sources;
};

/** Flattens the tree into a stable row list for search and keyboard navigation. */
export const flattenStrBundle = (bundle: StrBundle): StrBundleNode[] => {
  const rows: StrBundleNode[] = [];
  const walk = (nodes: readonly StrBundleNode[]) => {
    nodes.forEach(node => {
      rows.push(node);
      if (node.kind === 'branch' || node.kind === 'dir') {
        walk(node.rows);
      }
    });
  };
  walk(bundle.root.rows);
  return rows;
};

/** Case-insensitive filter over branch titles, paths, tags, types and file names. */
export const matchesStrQuery = (node: StrBundleNode, query: string) => {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  if (node.kind === 'branch') {
    return [
      node.title,
      node.path,
      node.name,
      node.type || '',
      node.summary || '',
      node.tags.join(' '),
    ].join(' ').toLowerCase().includes(needle);
  }
  if (node.kind === 'dir') {
    return `${node.name} ${node.path}`.toLowerCase().includes(needle);
  }
  return `${node.name} ${node.path} ${node.entry?.title || ''}`.toLowerCase().includes(needle);
};
