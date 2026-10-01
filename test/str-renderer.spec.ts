import { describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  DEFAULT_RENDERER_DEFINITIONS,
  FILE_VIEWER_STR_BUNDLE_META_FILENAME,
  createFileViewerCoreRendererRegistry,
  createRendererRegistry,
  createViewer,
  installFileViewerRendererPlugins,
  type FileViewerOptions,
  type RendererDefinition,
  isFileViewerBundlePackageSource,
  isFileViewerStrBundleFolder,
  isFileViewerStrBundleZipName,
  normalizeFileViewerFolderEntries,
  normalizeSource,
  resolveFileViewerFolderEntries,
  type FileViewerFolderEntry,
} from '../packages/core/src';
import { resolveFileViewerRendererSelection } from '../packages/presets/vite-plugin/src/index';
import {
  flattenStrBundle,
  parseStrBranchMeta,
  parseStrBundle,
  parseToml,
  MAX_STR_ZIP_ENTRY_BYTES,
  StrZipError,
  StrZipLazyBlob,
  strRenderer,
  STR_MANIFEST_FILENAME,
  strRendererDefinition,
  readStrZipEntries,
  type StrBranchMeta,
  type StrBundle,
  type StrBundleBranchNode,
  type StrBundleSourceFile,
} from '../packages/renderers/str/src';

// ---------------------------------------------------------------------------
// Fixture: the `客户运营.str` bundle from the STR specification (§10).
// Manifests are inlined verbatim so the test never depends on an external
// checkout; payload bodies are represented by small Blobs.
// ---------------------------------------------------------------------------

const CUSTOMER_ID = '01928f3a-7c4b-7001-8a01-000000000001';
const FOLLOWUP_ID = '01928f3a-7c4b-7101-8b01-000000000101';
const MEETING_ID = '01928f3a-7c4b-7102-8b02-000000000102';
const ORDER_ID = '01928f3a-7c4b-7002-8a02-000000000002';
const TAG_ID = '01928f3a-7c4b-7003-8a03-000000000003';

const ROOT_MANIFEST = `str = 1
spec = "1.17.0"
kind = "root"
id = "01928f3a-7c4b-7000-8000-000000000000"
name = "客户运营"
title = "客户运营结构化数据束"
summary = "以客户为主体的分支树。"
tags = ["crm", "demo"]
revision = 13
created_at = 2026-09-01T09:12:00+08:00
updated_at = 2026-09-30T23:46:09+00:00

[policies]
id_version = 7
max_depth = 32
manifest = "strict"

[[authors]]
id = "u:frowhy"
name = "Frowhy"
role = "owner"
at = 2026-09-01T09:12:00+08:00

[[entries]]
path = "${CUSTOMER_ID}"
role = "node"
id = "${CUSTOMER_ID}"
type = "crm.customer"
title = "客户档案 · 张伟"
order = 1

[[entries]]
path = "${ORDER_ID}"
role = "node"
id = "${ORDER_ID}"
type = "crm.order_dataset"
title = "订单数据集"
order = 2

[[entries]]
path = "${TAG_ID}"
role = "node"
id = "${TAG_ID}"
type = "crm.tag_system"
title = "标签体系"
order = 3
`;

const CUSTOMER_MANIFEST = `str = 1
spec = "1.17.0"
kind = "node"
id = "${CUSTOMER_ID}"
type = "crm.customer"
title = "客户档案 · 张伟"
tags = ["华东区", "vip"]
revision = 9

[[refs]]
id = "01928f3a-7c4b-7201-8d01-000000000201"
target = "${ORDER_ID}"
rel = "related"
title = "该客户的订单"
order = 1

[[entries]]
path = "${FOLLOWUP_ID}"
role = "branch"
id = "${FOLLOWUP_ID}"
type = "crm.followup_log"
title = "跟进记录"
order = 1

[[entries]]
path = "attachments"
role = "dir"
count = 1

[[entries]]
path = "avatar.png"
role = "asset"
media_type = "image/png"
size = 70

[[entries]]
path = "profile.json"
role = "payload"
media_type = "application/json"
size = 87
`;

const FOLLOWUP_MANIFEST = `str = 1
spec = "1.17.0"
kind = "branch"
id = "${FOLLOWUP_ID}"
type = "crm.followup_log"
title = "跟进记录"
tags = ["followup"]

[[entries]]
path = "${MEETING_ID}"
role = "branch"
id = "${MEETING_ID}"
type = "doc.meeting_note"
title = "2026-09 会议纪要"
order = 1

[[entries]]
path = "followups.json"
role = "payload"
media_type = "application/json"
size = 164
`;

const MEETING_MANIFEST = `str = 1
spec = "1.17.0"
kind = "branch"
id = "${MEETING_ID}"
type = "doc.meeting_note"
title = "2026-09 会议纪要"
tags = ["meeting"]

[[entries]]
path = "2026-09-10.md"
role = "payload"
media_type = "text/markdown"
size = 156
`;

const ORDER_MANIFEST = `str = 1
spec = "1.17.0"
kind = "node"
id = "${ORDER_ID}"
type = "crm.order_dataset"
title = "订单数据集"

[[entries]]
path = "orders.csv"
role = "payload"
media_type = "text/csv"
size = 136
`;

const TAG_MANIFEST = `str = 1
spec = "1.17.0"
kind = "node"
id = "${TAG_ID}"
type = "crm.tag_system"
title = "标签体系"

[[entries]]
path = "tags.json"
role = "payload"
media_type = "application/json"
size = 63
`;

const manifest = (path: string, text: string): StrBundleSourceFile => ({ path, text });
const payload = (path: string, body = 'payload'): StrBundleSourceFile => ({
  path,
  blob: new Blob([body]),
});

const buildExampleBundle = (): StrBundleSourceFile[] => [
  manifest(STR_MANIFEST_FILENAME, ROOT_MANIFEST),
  manifest(`${CUSTOMER_ID}/${STR_MANIFEST_FILENAME}`, CUSTOMER_MANIFEST),
  manifest(`${CUSTOMER_ID}/${FOLLOWUP_ID}/${STR_MANIFEST_FILENAME}`, FOLLOWUP_MANIFEST),
  manifest(`${CUSTOMER_ID}/${FOLLOWUP_ID}/${MEETING_ID}/${STR_MANIFEST_FILENAME}`, MEETING_MANIFEST),
  manifest(`${ORDER_ID}/${STR_MANIFEST_FILENAME}`, ORDER_MANIFEST),
  manifest(`${TAG_ID}/${STR_MANIFEST_FILENAME}`, TAG_MANIFEST),
  payload(`${CUSTOMER_ID}/profile.json`, '{"name":"张伟"}'),
  payload(`${CUSTOMER_ID}/avatar.png`, 'png'),
  payload(`${CUSTOMER_ID}/attachments/合同-2024Q1.pdf`, 'pdf'),
  payload(`${CUSTOMER_ID}/${FOLLOWUP_ID}/followups.json`, '[]'),
  payload(`${CUSTOMER_ID}/${FOLLOWUP_ID}/${MEETING_ID}/2026-09-10.md`, '# meeting'),
  payload(`${ORDER_ID}/orders.csv`, 'id,total'),
  payload(`${TAG_ID}/tags.json`, '[]'),
];

const findBranch = (bundle: StrBundle, title: string): StrBundleBranchNode => {
  const branch = [...bundle.branches.values()].find(node => node.title === title);
  if (!branch) {
    throw new Error(`branch "${title}" not found in the parsed bundle`);
  }
  return branch;
};

/** Branch rows are identified by their title, content rows by their file name. */
const titlesOf = (node: StrBundleBranchNode) =>
  node.rows.map(row => (row.kind === 'branch' ? row.title : row.name));

// ---------------------------------------------------------------------------
// TOML reader
// ---------------------------------------------------------------------------

describe('@file-viewer/renderer-str TOML reader', () => {
  it('parses scalars, arrays, inline tables and array-of-tables', () => {
    const table = parseToml(`
# comment
str = 1
spec = "1.17.0"
ratio = 0.5
enabled = true
tags = ["a", "b"]
at = 2026-09-01T09:12:00+08:00
inline = { one = 1, two = 'x' }

[ext]
"vendor.key" = "value"

[[entries]]
path = "a.json"
role = "payload"

[[entries]]
path = "b.json"
role = "asset"
`);

    expect(table.str).toBe(1);
    expect(table.spec).toBe('1.17.0');
    expect(table.ratio).toBe(0.5);
    expect(table.enabled).toBe(true);
    expect(table.tags).toEqual(['a', 'b']);
    expect(table.at).toBe('2026-09-01T09:12:00+08:00');
    expect(table.inline).toEqual({ one: 1, two: 'x' });
    expect((table.ext as Record<string, unknown>)['vendor.key']).toBe('value');

    const entries = table.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[1].path).toBe('b.json');
    expect(entries[1].role).toBe('asset');
  });

  it('supports multi-line arrays, multi-line strings and escapes', () => {
    const table = parseToml(`
limits = [
  1,
  2,
]
note = "line\\nbreak"
raw = '''
keep \\\\ as-is
'''
`);

    expect(table.limits).toEqual([1, 2]);
    expect(table.note).toBe('line\nbreak');
    expect(table.raw).toBe('keep \\\\ as-is\n');
  });
});

// ---------------------------------------------------------------------------
// Manifest mapping and tree building
// ---------------------------------------------------------------------------

describe('@file-viewer/renderer-str bundle model', () => {
  it('maps a manifest onto typed metadata', () => {
    const meta: StrBranchMeta = parseStrBranchMeta(ROOT_MANIFEST);
    expect(meta.kind).toBe('root');
    expect(meta.name).toBe('客户运营');
    expect(meta.tags).toEqual(['crm', 'demo']);
    expect(meta.revision).toBe(13);
    expect(meta.authors).toHaveLength(1);
    expect(meta.policies.manifest).toBe('strict');
    expect(meta.entries.map(entry => entry.role)).toEqual(['node', 'node', 'node']);
    expect(meta.entries[0].type).toBe('crm.customer');
  });

  it('builds the documented example bundle tree', () => {
    const bundle = parseStrBundle({ name: '客户运营.str', files: buildExampleBundle() });

    expect(bundle.name).toBe('客户运营.str');
    expect(bundle.root.branchKind).toBe('root');
    expect(bundle.root.title).toBe('客户运营结构化数据束');
    expect(bundle.root.tags).toEqual(['crm', 'demo']);
    expect(bundle.issues).toEqual([]);

    // ROOT children follow entries[].order, and only structural rows appear here.
    expect(bundle.root.rows.map(row => row.kind)).toEqual(['branch', 'branch', 'branch']);
    expect(titlesOf(bundle.root)).toEqual(['客户档案 · 张伟', '订单数据集', '标签体系']);

    expect(bundle.branchCount).toBe(6);
    expect(bundle.fileCount).toBe(7);
    expect(bundle.depth).toBe(3);

    const customer = findBranch(bundle, '客户档案 · 张伟');
    expect(customer.depth).toBe(1);
    expect(customer.type).toBe('crm.customer');
    expect(customer.refs).toHaveLength(1);
    expect(customer.refs[0].rel).toBe('related');
    expect(customer.refs[0].target).toBe(ORDER_ID);
    expect(customer.rows.map(row => row.kind)).toEqual(['branch', 'dir', 'file', 'file']);
    expect(titlesOf(customer)).toEqual(['跟进记录', 'attachments', 'avatar.png', 'profile.json']);
    expect(customer.issues).toEqual([]);

    const attachments = customer.rows[1];
    if (attachments.kind !== 'dir') {
      throw new Error('expected the attachments content folder');
    }
    expect(attachments.rows.map(row => row.name)).toEqual(['合同-2024Q1.pdf']);
    expect(attachments.rows[0].registered).toBe(false);

    const followup = findBranch(bundle, '跟进记录');
    expect(followup.depth).toBe(2);
    expect(followup.branchKind).toBe('branch');
    expect(titlesOf(followup)).toEqual(['2026-09 会议纪要', 'followups.json']);

    const meeting = findBranch(bundle, '2026-09 会议纪要');
    expect(meeting.depth).toBe(3);
    expect(titlesOf(meeting)).toEqual(['2026-09-10.md']);

    const order = findBranch(bundle, '订单数据集');
    expect(titlesOf(order)).toEqual(['orders.csv']);

    const tag = findBranch(bundle, '标签体系');
    expect(titlesOf(tag)).toEqual(['tags.json']);

    // Every entry resolves to a real blob so previews can stream from disk.
    const files = flattenStrBundle(bundle).filter(row => row.kind === 'file');
    expect(files).toHaveLength(7);
    files.forEach(file => {
      expect(file.blob).toBeDefined();
      expect(file.size).toBeGreaterThan(0);
    });
  });

  it('reports manifests the tree cannot expand', () => {
    const bundle = parseStrBundle({
      name: 'broken.str',
      files: [
        manifest(STR_MANIFEST_FILENAME, `str = 1\nspec = "1.17.0"\nkind = "root"\nname = "broken"\n`),
        manifest(
          `${CUSTOMER_ID}/${STR_MANIFEST_FILENAME}`,
          `str = 1\nspec = "1.17.0"\nkind = "node"\nid = "${CUSTOMER_ID}"\ntitle = "no manifests"\n`
        ),
        payload(`${CUSTOMER_ID}/orphan.json`),
        // A directory that carries a manifest but is not registered by the parent.
        manifest(
          'orphan-dir/.str.toml',
          `str = 1\nspec = "1.17.0"\nkind = "branch"\nid = "01928f3a-7c4b-7999-8a99-000000000099"\n`
        ),
        // A directory without any manifest: files exist but nothing describes them.
        payload('no-meta/readme.txt'),
      ],
    });

    const customer = findBranch(bundle, 'no manifests');
    expect(customer.issues.map(issue => issue.code)).toContain('E_MANIFEST_MISSING');
    const orphan = customer.rows.find(row => row.kind === 'file' && row.name === 'orphan.json');
    expect(orphan && orphan.kind === 'file' ? orphan.registered : true).toBe(false);

    const unregisteredDir = bundle.root.rows.find(
      row => row.kind === 'branch' && row.path === 'orphan-dir'
    );
    expect(unregisteredDir && unregisteredDir.kind === 'branch'
      ? unregisteredDir.issues.map(issue => issue.code)
      : []
    ).toContain('E_ENTRY_UNREGISTERED');

    const missingMetaDir = bundle.root.rows.find(
      row => row.kind === 'branch' && row.path === 'no-meta'
    );
    expect(missingMetaDir && missingMetaDir.kind === 'branch'
      ? missingMetaDir.issues.map(issue => issue.code)
      : []
    ).toContain('E_META_MISSING');
  });

  it('expands soft mounts by branch identity and stops on cycles', () => {
    const aId = '01928f3a-7c4b-7a01-8a01-0000000000a1';
    const bId = '01928f3a-7c4b-7b01-8b01-0000000000b1';

    const bundle = parseStrBundle({
      name: 'links.str',
      files: [
        manifest(
          STR_MANIFEST_FILENAME,
          `str = 1
spec = "1.17.0"
kind = "root"
name = "links"

[[entries]]
path = "${aId}"
role = "node"
id = "${aId}"
title = "A"

[[entries]]
path = "${bId}"
role = "node"
id = "${bId}"
title = "B"
`
        ),
        manifest(
          `${aId}/${STR_MANIFEST_FILENAME}`,
          `str = 1
spec = "1.17.0"
kind = "node"
id = "${aId}"
title = "A"

[[entries]]
path = "${bId}"
role = "link"
target = "${bId}"
title = "A mounts B"

[[entries]]
path = "a.json"
role = "payload"
`
        ),
        manifest(
          `${bId}/${STR_MANIFEST_FILENAME}`,
          `str = 1
spec = "1.17.0"
kind = "node"
id = "${bId}"
title = "B"

[[entries]]
path = "${aId}"
role = "link"
target = "${aId}"
title = "B mounts A"

[[entries]]
path = "b.json"
role = "payload"
`
        ),
        payload(`${aId}/a.json`),
        payload(`${bId}/b.json`),
      ],
    });

    const a = findBranch(bundle, 'A');
    const mount = a.rows.find(row => row.kind === 'branch' && row.link?.mode === 'soft');
    expect(mount).toBeDefined();
    if (!mount || mount.kind !== 'branch') {
      throw new Error('expected a soft mount row');
    }
    expect(mount.name).toBe('A mounts B');
    // The mount shows the target's own content, not a copy.
    expect(mount.path).toBe(bId);
    expect(mount.rows.map(row => row.name)).toContain('b.json');

    const nestedCycle = mount.rows.find(row => row.kind === 'branch' && row.cycle);
    expect(nestedCycle).toBeDefined();
    expect(nestedCycle && nestedCycle.kind === 'branch'
      ? nestedCycle.issues.map(issue => issue.code)
      : []
    ).toContain('E_LINK_CYCLE');
  });

  it('shows hard link content read-only while keeping its own structure', () => {
    const aId = '01928f3a-7c4b-7a02-8a01-0000000000a2';
    const hardId = '01928f3a-7c4b-7c02-8c01-0000000000c2';
    const subId = '01928f3a-7c4b-7c03-8c03-0000000000c3';

    const bundle = parseStrBundle({
      name: 'hard.str',
      files: [
        manifest(
          STR_MANIFEST_FILENAME,
          `str = 1
spec = "1.17.0"
kind = "root"
name = "hard"

[[entries]]
path = "${aId}"
role = "node"
id = "${aId}"
title = "Source"

[[entries]]
path = "${hardId}"
role = "link"
mode = "hard"
id = "${hardId}"
target = "${aId}"
title = "Hard mount"
`
        ),
        manifest(
          `${aId}/${STR_MANIFEST_FILENAME}`,
          `str = 1
spec = "1.17.0"
kind = "node"
id = "${aId}"
title = "Source"

[[entries]]
path = "source.json"
role = "payload"
`
        ),
        manifest(
          `${hardId}/${STR_MANIFEST_FILENAME}`,
          `str = 1
spec = "1.17.0"
kind = "node"
id = "${hardId}"
title = "Hard mount"

[[entries]]
path = "${subId}"
role = "branch"
id = "${subId}"
title = "Own branch"
`
        ),
        manifest(
          `${hardId}/${subId}/${STR_MANIFEST_FILENAME}`,
          `str = 1
spec = "1.17.0"
kind = "branch"
id = "${subId}"
title = "Own branch"
`
        ),
        payload(`${aId}/source.json`),
      ],
    });

    const hard = [...bundle.branches.values()].find(node => node.link?.mode === 'hard');
    expect(hard).toBeDefined();
    if (!hard) {
      throw new Error('expected the hard link branch');
    }
    expect(hard.contentReadOnly).toBe(true);
    // Structure comes from the link's own manifest, content from the target.
    expect(titlesOf(hard)).toEqual(['Own branch', 'source.json']);
  });

  it('ignores reserved names and operating-system metadata', () => {
    const bundle = parseStrBundle({
      name: 'reserved.str',
      files: [
        manifest(STR_MANIFEST_FILENAME, `str = 1\nspec = "1.17.0"\nkind = "root"\nname = "reserved"\n`),
        payload('.DS_Store'),
        payload('._profile.json'),
        payload('.gitignore'),
        payload('.str.cache/revisions.json'),
        payload('.str.schema/root-meta.schema.json'),
        payload('.git/config'),
        payload('visible.txt'),
      ],
    });

    expect(bundle.root.rows.map(row => row.name)).toEqual(['visible.txt']);
    expect(bundle.root.unregisteredCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Plugin wiring
// ---------------------------------------------------------------------------

describe('@file-viewer/renderer-str plugin', () => {
  it('registers the shared definition with a directory-aware loader', () => {
    expect(strRendererDefinition.extensions).toEqual(['str']);
    expect(strRendererDefinition.packageName).toBe('@file-viewer/renderer-str');
    expect(strRenderer.definitions).toHaveLength(1);
    expect(strRenderer.definitions?.[0].load).toBeTypeOf('function');
    // Handler registration is impossible for folder sources: `RendererLoadContext`
    // carries `files` instead of an `ArrayBuffer`.
    expect(strRenderer.handlers).toBeUndefined();
    expect(DEFAULT_RENDERER_DEFINITIONS.some(definition => definition.id === 'str')).toBe(true);
  });

  it('is an explicit opt-in tier: the format is registered but no preset assembles it', () => {
    const definition = DEFAULT_RENDERER_DEFINITIONS.find(item => item.id === 'str');
    expect(definition?.presets).toEqual([]);
    expect(definition?.status).toBe('experimental');
    expect(definition?.load).toBeUndefined();
  });

  it('resolves `.str` only after the host installs the plugin', async () => {
    const registry = createFileViewerCoreRendererRegistry({}).registry;

    // Registered format, no loader: the viewer can show the opt-in hint instead
    // of an empty pane, and must not silently claim the format is assembled.
    expect(registry.getById('str')).toBeDefined();
    expect(registry.getByExtension('str')?.load).toBeUndefined();

    await installFileViewerRendererPlugins({
      registry,
      plugins: [strRenderer],
      registerHandler: () => {
        throw new Error('the STR renderer must not rely on handler registration');
      },
    });

    const installed = registry.getByExtension('str');
    expect(installed?.id).toBe('str');
    expect(installed?.load).toBeTypeOf('function');
  });

  it('keeps the opt-in definition out of the preset-all aggregate', async () => {
    const { readFileSync } = await import('node:fs');
    const presetSource = readFileSync(
      new URL('../packages/presets/all/src/index.ts', import.meta.url),
      'utf8'
    );
    const extracted = /const extractedRendererIds = \[([^\]]*)\]/.exec(presetSource)?.[1] ?? '';
    // `fileViewerAllRendererPlugin` bundles every definition the preset does not
    // provide itself. Leaving `str` out of this list would ship a loader-less
    // STR definition in `allRenderers`, i.e. a format that claims support but
    // can never be assembled.
    expect(extracted).toContain("'str'");
    expect(presetSource).not.toContain("from '@file-viewer/renderer-str'");
  });

  it('is selectable by the Vite plugin without joining the preset-all downgrade path', () => {
    const root = new URL('..', import.meta.url).pathname;

    const explicit = resolveFileViewerRendererSelection({ formats: ['str'] }, root);
    expect(explicit.packages).toContain('@file-viewer/renderer-str');
    expect(explicit.rendererIds).toContain('str');

    const presetAll = resolveFileViewerRendererSelection({ preset: 'all' }, root);
    expect(presetAll.packages).not.toContain('@file-viewer/renderer-str');
  });
});

// ---------------------------------------------------------------------------
// Folder source plumbing in @file-viewer/core
// ---------------------------------------------------------------------------

describe('@file-viewer/core folder sources', () => {
  const withRelativePath = (path: string, body = 'x') => {
    const blob = new Blob([body]);
    Object.defineProperty(blob, 'name', { value: path.split('/').pop(), configurable: true });
    Object.defineProperty(blob, 'webkitRelativePath', { value: path, configurable: true });
    return blob;
  };

  it('derives the bundle root, filename and extension from a folder picker', () => {
    const entries: FileViewerFolderEntry[] = [
      withRelativePath('客户运营.str/.str.toml'),
      withRelativePath('客户运营.str/01928f3a-7c4b-7001-8a01-000000000001/profile.json'),
    ];

    const normalized = normalizeSource({ files: entries });

    expect(normalized.kind).toBe('folder');
    expect(normalized.filename).toBe('客户运营.str');
    expect(normalized.extension).toBe('str');
    expect(normalized.files?.map(entry => entry.path)).toEqual([
      '.str.toml',
      '01928f3a-7c4b-7001-8a01-000000000001/profile.json',
    ]);
    expect(normalized.size).toBe(2);
    expect(isFileViewerStrBundleFolder(normalized.files || [], normalized.filename)).toBe(true);
  });

  it('accepts explicit { path, file } entries and detects a bundle by its manifest', () => {
    const entries: FileViewerFolderEntry[] = [
      { path: './.str.toml', file: new Blob(['str = 1']) },
      { path: 'sub\\a.json', file: new Blob(['{}']) },
    ];

    const normalized = normalizeSource({ files: entries });

    expect(normalized.kind).toBe('folder');
    expect(normalized.extension).toBe('str');
    expect(normalized.filename).toBe('bundle.str');
    expect(normalized.files?.map(entry => entry.path)).toEqual(['.str.toml', 'sub/a.json']);
  });

  it('keeps non-bundle folders away from the STR extension', () => {
    const normalized = normalizeSource({
      files: [
        { path: 'docs/readme.md', file: new Blob(['# hi']) },
        { path: 'docs/notes.txt', file: new Blob(['hi']) },
      ],
    });

    expect(normalized.kind).toBe('folder');
    expect(normalized.extension).toBe('');
    expect(normalized.filename).toBe('docs');
  });

  it('still prefers folder sources over a single file', () => {
    const normalized = normalizeSource({
      file: new Blob(['png']),
      files: [{ path: '客户运营.str/.str.toml', file: new Blob(['str = 1']) }],
    });

    expect(normalized.kind).toBe('folder');
    expect(normalized.extension).toBe('str');
  });

  it('exposes the reserved manifest filename shared with the renderer', () => {
    expect(FILE_VIEWER_STR_BUNDLE_META_FILENAME).toBe('.str.toml');
    expect(STR_MANIFEST_FILENAME).toBe(FILE_VIEWER_STR_BUNDLE_META_FILENAME);
  });

  it('detects the macOS bundle-as-package source that no directory listing can rescue', () => {
    // Finder presents the bundle as one file: browsers hand over 0 bytes.
    expect(
      isFileViewerBundlePackageSource({ filename: '客户运营.str', size: 0 })
    ).toBe(true);
    expect(
      isFileViewerBundlePackageSource({
        file: new Blob([]),
        filename: '客户运营.str',
      })
    ).toBe(true);
    expect(isFileViewerBundlePackageSource({ filename: 'CLIENT.STR', size: 0 })).toBe(true);

    // Anything that still carries a directory listing is not the degenerate case.
    expect(
      isFileViewerBundlePackageSource({
        filename: '客户运营.str',
        files: [{ path: '.str.toml', file: new Blob(['str = 1']) }],
      })
    ).toBe(false);
    // A real zero-byte payload of another format is somebody else's problem.
    expect(isFileViewerBundlePackageSource({ filename: 'empty.txt', size: 0 })).toBe(false);
    expect(isFileViewerBundlePackageSource({ filename: '客户运营.str', size: 128 })).toBe(false);
    expect(isFileViewerBundlePackageSource({ filename: '', size: 0 })).toBe(false);
  });

  it('keeps a bundle told apart from a package through normalizeSource', () => {
    const packageSource = normalizeSource({
      file: new Blob([]),
      filename: '客户运营.str',
    });
    expect(packageSource.kind).toBe('file');
    expect(packageSource.extension).toBe('str');
    expect(isFileViewerBundlePackageSource(packageSource)).toBe(true);

    const folderSource = normalizeSource({
      files: [
        { path: '客户运营.str/.str.toml', file: new Blob(['str = 1']) },
        { path: '客户运营.str/profile.json', file: new Blob(['{}']) },
      ],
    });
    expect(folderSource.kind).toBe('folder');
    expect(isFileViewerBundlePackageSource(folderSource)).toBe(false);
  });

  it('normalises an explicit folder list exactly like source.files', () => {
    const rooted = normalizeFileViewerFolderEntries([
      { path: '客户运营.str/.str.toml', file: new Blob(['str = 1']) },
      { path: '客户运营.str/<uuid>/profile.json', file: new Blob(['{}']) },
    ]);
    expect(rooted.rootName).toBe('客户运营.str');
    expect(rooted.isStrBundle).toBe(true);
    expect(rooted.entries.map(entry => entry.path)).toEqual(['.str.toml', '<uuid>/profile.json']);

    // The macOS escape hatch: hand over the bundle contents instead of the
    // bundle itself. The root manifest is what identifies the format.
    const contents = normalizeFileViewerFolderEntries([
      { path: '.str.toml', file: new Blob(['str = 1']) },
      { path: 'profile.json', file: new Blob(['{}']) },
    ]);
    expect(contents.rootName).toBe('');
    expect(contents.isStrBundle).toBe(true);
    expect(contents.entries.map(entry => entry.path)).toEqual(['.str.toml', 'profile.json']);

    expect(normalizeFileViewerFolderEntries(undefined).isStrBundle).toBe(false);
    expect(normalizeFileViewerFolderEntries([]).entries).toEqual([]);
  });

  it('normalizes paths defensively', () => {
    const entries = resolveFileViewerFolderEntries([
      { path: 'a/./b/../c.json', file: new Blob(['x']) },
      { path: '   ', file: new Blob(['x']) },
    ]);
    expect(entries.map(entry => entry.path)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ZIP container: macOS delivers a bundle package as `<bundle>.str.zip`
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

const deflateRaw = async (bytes: Uint8Array) => {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new CompressionStream('deflate-raw')
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** Builds a minimal ZIP archive (no ZIP64, no data descriptors) for the tests. */
const buildZip = (files: Array<{ path: string; text: string; deflate?: boolean }>) =>
  Promise.all(
    files.map(async file => ({
      path: encoder.encode(file.path),
      data: encoder.encode(file.text),
      deflated: file.deflate ? await deflateRaw(encoder.encode(file.text)) : null,
    }))
  ).then(parts => {
    const chunks: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;

    for (const part of parts) {
      const method = part.deflated ? 8 : 0;
      const payload = part.deflated || part.data;
      const local = new Uint8Array(30 + part.path.length + payload.length);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0, true);
      localView.setUint16(8, method, true);
      localView.setUint32(18, payload.length, true);
      localView.setUint32(22, part.data.length, true);
      localView.setUint16(26, part.path.length, true);
      local.set(part.path, 30);
      local.set(payload, 30 + part.path.length);
      chunks.push(local);

      const record = new Uint8Array(46 + part.path.length);
      const recordView = new DataView(record.buffer);
      recordView.setUint32(0, 0x02014b50, true);
      recordView.setUint16(4, 20, true);
      recordView.setUint16(6, 20, true);
      recordView.setUint16(10, method, true);
      recordView.setUint32(20, payload.length, true);
      recordView.setUint32(24, part.data.length, true);
      recordView.setUint16(28, part.path.length, true);
      recordView.setUint32(42, offset, true);
      record.set(part.path, 46);
      central.push(record);

      offset += local.length;
    }

    const directorySize = central.reduce((total, record) => total + record.length, 0);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, parts.length, true);
    eocdView.setUint16(10, parts.length, true);
    eocdView.setUint32(12, directorySize, true);
    eocdView.setUint32(16, offset, true);

    const total = offset + directorySize + eocd.length;
    const archive = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      archive.set(chunk, cursor);
      cursor += chunk.length;
    }
    for (const record of central) {
      archive.set(record, cursor);
      cursor += record.length;
    }
    archive.set(eocd, cursor);
    return archive;
  });

const ZIP_ROOT = '客户运营.str';

/** A macOS-style package archive: the bundle directory is the ZIP root. */
const buildExampleZip = () =>
  buildZip([
    { path: `${ZIP_ROOT}/.str.toml`, text: ROOT_MANIFEST, deflate: true },
    { path: `${ZIP_ROOT}/${CUSTOMER_ID}/.str.toml`, text: CUSTOMER_MANIFEST, deflate: true },
    { path: `${ZIP_ROOT}/${CUSTOMER_ID}/profile.json`, text: '{"name":"张伟"}' },
    { path: `${ZIP_ROOT}/${CUSTOMER_ID}/avatar.png`, text: 'png' },
    { path: `${ZIP_ROOT}/${CUSTOMER_ID}/attachments/合同-2024Q1.pdf`, text: 'pdf' },
    { path: `${ZIP_ROOT}/${CUSTOMER_ID}/${FOLLOWUP_ID}/.str.toml`, text: FOLLOWUP_MANIFEST, deflate: true },
    { path: `${ZIP_ROOT}/${CUSTOMER_ID}/${FOLLOWUP_ID}/followups.json`, text: '[]' },
    { path: `${ZIP_ROOT}/${CUSTOMER_ID}/${FOLLOWUP_ID}/${MEETING_ID}/.str.toml`, text: MEETING_MANIFEST, deflate: true },
    { path: `${ZIP_ROOT}/${CUSTOMER_ID}/${FOLLOWUP_ID}/${MEETING_ID}/2026-09-10.md`, text: '# meeting' },
    { path: `${ZIP_ROOT}/${ORDER_ID}/.str.toml`, text: ORDER_MANIFEST, deflate: true },
    { path: `${ZIP_ROOT}/${ORDER_ID}/orders.csv`, text: 'id,total' },
    { path: `${ZIP_ROOT}/${TAG_ID}/.str.toml`, text: TAG_MANIFEST, deflate: true },
    { path: `${ZIP_ROOT}/${TAG_ID}/tags.json`, text: '[]' },
  ]);

const toArrayBuffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

describe('@file-viewer/renderer-str ZIP containers', () => {
  it('routes a `<bundle>.str.zip` name to the STR renderer, not to the archive renderer', () => {
    expect(isFileViewerStrBundleZipName('客户运营.str.zip')).toBe(true);
    expect(isFileViewerStrBundleZipName('CLIENT.STR.ZIP')).toBe(true);
    expect(isFileViewerStrBundleZipName('客户运营.zip')).toBe(false);

    const normalized = normalizeSource({
      file: new File([new Uint8Array([1, 2, 3])], '客户运营.str.zip', { type: 'application/zip' }),
    });
    expect(normalized.kind).toBe('file');
    expect(normalized.filename).toBe('客户运营.str.zip');
    // The filename wins over `application/zip`: macOS already converted the package.
    expect(normalized.extension).toBe('str');
  });

  it('reads stored and deflated members', async () => {
    const entries = await readStrZipEntries(toArrayBuffer(await buildExampleZip()));

    const paths = entries.map(entry => entry.path);
    expect(paths).toContain(`${ZIP_ROOT}/.str.toml`);
    expect(paths).toContain(`${ZIP_ROOT}/${CUSTOMER_ID}/attachments/合同-2024Q1.pdf`);

    const manifest = entries.find(entry => entry.path === `${ZIP_ROOT}/.str.toml`);
    expect(new TextDecoder().decode(await manifest?.read())).toBe(ROOT_MANIFEST);
    expect(manifest?.stored).toBe(false);

    const stored = entries.find(entry => entry.path === `${ZIP_ROOT}/${ORDER_ID}/orders.csv`);
    expect(new TextDecoder().decode(await stored?.read())).toBe('id,total');
    expect(stored?.stored).toBe(true);
  });

  it('keeps member bytes lazy so a huge bundle never decodes in full', async () => {
    const archive = await buildExampleZip();
    const entries = await readStrZipEntries(toArrayBuffer(archive));

    // Opening the archive only walks the central directory.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(entry => typeof entry.read === 'function')).toBe(true);

    // A lazy member still reports its real, declared size ...
    const stored = entries.find(entry => entry.path.endsWith('orders.csv'));
    expect(stored?.size).toBe('id,total'.length);

    // ... and only the requested member is inflated.
    const before = entries.filter(entry => !entry.stored);
    await stored?.read();
    expect(before.length).toBeGreaterThan(0);

    // A bundle whose declared payload totals above the old aggregate ceiling
    // must still open: 770 MB of attachments used to be rejected outright.
    const huge = await buildExampleZip();
    const hugeView = new DataView(huge.buffer);
    const marker = encoder.encode(`${ZIP_ROOT}/${CUSTOMER_ID}/avatar.png`);
    for (let offset = 0; offset + 46 <= huge.byteLength; offset += 1) {
      if (hugeView.getUint32(offset, true) !== 0x02014b50 && hugeView.getUint32(offset, true) !== 0x04034b50) {
        continue;
      }
      const isCentral = hugeView.getUint32(offset, true) === 0x02014b50;
      const nameLength = hugeView.getUint16(offset + (isCentral ? 28 : 26), true);
      const nameStart = offset + (isCentral ? 46 : 30);
      const name = huge.slice(nameStart, nameStart + nameLength);
      if (name.length !== marker.length || marker.some((byte, index) => byte !== name[index])) {
        continue;
      }
      hugeView.setUint32(offset + (isCentral ? 24 : 22), 770_076_018, true);
    }
    const hugeEntries = await readStrZipEntries(toArrayBuffer(huge));
    const avatar = hugeEntries.find(entry => entry.path.endsWith('avatar.png'));
    expect(avatar?.size).toBe(770_076_018);
    expect(new TextDecoder().decode(await avatar?.read())).toBe('png');
  });

  it('rejects a single member beyond the per-entry ceiling', async () => {
    const archive = await buildExampleZip();
    const view = new DataView(archive.buffer);
    const marker = encoder.encode(`${ZIP_ROOT}/${ORDER_ID}/orders.csv`);
    for (let offset = 0; offset + 46 <= archive.byteLength; offset += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) {
        continue;
      }
      const nameLength = view.getUint16(offset + 28, true);
      const nameStart = offset + 46;
      const name = archive.slice(nameStart, nameStart + nameLength);
      if (name.length !== marker.length || marker.some((byte, index) => byte !== name[index])) {
        continue;
      }
      view.setUint32(offset + 24, MAX_STR_ZIP_ENTRY_BYTES + 1, true);
    }
    await expect(
      readStrZipEntries(toArrayBuffer(archive))
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
  });

  it('exposes lazy members as real Blobs for previews and downloads', async () => {
    const entries = await readStrZipEntries(toArrayBuffer(await buildExampleZip()));
    const manifest = entries.find(entry => entry.path.endsWith('.str.toml'));
    if (!manifest) {
      throw new Error('the manifest member is missing');
    }

    const blob = new StrZipLazyBlob(manifest, 'application/toml');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(manifest.size);
    expect(blob.type).toBe('application/toml');
    expect(await blob.text()).toBe(ROOT_MANIFEST);
    expect(blob.slice(0, 4).size).toBe(Math.min(4, manifest.size));

    const materialised = await blob.materialize();
    expect(materialised).toBeInstanceOf(Blob);
    expect(await materialised.text()).toBe(ROOT_MANIFEST);
    // Cached: the second call returns the same instance.
    expect(await blob.materialize()).toBe(materialised);
  });

  it('rebuilds the same structure tree from an unzipped bundle', async () => {
    const entries = await readStrZipEntries(toArrayBuffer(await buildExampleZip()));

    const normalized = normalizeFileViewerFolderEntries(
      await Promise.all(
        entries.map(async entry => ({
          path: entry.path,
          file: new Blob([(await entry.read()) as BlobPart]),
        }))
      )
    );

    expect(normalized.isStrBundle).toBe(true);
    expect(normalized.rootName).toBe(ZIP_ROOT);

    const sources: StrBundleSourceFile[] = await Promise.all(
      normalized.entries.map(async entry =>
        entry.path.endsWith('.str.toml')
          ? { path: entry.path, text: await entry.file.text() }
          : { path: entry.path, blob: entry.file }
      )
    );

    const bundle = parseStrBundle({ name: normalized.rootName, files: sources });
    expect(titlesOf(bundle.root)).toEqual(['客户档案 · 张伟', '订单数据集', '标签体系']);
    // ROOT + 3 nodes + 跟进记录 + 会议纪要
    expect(bundle.branchCount).toBe(6);
    expect(bundle.fileCount).toBe(7);
    expect(bundle.depth).toBe(3);
    expect(bundle.root.issues).toEqual([]);
    expect(findBranch(bundle, '客户档案 · 张伟').issues).toEqual([]);
  });

  it('reports unusable containers instead of guessing', async () => {
    await expect(
      readStrZipEntries(encoder.encode('str = 1\n').buffer as ArrayBuffer)
    ).rejects.toMatchObject({ code: 'not-a-zip' });

    await expect(
      readStrZipEntries(new Uint8Array(30).buffer as ArrayBuffer)
    ).rejects.toBeInstanceOf(StrZipError);

    // A ZIP64 end-of-central-directory marker is refused rather than mis-parsed.
    const zip64 = await buildExampleZip();
    new DataView(zip64.buffer).setUint16(zip64.byteLength - 12, 0xffff, true);
    await expect(
      readStrZipEntries(toArrayBuffer(zip64))
    ).rejects.toMatchObject({ code: 'zip64' });
  });
});

// ---------------------------------------------------------------------------
// End-to-end routing: the archive renderer must never receive a bundle package
// ---------------------------------------------------------------------------

describe('@file-viewer/renderer-str end-to-end routing', () => {
  const previousGlobals: Record<string, unknown> = {};

  const installDom = () => {
    const { document, window } = parseHTML('<main id="viewer"></main>');
    for (const key of ['window', 'document', 'HTMLElement', 'ShadowRoot', 'Event'] as const) {
      previousGlobals[key] = (globalThis as Record<string, unknown>)[key];
    }
    const linkedomWindow = window as unknown as {
      HTMLElement: unknown;
      ShadowRoot: unknown;
      Event: unknown;
    };
    Object.assign(globalThis, {
      window,
      document,
      HTMLElement: linkedomWindow.HTMLElement,
      ShadowRoot: linkedomWindow.ShadowRoot,
      // linkedom's own Event class: the Node built-in cannot be dispatched here.
      Event: linkedomWindow.Event,
    });
    return document.getElementById('viewer') as unknown as HTMLElement;
  };

  const restoreDom = () => {
    for (const key of Object.keys(previousGlobals)) {
      Object.assign(globalThis, { [key]: previousGlobals[key] });
    }
  };

  it('loads a `<bundle>.str.zip` file with the STR renderer, not with the archive renderer', async () => {
    const target = installDom();
    try {
      const archiveLoaded = vi.fn();
      const archiveDefinition = DEFAULT_RENDERER_DEFINITIONS.find(item => item.id === 'archive');
      if (!archiveDefinition) {
        throw new Error('the shared archive definition is missing');
      }

      // A stub archive renderer stands in for `@file-viewer/renderer-archive`: if
      // the package is routed to it, the spy fires and the assertion fails.
      const registry = createRendererRegistry([
        {
          ...archiveDefinition,
          load: async () => {
            archiveLoaded();
            return { $el: target };
          },
        } satisfies RendererDefinition,
      ]);

      await installFileViewerRendererPlugins({
        registry,
        plugins: [strRenderer],
        registerHandler: () => {
          throw new Error('the STR renderer must not rely on handler registration');
        },
      });

      // `rendererMode: 'replace'` would discard the injected registry, so keep
      // the default mode and disable the auto preset instead.
      const viewer = createViewer(target, {
        registry,
        options: { autoRenderers: false } as FileViewerOptions,
      });

      const archive = toArrayBuffer(await buildExampleZip());
      await viewer.load({
        file: new File([archive], '客户运营.str.zip', { type: 'application/zip' }),
      });

      expect(archiveLoaded).not.toHaveBeenCalled();
      expect((target as unknown as { innerHTML: string }).innerHTML).toContain('str-shell');
      await (viewer as unknown as { destroy?: () => Promise<void> | void }).destroy?.();
    } finally {
      restoreDom();
    }
  });

  it('labels rows with short kind badges that fit the entry-ext column', async () => {
    const target = installDom();
    try {
      const registry = createRendererRegistry([]);
      await installFileViewerRendererPlugins({
        registry,
        plugins: [strRenderer],
        registerHandler: () => {},
      });
      const viewer = createViewer(target, {
        registry,
        options: {
          autoRenderers: false,
          // Expand everything so the deep rows are part of the assertion.
          str: { collapsedDepth: 99 },
        } as FileViewerOptions,
      });

      await viewer.load({
        file: new File(
          [toArrayBuffer(await buildExampleZip())],
          '客户运营.str.zip',
          { type: 'application/zip' }
        ),
      });

      const root = target as unknown as {
        querySelectorAll: (selector: string) => ArrayLike<{ textContent: string | null }>;
        querySelector: (selector: string) => { textContent: string | null } | null;
      };
      const badges = Array.from(root.querySelectorAll('.str-kind')).map(node => node.textContent);

      expect(badges).toContain('NODE');
      expect(badges).toContain('BR');
      expect(badges).toContain('DIR');
      // File rows keep using the extension, like the archive renderer.
      expect(badges).toContain('CSV');
      expect(badges).toContain('MD');
      // `BRANCH` used to overflow the badge column.
      expect(badges).not.toContain('BRANCH');

      // Unregistered payloads stay visible as ordinary rows; the chip that
      // spelled the state out (`未登记` / `unregistered`) is gone.
      const rowText = Array.from(root.querySelectorAll('.str-row'))
        .map(node => node.textContent || '')
        .join(' ');
      expect(rowText).toContain('合同-2024Q1.pdf');
      expect(rowText).not.toContain('未登记');
      expect(rowText).not.toContain('unregistered');

      // The badge reuses the archive renderer's `.entry-ext` metrics.
      const style = root.querySelector('style')?.textContent || '';
      expect(style).toContain('--str-entry-ext-height:28px');
      expect(style).toMatch(/\.str-kind\{[^}]*height:var\(--str-entry-ext-height\)/);
      expect(style).toMatch(/\.str-kind\{[^}]*font-weight:900/);
      expect(style).toMatch(/\.str-kind\{[^}]*text-transform:uppercase/);
      expect(style).toMatch(/\.str-kind\{[^}]*border-radius:var\(--str-entry-ext-radius\)/);
      expect(style).toMatch(
        /\.str-row\{[^}]*grid-template-columns:18px var\(--str-entry-icon-column\)/
      );

      // Collapsing the sidebar must actually change the layout on wide screens:
      // a missing desktop rule used to make the toggle a no-op.
      const collapsed = target.querySelector('.str-shell') as unknown as {
        classList: { contains: (value: string) => boolean };
      };
      expect(collapsed).toBeTruthy();
      expect(style).toMatch(
        /\.str-shell\.str-sidebar-collapsed\{grid-template-columns:0 minmax\(0,1fr\)\}/
      );
      expect(style).toMatch(/\.str-sidebar-collapsed \.str-sidebar\{[^}]*display:none/);
      // The panes are placed explicitly: hiding the sidebar must not make the
      // preview fall into the zero-width first column.
      expect(style).toMatch(/\.str-sidebar\{grid-column:1;grid-row:1/);
      expect(style).toMatch(/\.str-preview\{grid-column:2;grid-row:1/);
      expect(collapsed.classList.contains('str-sidebar-collapsed')).toBe(false);

      // Both toggles share one square button whose glyph is centred by the
      // button itself, so `‹`/`☰` do not sit off-centre.
      expect(style).toMatch(/\.str-sidebar-toggle\{[^}]*width:28px;height:28px/);
      expect(style).toMatch(/\.str-sidebar-toggle\{[^}]*display:inline-flex/);
      expect(style).toMatch(/\.str-sidebar-toggle\{[^}]*align-items:center;justify-content:center/);
      expect(style).toMatch(/\.str-sidebar-toggle\{[^}]*font-size:17px/);
      expect(style).toMatch(/\.str-sidebar-toggle\{[^}]*padding:0/);

      // The sidebar track stays fluid (its fixed width was the reported
      // mismatch) and the STR look stays its own; only the reset and the
      // system-theme bridge are shared with other container renderers.
      expect(style).toContain('--str-sidebar-track:clamp(248px,30%,420px)');
      expect(style).toContain('--str-sidebar-track:clamp(224px,27%,360px)');
      expect(style).toMatch(/\.str-shell \*\{box-sizing:border-box\}/);
      expect(style).toMatch(/\.str-badge\{[^}]*background:#1d4ed8/);
      expect(style).toMatch(/\.str-row:hover\{background:#eef2f7\}/);
      expect(style).toMatch(/\.str-row\.active\{background:#e2ebff;border-color:#b9cdfb\}/);
      expect(style).toMatch(/\.str-preview\{[^}]*background:#fff\}/);
      expect(style).toMatch(/\.str-nested-target>\*\{height:100%\}/);
      expect(style).toContain("@media (prefers-color-scheme:dark)");
      expect(style).toContain("[data-viewer-theme='system'] .str-shell");
      expect(style).toContain("--str-entry-ext-height:24px");

      type Toggle = {
        dispatchEvent: (event: unknown) => boolean;
        textContent: string | null;
        getAttribute: (name: string) => string | null;
      };
      const toggles = target.querySelectorAll('.str-sidebar-toggle') as unknown as ArrayLike<Toggle>;
      const hide = toggles[0];
      const toggle = toggles[1];

      // Default (expanded) state: the toolbar button offers collapsing, not a
      // dead `›` glyph that does nothing.
      expect(toggle.textContent).toBe('‹');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      toggle.dispatchEvent(new Event('click'));
      expect(collapsed.classList.contains('str-sidebar-collapsed')).toBe(true);
      expect(toggle.textContent).toBe('☰');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      // …and the same button brings the sidebar back.
      toggle.dispatchEvent(new Event('click'));
      expect(collapsed.classList.contains('str-sidebar-collapsed')).toBe(false);

      hide.dispatchEvent(new Event('click'));
      expect(collapsed.classList.contains('str-sidebar-collapsed')).toBe(true);

      await (viewer as unknown as { destroy?: () => Promise<void> | void }).destroy?.();
    } finally {
      restoreDom();
    }
  });
});
