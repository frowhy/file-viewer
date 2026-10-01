# @file-viewer/renderer-str

STR (`.str`) bundle renderer plugin: shows a STR bundle as a **structure tree** and keeps every file preview on the renderers File Viewer already installed.

- Reads each `.str.toml` manifest and rebuilds the `root → node → branch` hierarchy, content entries (`payload` / `asset` / `dir` / `bundle`), soft and hard mounts, cross-branch `refs`, and manifest drift.
- Selecting a file hands its bytes to the renderers already installed on the instance (`preset` / `presets` / `renderers`), so `.png`, `.csv`, `.md`, `.pdf`, `.xlsx` and the rest reuse the existing previews.
- No runtime assets, no Worker, no WASM.

> The STR specification lives in `SPEC.md` (STR 1.x). Since v1.17.0 the reserved prefix is `.str.` and the manifest file is always `.str.toml`.

## The core constraint: a `.str` is a directory

A STR bundle is a **directory**, not a single-file container (SPEC §2.2 explicitly avoids binary packaging). A browser cannot hand a renderer a real directory, so the source must be a **directory source**:

```ts
// 1) Folder picker / directory drag-and-drop: File carries webkitRelativePath
input.addEventListener('change', () => {
  viewer.load({ files: [...input.files] })
})

// 2) Explicit paths (rebuilt in memory or from a remote directory API)
viewer.load({
  files: [
    { path: 'crm.str/.str.toml', file: rootManifestBlob },
    { path: 'crm.str/<uuid>/profile.json', file: profileBlob }
  ]
})

// 3) No directory at mount time? Use the option instead
mountViewer(el, {
  files: folderFiles,
  options: { str: { files: folderFiles } },
  filename: 'crm.str'
})
```

`@file-viewer/core` treats the shared leading directory of a folder source as the bundle root: `filename` defaults to that root name, and the extension becomes `str` when the root ends with `.str` or a `.str.toml` sits at the root, which is what routes to this renderer. Entry paths reach the renderer already relative to the bundle root.

## macOS: the three ways a `.str` arrives

`str reveal` runs `SetFile -a B`, which makes Finder treat the `.str` directory as a single file (a package). Once that bit is set, what the browser receives depends on the entry point:

| Entry point | What macOS delivers | What this renderer does |
| --- | --- | --- |
| File input (`<input type=file>` with `.str` in `accept`) | The package is **compressed on the fly** into `<bundle>.str.zip` (`crm.str` → `crm.str.zip`) | That name is recognised as a STR bundle and **unpacked in memory** (stored / deflate), producing the structure tree |
| Folder input (`webkitdirectory`) | The package cannot be entered | Use one of the fallbacks below |
| Drag-and-drop | A single **zero-byte** entry | A dedicated notice instead of an empty pane |

When an entry point yields no content, two fallbacks remain:

1. **Clear the bundle bit**: `SetFile -a b crm.str` (requires the Xcode Command Line Tools; `str reveal` sets it with the uppercase `-a B`);
2. **Hand over the bundle contents**: use "Show Package Contents" in Finder and drop or select everything inside (the bundle root must include its `.str.toml`), or pass those files through `source.files` / `options.str.files`. The renderer identifies the bundle from that root manifest and falls back to the name `bundle.str`.

A plain `.zip` (a name that does not end with `.str.zip`) still belongs to the archive renderer. `options.str.files` applies the same normalisation as `source.files` (it detects and strips a `<name>.str` root).

## Install

```bash
npm install @file-viewer/renderer-str
```

`@file-viewer/preset-all` already ships it; light components pass it explicitly:

```ts
import { strRenderer } from '@file-viewer/renderer-str'
import { FileViewer } from '@file-viewer/vue3'

const options = { preset: officePreset, renderers: [strRenderer] }
```

### Options

```ts
import type { FileViewerStrOptions } from '@file-viewer/core'

const str: FileViewerStrOptions = {
  files: folderFiles,          // explicit directory source when FileViewerSource.files is absent
  initialPath: 'profile.json', // bundle-relative path selected on first paint
  collapsedDepth: 2            // branches at or below this depth start collapsed
}
```

## Programmatic parsing

The model is synchronous and pure, so it can be reused directly:

```ts
import { parseStrBundle, parseStrBranchMeta, flattenStrBundle } from '@file-viewer/renderer-str'

const bundle = parseStrBundle({
  name: 'crm.str',
  files: [
    { path: '.str.toml', text: rootToml },
    { path: '<uuid>/.str.toml', text: branchToml },
    { path: '<uuid>/orders.csv', blob: csvBlob }
  ]
})

bundle.branchCount       // number of branches
bundle.root.rows         // structure tree, ordered by entries[].order
flattenStrBundle(bundle)  // flat row list for search and keyboard navigation
```

Only `.str.toml` entries need decoded text; every other entry keeps its `Blob` so previews stream from the original handle.

## Known limits

- A directory source is required; a single `File` / URL / `ArrayBuffer` cannot carry a bundle (the renderer shows an explicit guidance state instead of an empty pane).
- The tree is a manifest projection and never mutates the bundle: manifest drift, unregistered files, missing `.str.toml` and mount cycles are surfaced as issues.
- Soft links expand through the target branch (deduplicated by identity, cycles truncated); hard links show the target's content rows read-only.
- Full specification validation (`E_*` / `W_*`) stays with the `str validate` CLI.
- Opening a `.str.zip` only walks the member directory and inflates the `.str.toml` manifests; payload bytes stay compressed until a preview or download, so a bundle holding hundreds of megabytes still renders its tree (a single member above 1 GiB, ZIP64 and encrypted archives are rejected with the reason).

## License

Apache-2.0.
