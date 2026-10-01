// STR bundle viewer: a structure tree on the left and a nested preview on the
// right.
//
// The two-pane layout follows the archive renderer so container-shaped formats
// behave consistently. Selecting a payload hands its bytes to the *existing*
// renderer registry, so an STR bundle previews `.png`, `.csv`, `.md`, `.pdf`
// and everything else with the renderers the host already installed.

import {
  collectFileViewerRendererPlugins,
  createFileRenderHandlerLoader,
  createFileViewerCoreRendererRegistry,
  createFileViewerTranslator,
  createRendererRegistry,
  installFileViewerRendererPlugins,
  isFileViewerBundlePackageSource,
  listFileViewerAutoRendererPresets,
  normalizeFileViewerFolderEntries,
  normalizeFileViewerUiDensity,
  normalizeSource,
  resolveFileViewerRendererPresetInputs,
  type FileRenderContext,
  type FileRenderHandler,
  type FileViewerOptions,
  type FileViewerRenderedInstance,
  type FileViewerRendererPluginInput,
  type FileViewerRendererPresetInput,
  type RendererLoadContext,
  type RendererRegistry,
  type RendererSession,
} from '@file-viewer/core';
import {
  StrZipError,
  StrZipLazyBlob,
  readStrZipEntries,
  type StrZipEntry,
} from './zip.js';
import {
  formatStrBytes,
  isStrManifestPath,
  parseStrBranchMeta,
  parseStrBundle,
  readStrBundleSources,
  type StrBranchKind,
  type StrBundle,
  type StrBundleBranchNode,
  type StrBundleFileNode,
  type StrBundleNode,
} from './bundle.js';

type StrNestedHandler = FileRenderHandler<FileViewerRenderedInstance | undefined, HTMLElement>;

const strStyle = `
.str-shell{--str-sidebar-track:clamp(248px,30%,420px);--str-entry-min-height:48px;--str-entry-icon-column:34px;--str-entry-gap:7px;--str-entry-padding-y:5px;--str-entry-padding-x:7px;--str-entry-depth-step:8px;--str-entry-depth-max:40px;--str-entry-radius:9px;--str-entry-ext-height:28px;--str-entry-ext-radius:7px;--str-entry-ext-size:9px;--str-entry-name-size:13px;--str-entry-meta-size:11px;display:grid;grid-template-columns:var(--str-sidebar-track) minmax(0,1fr);height:100%;min-height:0;font-family:inherit;color:#1f2937;background:#f7f8fa}
.str-shell *{box-sizing:border-box}
.str-shell[data-viewer-density='compact']{--str-sidebar-track:clamp(224px,27%,360px);--str-entry-min-height:40px;--str-entry-icon-column:28px;--str-entry-gap:5px;--str-entry-padding-y:3px;--str-entry-padding-x:5px;--str-entry-depth-step:6px;--str-entry-depth-max:32px;--str-entry-radius:7px;--str-entry-ext-height:24px;--str-entry-ext-radius:6px;--str-entry-ext-size:8px;--str-entry-name-size:12px;--str-entry-meta-size:10px}
@media (pointer:coarse){.str-shell[data-viewer-density='compact']{--str-entry-min-height:50px;--str-entry-ext-height:30px}}
.str-sidebar{grid-column:1;grid-row:1;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;border-right:1px solid rgba(23,32,51,.1);background:rgba(255,255,255,.86)}
.str-shell.str-sidebar-collapsed{grid-template-columns:0 minmax(0,1fr)}
.str-shell.str-sidebar-collapsed .str-sidebar{display:none;width:0;max-width:0;padding:0;border-color:transparent;opacity:0;pointer-events:none}
.str-head{display:flex;align-items:flex-start;gap:8px;padding:12px 12px 10px;border-bottom:1px solid rgba(23,32,51,.08)}
.str-head-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.str-badge{align-self:flex-start;padding:2px 8px;border-radius:999px;background:#1d4ed8;color:#fff;font-size:10px;letter-spacing:.08em;font-weight:700}
.str-head strong{font-size:15px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.str-stats{margin:0;font-size:11px;color:#64748b}
.str-sidebar-toggle{flex:none;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border-radius:8px;border:1px solid rgba(23,32,51,.12);background:#fff;color:#475569;font:inherit;font-size:17px;font-weight:900;line-height:1;cursor:pointer}
.str-sidebar-toggle:hover{background:#eef2f7;border-color:rgba(23,32,51,.2)}
.str-search{margin:10px 12px;padding:8px 10px;border-radius:8px;border:1px solid rgba(23,32,51,.14);background:#fff;font-size:13px;color:inherit;font-family:inherit}
.str-tree{flex:1;min-height:0;overflow:auto;padding:0 8px 12px;display:flex;flex-direction:column;gap:4px}
.str-row{width:100%;min-width:0;min-height:var(--str-entry-min-height);display:grid;grid-template-columns:18px var(--str-entry-icon-column) minmax(0,1fr) minmax(40px,auto);gap:var(--str-entry-gap);align-items:center;padding:var(--str-entry-padding-y) var(--str-entry-padding-x) var(--str-entry-padding-y) calc(var(--str-entry-padding-x) + clamp(0px,calc(var(--str-depth,0) * var(--str-entry-depth-step)),var(--str-entry-depth-max)));border:1px solid transparent;border-radius:var(--str-entry-radius);background:none;color:inherit;font:inherit;font-size:var(--str-entry-name-size);text-align:left;cursor:pointer}
.str-row:hover{background:#eef2f7}
.str-row.active{background:#e2ebff;border-color:#b9cdfb}
.str-twisty{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;color:#64748b;font-size:10px;line-height:1}
.str-twisty[data-has-children='false']{visibility:hidden}
.str-twisty:hover{background:rgba(23,32,51,.08)}
.str-kind{min-width:0;height:var(--str-entry-ext-height);display:inline-flex;align-items:center;justify-content:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 3px;border-radius:var(--str-entry-ext-radius);background:rgba(33,129,95,.12);color:#1d7a56;font-size:var(--str-entry-ext-size);font-weight:900;line-height:1;text-transform:uppercase}
.str-row-branch .str-kind{background:rgba(29,78,216,.12);color:#1d4ed8}
.str-row-link .str-kind{background:rgba(126,34,206,.12);color:#7e22ce}
.str-row-dir .str-kind{background:rgba(161,98,7,.12);color:#a16207}
.str-copy{display:flex;flex-direction:column;min-width:0;gap:1px}
.str-copy strong{font-size:var(--str-entry-name-size);font-weight:600;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.str-copy em{font-size:var(--str-entry-meta-size);font-style:normal;color:#7b8794;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.str-meta{display:flex;align-items:center;gap:6px;font-size:var(--str-entry-meta-size);color:#7b8794;white-space:nowrap}
.str-tag{padding:1px 6px;border-radius:999px;background:#eef2f7;color:#475569}
.str-flag{padding:1px 6px;border-radius:999px;background:#fef3c7;color:#92400e}
.str-preview{grid-column:2;grid-row:1;width:100%;height:100%;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:#fff}
.str-toolbar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid rgba(23,32,51,.08)}
.str-preview-title{display:flex;flex-direction:column;min-width:0;flex:1;gap:2px}
.str-preview-title span{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#7b8794}
.str-preview-title strong{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.str-download{padding:6px 12px;border-radius:8px;border:1px solid rgba(23,32,51,.14);background:#fff;color:#334155;font-size:12px;font-family:inherit;cursor:pointer}
.str-download:hover:not(:disabled){background:#eef2f7}
.str-download:disabled{opacity:.5;cursor:not-allowed}
.str-nested-target{flex:1;min-height:0;overflow:auto;position:relative}
.str-nested-target>*{height:100%}
.str-message{display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center;color:#64748b}
.str-message strong{color:#334155;font-size:14px}
.str-message p{margin:0;font-size:12px;line-height:1.6;max-width:520px}
.str-meta-panel{display:flex;flex-direction:column;gap:14px;padding:18px 20px;overflow:auto;height:100%}
.str-meta-panel h3{margin:0;font-size:15px}
.str-meta-panel dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 14px;margin:0;font-size:12px}
.str-meta-panel dt{color:#7b8794}
.str-meta-panel dd{margin:0;word-break:break-word}
.str-meta-panel section{display:flex;flex-direction:column;gap:6px}
.str-meta-panel section>h4{margin:0;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7b8794}
.str-chip-list{display:flex;flex-wrap:wrap;gap:6px}
.str-issue{padding:6px 10px;border-radius:8px;font-size:11px;background:#fff7ed;color:#9a3412}
.str-issue[data-level='error']{background:#fef2f2;color:#b91c1c}
[data-viewer-theme='dark'] .str-shell{background:#0f1620;color:#e6edf3}
[data-viewer-theme='dark'] .str-sidebar{background:rgba(21,27,35,.9);border-color:rgba(139,148,158,.2)}
[data-viewer-theme='dark'] .str-preview{background:#131a23}
[data-viewer-theme='dark'] .str-row:hover{background:rgba(139,148,158,.14)}
[data-viewer-theme='dark'] .str-row.active{background:rgba(59,130,246,.24);border-color:rgba(96,165,250,.5)}
[data-viewer-theme='dark'] .str-kind{background:rgba(33,129,95,.24);color:#6ee7b7}
[data-viewer-theme='dark'] .str-row-branch .str-kind{background:rgba(59,130,246,.22);color:#93c5fd}
[data-viewer-theme='dark'] .str-row-link .str-kind{background:rgba(168,85,247,.24);color:#d8b4fe}
[data-viewer-theme='dark'] .str-row-dir .str-kind{background:rgba(245,158,11,.2);color:#fcd34d}
[data-viewer-theme='dark'] .str-sidebar-toggle,[data-viewer-theme='dark'] .str-download,[data-viewer-theme='dark'] .str-search{background:#1b2430;color:#e6edf3;border-color:rgba(139,148,158,.24)}
[data-viewer-theme='dark'] .str-copy em,[data-viewer-theme='dark'] .str-meta,[data-viewer-theme='dark'] .str-stats,[data-viewer-theme='dark'] .str-meta-panel dt{color:#9cacc0}
[data-viewer-theme='dark'] .str-message{color:#9cacc0}
[data-viewer-theme='dark'] .str-message strong,[data-viewer-theme='dark'] .str-meta-panel h3{color:#e6edf3}
[data-viewer-theme='dark'] .str-tag{background:#232c38;color:#cbd5e1}
@media (prefers-color-scheme:dark){[data-viewer-theme='system'] .str-shell{background:#0f1620;color:#e6edf3}
[data-viewer-theme='system'] .str-sidebar{background:rgba(21,27,35,.9);border-color:rgba(139,148,158,.2)}
[data-viewer-theme='system'] .str-preview{background:#131a23}
[data-viewer-theme='system'] .str-row:hover{background:rgba(139,148,158,.14)}
[data-viewer-theme='system'] .str-row.active{background:rgba(59,130,246,.24);border-color:rgba(96,165,250,.5)}
[data-viewer-theme='system'] .str-kind{background:rgba(33,129,95,.24);color:#6ee7b7}
[data-viewer-theme='system'] .str-row-branch .str-kind{background:rgba(59,130,246,.22);color:#93c5fd}
[data-viewer-theme='system'] .str-row-link .str-kind{background:rgba(168,85,247,.24);color:#d8b4fe}
[data-viewer-theme='system'] .str-row-dir .str-kind{background:rgba(245,158,11,.2);color:#fcd34d}
[data-viewer-theme='system'] .str-sidebar-toggle,[data-viewer-theme='system'] .str-download,[data-viewer-theme='system'] .str-search{background:#1b2430;color:#e6edf3;border-color:rgba(139,148,158,.24)}
[data-viewer-theme='system'] .str-copy em,[data-viewer-theme='system'] .str-meta,[data-viewer-theme='system'] .str-stats,[data-viewer-theme='system'] .str-meta-panel dt{color:#9cacc0}
[data-viewer-theme='system'] .str-message{color:#9cacc0}
[data-viewer-theme='system'] .str-message strong,[data-viewer-theme='system'] .str-meta-panel h3{color:#e6edf3}
[data-viewer-theme='system'] .str-tag{background:#232c38;color:#cbd5e1}}
@media (max-width:860px){.str-shell{grid-template-columns:1fr;grid-template-rows:minmax(180px,38%) minmax(0,1fr);--str-entry-min-height:44px;--str-entry-icon-column:30px;--str-entry-gap:6px;--str-entry-padding-y:4px;--str-entry-padding-x:6px;--str-entry-depth-step:6px;--str-entry-depth-max:24px;--str-entry-ext-height:26px;--str-entry-name-size:12px;--str-entry-meta-size:10px}.str-shell.str-sidebar-collapsed{grid-template-columns:1fr;grid-template-rows:0 minmax(0,1fr)}.str-sidebar{grid-column:1;grid-row:1;border-right:0;border-bottom:1px solid rgba(23,32,51,.1)}.str-preview{grid-column:1;grid-row:2}}
`;

/**
 * Badge labels stay within the `.entry-ext` column, so the full kind word moves
 * to the badge's `title` instead of overflowing the row.
 */
const STR_KIND_LABELS: Record<StrBranchKind, string> = {
  root: 'ROOT',
  node: 'NODE',
  branch: 'BR',
  unknown: 'BR',
};

const createStyle = (documentRef: Document) => {
  const style = documentRef.createElement('style');
  style.textContent = strStyle;
  return style;
};

const createElement = <K extends keyof HTMLElementTagNameMap>(
  documentRef: Document,
  tagName: K,
  className?: string,
  text?: string
) => {
  const element = documentRef.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
};

const isAbortError = (error: unknown) =>
  !!error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError';

const createNestedRendererRegistry = async (
  options: FileViewerOptions
): Promise<RendererRegistry> => {
  const registry = options.rendererMode === 'replace'
    ? createRendererRegistry([])
    : createFileViewerCoreRendererRegistry({
      builtinRenderers: options.builtinRenderers,
    }).registry;

  const autoRenderersEnabled = typeof options.autoRenderers === 'boolean'
    ? options.autoRenderers
    : options.autoRenderers?.enabled !== false && (options.rendererMode || 'extend') !== 'replace';

  const rendererInputs: FileViewerRendererPluginInput<StrNestedHandler>[] = [];
  if (autoRenderersEnabled) {
    rendererInputs.push(...listFileViewerAutoRendererPresets<StrNestedHandler>());
  }
  rendererInputs.push(
    ...resolveFileViewerRendererPresetInputs<StrNestedHandler>(
      options.preset as FileViewerRendererPresetInput<StrNestedHandler> | undefined
    ),
    ...resolveFileViewerRendererPresetInputs<StrNestedHandler>(
      options.presets as FileViewerRendererPresetInput<StrNestedHandler> | undefined
    )
  );
  if (options.renderers) {
    rendererInputs.push(options.renderers as FileViewerRendererPluginInput<StrNestedHandler>);
  }

  const plugins = collectFileViewerRendererPlugins<StrNestedHandler>(rendererInputs);
  if (!plugins.length) {
    return registry;
  }

  await installFileViewerRendererPlugins<StrNestedHandler>({
    registry,
    plugins,
    registerHandler: registration => {
      const definition = registry.getById(registration.rendererId);
      if (!definition) {
        return;
      }
      registry.register({
        ...definition,
        load: createFileRenderHandlerLoader({
          handler: registration.handler,
          getTarget: loadContext => loadContext.surface.container as HTMLDivElement,
        }),
      });
    },
  });

  return registry;
};

const buildRenderContext = (context: RendererLoadContext): FileRenderContext => ({
  filename: context.source.filename,
  url: context.source.url,
  streamUrl: context.source.url,
  signal: context.signal,
  options: context.options,
  surface: context.surface,
  registerExportAdapter: context.registerExportAdapter,
  registerThumbnailAdapter: context.registerThumbnailAdapter,
  ...(context.renderContext || {}),
});

const createNestedInstance = (
  target: HTMLDivElement,
  session: RendererSession
): FileViewerRenderedInstance => ({
  $el: target,
  destroy: () => session.destroy?.(),
});

/**
 * Reads the bytes of a single-file source as a ZIP container.
 *
 * Returns `null` when the source carries no bytes at all (nothing to open) and
 * an empty list when the bytes are not a ZIP archive, so the caller can tell
 * "no directory source" apart from "unreadable container".
 */
const readStrArchiveEntries = async (
  context: RendererLoadContext
): Promise<StrZipEntry[] | null> => {
  const source = context.source;
  let buffer: ArrayBuffer | null = null;
  if (source.file) {
    buffer = await source.file.arrayBuffer();
  } else if (source.buffer) {
    buffer = source.buffer;
  } else if (source.url) {
    const response = await fetch(source.url, { signal: context.signal });
    if (!response.ok) {
      return null;
    }
    buffer = await response.arrayBuffer();
  }

  if (!buffer || !buffer.byteLength) {
    return null;
  }

  try {
    return await readStrZipEntries(buffer);
  } catch (error) {
    if (error instanceof StrZipError && error.code === 'not-a-zip') {
      return [];
    }
    throw error;
  }
};

export default async function mountStrBundleViewer(
  loadContext: RendererLoadContext
): Promise<RendererSession> {
  const target = loadContext.surface.container as HTMLDivElement;
  const documentRef = target.ownerDocument;
  const options = loadContext.options || {};
  const t = createFileViewerTranslator(options);
  const strOptions = options.str || {};
  const collapsedDepth = typeof strOptions.collapsedDepth === 'number'
    ? Math.max(0, strOptions.collapsedDepth)
    : 2;

  const root = createElement(documentRef, 'section', 'str-shell');
  root.dataset.viewerDensity = normalizeFileViewerUiDensity(options.ui?.density);

  const sidebar = createElement(documentRef, 'aside', 'str-sidebar');
  const head = createElement(documentRef, 'div', 'str-head');
  const headMain = createElement(documentRef, 'div', 'str-head-main');
  const badge = createElement(documentRef, 'span', 'str-badge', 'STR');
  const title = createElement(documentRef, 'strong', undefined, loadContext.source.filename);
  title.title = loadContext.source.filename;
  const stats = createElement(documentRef, 'p', 'str-stats');
  const sidebarHide = createElement(documentRef, 'button', 'str-sidebar-toggle', '‹') as HTMLButtonElement;
  sidebarHide.type = 'button';
  headMain.append(badge, title, stats);
  head.append(headMain, sidebarHide);

  const search = createElement(documentRef, 'input', 'str-search') as HTMLInputElement;
  search.type = 'search';
  search.placeholder = t('str.search.placeholder');
  const tree = createElement(documentRef, 'div', 'str-tree');
  tree.setAttribute('role', 'tree');
  sidebar.append(head, search, tree);

  const preview = createElement(documentRef, 'main', 'str-preview');
  const toolbar = createElement(documentRef, 'div', 'str-toolbar');
  const sidebarShow = createElement(documentRef, 'button', 'str-sidebar-toggle', '‹') as HTMLButtonElement;
  sidebarShow.type = 'button';
  const previewTitle = createElement(documentRef, 'div', 'str-preview-title');
  const previewLabel = createElement(documentRef, 'span', undefined, t('str.preview.title'));
  const previewName = createElement(documentRef, 'strong', undefined, t('str.preview.chooseFile'));
  previewTitle.append(previewLabel, previewName);
  const download = createElement(documentRef, 'button', 'str-download', t('str.preview.downloadFile')) as HTMLButtonElement;
  download.type = 'button';
  download.disabled = true;
  toolbar.append(sidebarShow, previewTitle, download);
  const previewBody = createElement(documentRef, 'div', 'str-nested-target') as HTMLDivElement;
  preview.append(toolbar, previewBody);
  root.append(sidebar, preview);
  target.replaceChildren(createStyle(documentRef), root);

  let destroyed = false;
  let nestedSession: RendererSession | undefined;
  let selectedKey: string | null = null;
  let selectedFile: StrBundleFileNode | null = null;
  let nestedRegistry: RendererRegistry | null = null;
  let bundle: StrBundle | null = null;
  let previewSequence = 0;
  let sidebarCollapsed = false;
  const collapsed = new Set<string>();
  const objectUrls: string[] = [];
  const disposers: Array<() => void> = [];

  const setPreviewName = (text: string) => {
    previewName.textContent = text;
    previewName.title = text;
  };

  const showMessage = (messageTitle: string, message: string, detail?: string) => {
    const wrapper = createElement(documentRef, 'div', 'str-message');
    wrapper.append(
      createElement(documentRef, 'strong', undefined, messageTitle),
      createElement(documentRef, 'p', undefined, message)
    );
    if (detail) {
      wrapper.append(createElement(documentRef, 'p', undefined, detail));
    }
    previewBody.replaceChildren(wrapper);
  };

  const disposeNested = () => {
    const session = nestedSession;
    nestedSession = undefined;
    if (session?.destroy) {
      void session.destroy();
    }
  };

  const getRegistry = async () => {
    if (!nestedRegistry) {
      nestedRegistry = await createNestedRendererRegistry(options);
    }
    return nestedRegistry;
  };

  const renderNested = async (
    buffer: ArrayBuffer,
    filename: string,
    type: string,
    container: HTMLDivElement
  ): Promise<RendererSession | undefined> => {
    const registry = await getRegistry();
    const renderer = registry.getByExtension(type);
    if (!renderer?.load) {
      showMessage(
        t('str.preview.title'),
        type ? `.${type}` : filename,
        t('str.error.needsFolderHint')
      );
      return undefined;
    }

    const baseContext = buildRenderContext(loadContext);
    return await renderer.load({
      source: normalizeSource({ buffer, filename, type }),
      surface: { container },
      options,
      signal: loadContext.signal,
      registerExportAdapter: loadContext.registerExportAdapter,
      renderContext: {
        ...baseContext,
        renderNestedBuffer: (nestedBuffer, nestedType, nestedTarget, nestedContext) =>
          renderNested(
            nestedBuffer,
            nestedContext?.filename || `preview.${nestedType}`,
            nestedType,
            nestedTarget
          ).then(session => (session ? createNestedInstance(nestedTarget, session) : undefined)),
      },
    });
  };

  const readBuffer = async (node: StrBundleFileNode) => {
    if (!node.blob) {
      return null;
    }
    return await node.blob.arrayBuffer();
  };

  const previewFile = async (node: StrBundleFileNode) => {
    const requestId = ++previewSequence;
    selectedFile = node;
    setPreviewName(node.path);
    download.disabled = !node.blob;
    disposeNested();

    if (!node.blob) {
      showMessage(t('str.error.title'), node.path, t('str.issue.diverged'));
      return;
    }

    const container = createElement(documentRef, 'div') as HTMLDivElement;
    previewBody.replaceChildren(container);
    try {
      const buffer = await readBuffer(node);
      if (requestId !== previewSequence || !buffer) {
        return;
      }
      const session = await renderNested(buffer, node.name, node.extension, container);
      if (requestId !== previewSequence) {
        void session?.destroy?.();
        return;
      }
      nestedSession = session;
    } catch (error) {
      if (requestId !== previewSequence || isAbortError(error)) {
        return;
      }
      showMessage(
        t('str.error.title'),
        node.name,
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  const appendMetaRow = (
    list: HTMLElement,
    term: string,
    value: string
  ) => {
    list.append(
      createElement(documentRef, 'dt', undefined, term),
      createElement(documentRef, 'dd', undefined, value)
    );
  };

  const buildMetaPanel = (node: StrBundleBranchNode) => {
    const panel = createElement(documentRef, 'div', 'str-meta-panel');
    panel.append(createElement(documentRef, 'h3', undefined, node.title));

    const list = createElement(documentRef, 'dl');
    if (node.type) {
      appendMetaRow(list, 'type', node.type);
    }
    appendMetaRow(list, 'kind', node.branchKind);
    appendMetaRow(list, 'path', node.path || '.');
    if (node.link) {
      appendMetaRow(list, 'link', `${node.link.mode} → ${node.link.targetId}`);
    }
    if (node.revision !== undefined) {
      appendMetaRow(list, 'revision', String(node.revision));
    }
    if (node.updatedAt) {
      appendMetaRow(list, 'updated_at', node.updatedAt);
    }
    if (node.createdAt) {
      appendMetaRow(list, 'created_at', node.createdAt);
    }
    appendMetaRow(list, 'manifest', node.manifestPath);
    if (node.summary) {
      appendMetaRow(list, 'summary', node.summary);
    }
    panel.append(list);

    if (node.tags.length) {
      const section = createElement(documentRef, 'section');
      section.append(createElement(documentRef, 'h4', undefined, 'tags'));
      const chips = createElement(documentRef, 'div', 'str-chip-list');
      node.tags.forEach(tag => chips.append(createElement(documentRef, 'span', 'str-tag', tag)));
      section.append(chips);
      panel.append(section);
    }

    const policyKeys = Object.keys(node.policies);
    if (policyKeys.length) {
      const section = createElement(documentRef, 'section');
      section.append(createElement(documentRef, 'h4', undefined, t('str.meta.policies')));
      const list2 = createElement(documentRef, 'dl');
      policyKeys.forEach(key => {
        appendMetaRow(list2, key, String(node.policies[key]));
      });
      section.append(list2);
      panel.append(section);
    }

    if (node.authors.length) {
      const section = createElement(documentRef, 'section');
      section.append(createElement(documentRef, 'h4', undefined, t('str.meta.authors')));
      const chips = createElement(documentRef, 'div', 'str-chip-list');
      node.authors.forEach(author => {
        chips.append(
          createElement(
            documentRef,
            'span',
            'str-tag',
            author.name ? `${author.name} · ${author.role || ''}`.trim() : `${author.id} · ${author.role || ''}`.trim()
          )
        );
      });
      section.append(chips);
      panel.append(section);
    }

    if (node.refs.length) {
      const section = createElement(documentRef, 'section');
      section.append(createElement(documentRef, 'h4', undefined, t('str.meta.refs')));
      const list3 = createElement(documentRef, 'dl');
      node.refs.forEach(ref => {
        appendMetaRow(list3, ref.rel, `${ref.title || ref.target} → ${ref.target}`);
      });
      section.append(list3);
      panel.append(section);
    }

    const entryRows = collectEntries(node);
    if (entryRows.length) {
      const section = createElement(documentRef, 'section');
      section.append(createElement(documentRef, 'h4', undefined, `${t('str.meta.entries')} · ${entryRows.length}`));
      const list4 = createElement(documentRef, 'dl');
      entryRows.slice(0, 200).forEach(entry => {
        appendMetaRow(
          list4,
          entry.path,
          [entry.rawRole, entry.type, entry.mediaType, entry.title].filter(Boolean).join(' · ')
        );
      });
      section.append(list4);
      panel.append(section);
    }

    if (node.issues.length) {
      const section = createElement(documentRef, 'section');
      node.issues.forEach(issue => {
        const row = createElement(documentRef, 'div', 'str-issue', `${issue.code} · ${issue.message}`);
        row.dataset.level = issue.level;
        section.append(row);
      });
      panel.append(section);
    }

    if (node.manifestText) {
      const section = createElement(documentRef, 'section');
      const manifestButton = createElement(
        documentRef,
        'button',
        'str-download',
        `${node.manifestPath}`
      ) as HTMLButtonElement;
      manifestButton.type = 'button';
      manifestButton.addEventListener('click', () => {
        void previewManifest(node);
      });
      section.append(manifestButton);
      panel.append(section);
    }

    return panel;
  };

  const collectEntries = (node: StrBundleBranchNode) => {
    const entries: Array<{ path: string; rawRole: string; type?: string; mediaType?: string; title?: string }> = [];
    const walk = (branch: StrBundleBranchNode) => {
      if (branch.manifestText) {
        try {
          parseStrBranchMeta(branch.manifestText).entries.forEach(entry => {
            entries.push({
              path: entry.path,
              rawRole: entry.rawRole,
              type: entry.type,
              mediaType: entry.mediaType,
              title: entry.title,
            });
          });
        } catch { /* A malformed manifest is surfaced through branch issues. */ }
      }
      branch.rows.forEach(row => {
        if (row.kind === 'branch') {
          walk(row);
        }
      });
    };
    walk(node);
    return entries;
  };

  const toArrayBuffer = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  };

  const previewManifest = async (node: StrBundleBranchNode) => {
    const requestId = ++previewSequence;
    selectedFile = null;
    setPreviewName(node.manifestPath);
    download.disabled = true;
    disposeNested();
    const container = createElement(documentRef, 'div') as HTMLDivElement;
    previewBody.replaceChildren(container);
    const session = await renderNested(
      toArrayBuffer(node.manifestText),
      '.str.toml',
      'toml',
      container
    );
    if (requestId !== previewSequence) {
      void session?.destroy?.();
      return;
    }
    nestedSession = session;
  };

  const selectBranch = (node: StrBundleBranchNode) => {
    selectedKey = node.key;
    selectedFile = null;
    disposeNested();
    previewSequence += 1;
    setPreviewName(`${node.title}${node.type ? ` · ${node.type}` : ''}`);
    download.disabled = true;
    previewBody.replaceChildren(buildMetaPanel(node));
    renderTree();
  };

  const selectFile = (node: StrBundleFileNode) => {
    selectedKey = node.path;
    renderTree();
    void previewFile(node);
  };

  const buildRow = (node: StrBundleNode, depth: number) => {
    if (node.kind === 'branch') {
      const hasChildren = node.rows.length > 0;
      const isCollapsed = collapsed.has(node.key);
      const row = createElement(
        documentRef,
        'button',
        node.link ? 'str-row str-row-branch str-row-link' : 'str-row str-row-branch'
      ) as HTMLButtonElement;
      row.type = 'button';
      row.style.setProperty('--str-depth', String(depth));
      row.classList.toggle('active', selectedKey === node.key);
      const twisty = createElement(documentRef, 'span', 'str-twisty', hasChildren ? (isCollapsed ? '▶' : '▼') : '');
      twisty.dataset.hasChildren = String(hasChildren);
      if (hasChildren) {
        twisty.addEventListener('click', event => {
          event.stopPropagation();
          if (collapsed.has(node.key)) {
            collapsed.delete(node.key);
          } else {
            collapsed.add(node.key);
          }
          renderTree();
        });
      }
      const kind = createElement(
        documentRef,
        'span',
        'str-kind',
        node.link ? 'LINK' : STR_KIND_LABELS[node.branchKind]
      );
      kind.title = node.link
        ? `${node.link.mode} link → ${node.link.targetId}`
        : `kind: ${node.branchKind}`;
      const copy = createElement(documentRef, 'span', 'str-copy');
      const nameNode = createElement(documentRef, 'strong', undefined, node.title);
      nameNode.title = node.title;
      copy.append(nameNode);
      if (node.summary || node.type) {
        copy.append(createElement(documentRef, 'em', undefined, node.summary || node.type || ''));
      }
      const meta = createElement(documentRef, 'span', 'str-meta');
      if (node.tags.length) {
        meta.append(createElement(documentRef, 'span', 'str-tag', node.tags.slice(0, 2).join(' · ')));
      }
      if (node.issues.length) {
        meta.append(createElement(documentRef, 'span', 'str-flag', String(node.issues.length)));
      }
      row.append(twisty, kind, copy, meta);
      row.title = node.path || '.';
      row.addEventListener('click', () => selectBranch(node));
      return { row, collapsed: isCollapsed, hasChildren };
    }

    if (node.kind === 'dir') {
      const isCollapsed = collapsed.has(node.path);
      const row = createElement(documentRef, 'button', 'str-row str-row-dir') as HTMLButtonElement;
      row.type = 'button';
      row.style.setProperty('--str-depth', String(depth));
      const twisty = createElement(documentRef, 'span', 'str-twisty', isCollapsed ? '▶' : '▼');
      twisty.dataset.hasChildren = 'true';
      twisty.addEventListener('click', event => {
        event.stopPropagation();
        if (collapsed.has(node.path)) {
          collapsed.delete(node.path);
        } else {
          collapsed.add(node.path);
        }
        renderTree();
      });
      const kind = createElement(documentRef, 'span', 'str-kind', 'DIR');
      kind.title = 'content folder';
      const copy = createElement(documentRef, 'span', 'str-copy');
      copy.append(
        createElement(documentRef, 'strong', undefined, node.name),
        createElement(documentRef, 'em', undefined, node.path)
      );
      const meta = createElement(documentRef, 'span', 'str-meta', String(node.rows.length));
      row.append(twisty, kind, copy, meta);
      row.addEventListener('click', () => {
        if (collapsed.has(node.path)) {
          collapsed.delete(node.path);
        } else {
          collapsed.add(node.path);
        }
        renderTree();
      });
      return { row, collapsed: isCollapsed, hasChildren: true };
    }

    const row = createElement(documentRef, 'button', 'str-row str-row-file') as HTMLButtonElement;
    row.type = 'button';
    row.style.setProperty('--str-depth', String(depth));
    row.classList.toggle('active', selectedKey === node.path);
    const twisty = createElement(documentRef, 'span', 'str-twisty');
    twisty.dataset.hasChildren = 'false';
    const kind = createElement(
      documentRef,
      'span',
      'str-kind',
      (node.extension || 'FILE').slice(0, 4).toUpperCase()
    );
    kind.title = node.extension ? `.${node.extension}` : 'file';
    const copy = createElement(documentRef, 'span', 'str-copy');
    const nameNode = createElement(documentRef, 'strong', undefined, node.name);
    nameNode.title = node.name;
    copy.append(nameNode, createElement(documentRef, 'em', undefined, node.path));
    // Unregistered payloads stay visible as rows; the branch's own issue list in
    // the meta panel is where the manifest drift is explained, so no extra badge.
    const meta = createElement(documentRef, 'span', 'str-meta', formatStrBytes(node.size));
    row.append(twisty, kind, copy, meta);
    row.addEventListener('click', () => selectFile(node));
    return { row, collapsed: false, hasChildren: false };
  };

  const renderNodes = (container: HTMLElement, nodes: readonly StrBundleNode[], depth: number) => {
    nodes.forEach(node => {
      const built = buildRow(node, depth);
      container.append(built.row);
      if ((node.kind === 'branch' || node.kind === 'dir') && built.hasChildren && !built.collapsed) {
        renderNodes(container, node.rows, depth + 1);
      }
    });
  };

  const applyDefaultCollapse = (nodes: readonly StrBundleNode[], depth: number) => {
    nodes.forEach(node => {
      if (node.kind === 'branch' || node.kind === 'dir') {
        const key = node.kind === 'branch' ? node.key : node.path;
        if (depth + 1 >= collapsedDepth && node.rows.length) {
          collapsed.add(key);
        }
        applyDefaultCollapse(node.rows, depth + 1);
      }
    });
  };

  const renderTree = () => {
    tree.replaceChildren();
    if (!bundle) {
      return;
    }
    const query = search.value.trim();
    if (query) {
      const matches = filterNodes(bundle.root.rows, query);
      if (!matches.length) {
        tree.append(createElement(documentRef, 'p', 'str-stats', t('str.empty.message')));
        return;
      }
      renderNodes(tree, matches.map(node => stripNode(node, 0)), 0);
      return;
    }
    renderNodes(tree, bundle.root.rows, 0);
  };

  const filterNodes = (nodes: readonly StrBundleNode[], query: string): StrBundleNode[] => {
    const needle = query.toLowerCase();
    const results: StrBundleNode[] = [];
    const walk = (list: readonly StrBundleNode[]) => {
      list.forEach(node => {
        const haystack = node.kind === 'branch'
          ? `${node.title} ${node.path} ${node.type || ''} ${node.summary || ''} ${node.tags.join(' ')}`
          : node.kind === 'file'
            ? `${node.name} ${node.path}`
            : `${node.name} ${node.path}`;
        if (haystack.toLowerCase().includes(needle)) {
          results.push(node);
        }
        if (node.kind === 'branch' || node.kind === 'dir') {
          walk(node.rows);
        }
      });
    };
    walk(nodes);
    return results;
  };

  const stripNode = (node: StrBundleNode, depth: number): StrBundleNode => {
    if (node.kind === 'branch') {
      return { ...node, depth, rows: [] };
    }
    if (node.kind === 'dir') {
      return { ...node, depth, rows: [] };
    }
    return { ...node, depth };
  };

  const updateStats = () => {
    if (!bundle) {
      return;
    }
    stats.textContent = t('str.stats.summary', {
      branches: String(bundle.branchCount),
      files: String(bundle.fileCount),
      depth: String(bundle.depth),
    });
  };

  const startViewer = async () => {
    // `source.files` arrives already rooted at the bundle; `options.str.files` is
    // a raw host list and must be normalised the same way.
    const explicitFolder = loadContext.source.files?.length
      ? null
      : normalizeFileViewerFolderEntries(strOptions.files);
    let folderEntries = loadContext.source.files?.length
      ? [...loadContext.source.files]
      : explicitFolder?.entries || [];
    let bundleName = explicitFolder?.rootName || loadContext.source.filename;

    if (!folderEntries.length) {
      // macOS hands a bundle package to a file input as `<bundle>.str.zip`, and a
      // host may also pass an explicit archive, so try the ZIP container before
      // falling back to the "no directory" states.
      try {
        const archive = await readStrArchiveEntries(loadContext);
        if (destroyed || loadContext.signal?.aborted) {
          return;
        }
        if (archive) {
          const normalized = normalizeFileViewerFolderEntries(
            await Promise.all(
              archive.map(async entry => ({
                path: entry.path,
                // Only manifests are inflated now. Payloads stay lazy, so a
                // bundle holding hundreds of megabytes never decodes in full
                // just to draw the structure tree.
                file: isStrManifestPath(entry.path)
                  ? new Blob([(await entry.read()) as BlobPart])
                  : new StrZipLazyBlob(entry),
              }))
            )
          );
          if (!normalized.isStrBundle) {
            setPreviewName(loadContext.source.filename);
            showMessage(
              t('str.error.title'),
              t('str.error.zipUnsupported', { name: loadContext.source.filename }),
              loadContext.source.filename
            );
            stats.textContent = t('str.error.zipUnsupported', { name: loadContext.source.filename });
            return;
          }
          folderEntries = normalized.entries;
          bundleName = normalized.rootName || bundleName;
        }
      } catch (error) {
        if (destroyed || isAbortError(error)) {
          return;
        }
        setPreviewName(loadContext.source.filename);
        const detail = error instanceof Error ? error.message : String(error);
        showMessage(
          t('str.error.title'),
          t('str.error.zipUnsupported', { name: loadContext.source.filename }),
          detail
        );
        stats.textContent = t('str.error.zipUnsupported', { name: loadContext.source.filename });
        return;
      }
    }

    if (!folderEntries.length) {
      setPreviewName(loadContext.source.filename || t('str.preview.chooseFile'));
      if (isFileViewerBundlePackageSource(loadContext.source)) {
        // macOS presents the `.str` directory as a bundle package, so file
        // inputs and drag-and-drop hand over a zero-byte entry instead of a
        // directory listing. Explain the remedy instead of showing a generic
        // "needs a folder" state.
        showMessage(
          t('str.error.bundlePackage'),
          t('str.error.bundlePackageHint'),
          t('str.error.bundlePackageFix')
        );
        stats.textContent = t('str.error.bundlePackage');
        try {
          options.onDiagnostic?.({
            code: 'str-bundle-package-source',
            level: 'warning',
            message: t('str.error.bundlePackageHint'),
          });
        } catch { /* Host diagnostics must never break the viewer. */ }
        return;
      }
      showMessage(t('str.error.needsFolder'), t('str.error.needsFolderHint'));
      stats.textContent = t('str.error.needsFolder');
      try {
        options.onDiagnostic?.({
          code: 'str-folder-source-required',
          level: 'warning',
          message: t('str.error.needsFolderHint'),
        });
      } catch { /* Host diagnostics must never break the viewer. */ }
      return;
    }

    stats.textContent = t('str.loading.title');
    showMessage(t('str.loading.title'), t('str.loading.hint'));

    const sources = await readStrBundleSources(folderEntries);
    if (destroyed) {
      return;
    }

    bundle = parseStrBundle({ name: bundleName, files: sources });
    title.textContent = bundle.name;
    title.title = bundle.name;
    updateStats();

    if (!bundle.root.rows.length && !bundle.root.manifestText) {
      showMessage(t('str.error.title'), t('str.error.metaMissing'), t('str.empty.message'));
      return;
    }

    applyDefaultCollapse(bundle.root.rows, 0);
    renderTree();

    const initialPath = strOptions.initialPath?.trim();
    if (initialPath) {
      const found = findNodeByPath(bundle.root, initialPath);
      if (found && found.kind === 'file') {
        selectFile(found);
        return;
      }
      if (found && found.kind === 'branch') {
        selectBranch(found);
        return;
      }
    }

    showMessage(t('str.preview.chooseFile'), t('str.loading.hint'));
  };

  const findNodeByPath = (branch: StrBundleBranchNode, path: string): StrBundleNode | null => {
    let found: StrBundleNode | null = null;
    const walk = (nodes: readonly StrBundleNode[]) => {
      nodes.forEach(node => {
        if (found) {
          return;
        }
        if (node.path === path) {
          found = node;
          return;
        }
        if (node.kind === 'branch' || node.kind === 'dir') {
          walk(node.rows);
        }
      });
    };
    walk(branch.rows);
    return found;
  };

  const onSearchInput = () => renderTree();
  search.addEventListener('input', onSearchInput);
  disposers.push(() => search.removeEventListener('input', onSearchInput));

  const setSidebarCollapsed = (value: boolean) => {
    sidebarCollapsed = value;
    const showLabel = t('str.sidebar.show');
    const hideLabel = t('str.sidebar.hide');
    root.classList.toggle('str-sidebar-collapsed', value);
    // The sidebar-head button can only hide; the toolbar button is a real
    // toggle, so its glyph and label always describe the current state.
    sidebarHide.textContent = '‹';
    sidebarShow.textContent = value ? '☰' : '‹';
    sidebarHide.title = hideLabel;
    sidebarShow.title = value ? showLabel : hideLabel;
    sidebarHide.setAttribute('aria-label', hideLabel);
    sidebarShow.setAttribute('aria-label', value ? showLabel : hideLabel);
    sidebarHide.setAttribute('aria-expanded', String(!value));
    sidebarShow.setAttribute('aria-expanded', String(!value));
  };
  const onSidebarHide = () => setSidebarCollapsed(true);
  const onSidebarToggle = () => setSidebarCollapsed(!sidebarCollapsed);
  setSidebarCollapsed(false);
  sidebarHide.addEventListener('click', onSidebarHide);
  sidebarShow.addEventListener('click', onSidebarToggle);
  disposers.push(() => sidebarHide.removeEventListener('click', onSidebarHide));
  disposers.push(() => sidebarShow.removeEventListener('click', onSidebarToggle));

  const onDownload = async () => {
    const node = selectedFile;
    if (!node?.blob) {
      return;
    }
    // A lazy archive member needs a real Blob before `createObjectURL`.
    const blob = node.blob instanceof StrZipLazyBlob
      ? await node.blob.materialize()
      : node.blob;
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    const anchor = documentRef.createElement('a');
    anchor.href = url;
    anchor.download = node.name;
    anchor.rel = 'noopener';
    anchor.click();
  };
  download.addEventListener('click', onDownload);
  disposers.push(() => download.removeEventListener('click', onDownload));

  try {
    await startViewer();
  } catch (error) {
    if (!destroyed && !isAbortError(error)) {
      // Never reuse a "missing manifest" message for an unexpected failure: the
      // real reason is what the host needs in order to act.
      const detail = error instanceof Error ? error.message : String(error);
      showMessage(t('str.error.title'), t('str.error.unexpected'), detail);
      stats.textContent = t('str.error.unexpected');
      try {
        options.onDiagnostic?.({ code: 'str-load-failed', level: 'error', message: detail });
      } catch { /* Host diagnostics must never break the viewer. */ }
      try {
        console.error('[file-viewer:renderer-str]', error);
      } catch { /* A locked-down console must not break the viewer either. */ }
    }
  }

  return {
    destroy: () => {
      destroyed = true;
      previewSequence += 1;
      disposers.splice(0).forEach(dispose => dispose());
      disposeNested();
      objectUrls.splice(0).forEach(url => URL.revokeObjectURL(url));
      target.replaceChildren();
    },
  };
}
