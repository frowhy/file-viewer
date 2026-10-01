import {
  DEFAULT_RENDERER_DEFINITIONS,
  type FileRenderHandler,
  type FileViewerRenderedInstance,
  type FileViewerRendererPlugin,
  type RendererDefinition,
  type RendererLoader,
} from '@file-viewer/core';

const strDefinition = DEFAULT_RENDERER_DEFINITIONS.find(
  definition => definition.id === 'str'
) as RendererDefinition | undefined;

if (!strDefinition) {
  throw new Error('@file-viewer/renderer-str could not locate the shared STR format definition.');
}

export const strRendererDefinition = strDefinition;

/**
 * Mounts the STR structure tree and previews payloads with the renderers the
 * host already installed.
 *
 * The registry handler path (`handlers`) is intentionally unused: an STR bundle
 * is a directory, so `RendererLoadContext.source` carries `files` instead of an
 * `ArrayBuffer`, which `createFileRenderHandlerLoader` rejects by design.
 */
export const loadFileViewerStr: RendererLoader = context =>
  import('./view.js').then(({ default: mountStrBundleViewer }) => mountStrBundleViewer(context));

export const strRenderer: FileViewerRendererPlugin<
  FileRenderHandler<FileViewerRenderedInstance, HTMLDivElement>
> = {
  id: 'file-viewer-renderer-str',
  label: 'Flyfish File Viewer STR bundle renderer',
  definitions: [
    {
      ...strRendererDefinition,
      load: loadFileViewerStr,
    },
  ],
};

export default strRenderer;

export {
  MAX_STR_TREE_NODES,
  STR_MANIFEST_FILENAME,
  flattenStrBundle,
  formatStrBytes,
  getStrBranchDir,
  getStrLeafName,
  isIgnoredStrPath,
  isStrManifestPath,
  joinStrPath,
  matchesStrQuery,
  parseStrBranchMeta,
  parseStrBundle,
  readStrBundleSources,
} from './bundle.js';
export type {
  ParseStrBundleInput,
  StrAuthor,
  StrBranchKind,
  StrBranchMeta,
  StrBundle,
  StrBundleBranchNode,
  StrBundleDirNode,
  StrBundleFileNode,
  StrBundleLink,
  StrBundleNode,
  StrBundleSourceFile,
  StrEntry,
  StrEntryRole,
  StrIssue,
  StrIssueLevel,
  StrRef,
} from './bundle.js';
export { TomlParseError, parseToml } from './toml.js';
export type { TomlPrimitive, TomlTable, TomlValue } from './toml.js';
export {
  MAX_STR_ZIP_ENTRIES,
  MAX_STR_ZIP_ENTRY_BYTES,
  StrZipError,
  StrZipLazyBlob,
  readStrZipEntries,
} from './zip.js';
export type { StrZipEntry, StrZipErrorCode } from './zip.js';
