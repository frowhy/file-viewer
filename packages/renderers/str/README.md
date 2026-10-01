# @file-viewer/renderer-str

STR (`.str`) 数据束渲染器插件：把 STR bundle 按 **结构树** 展示，并让每个文件继续走 File Viewer 已有的预览渲染器。

- 读取各级 `.str.toml` 清单，还原 `root → node → branch` 层级、内容条目（`payload` / `asset` / `dir` / `bundle`）、软连接与硬链接挂载、跨枝关联（`refs`）以及清单漂移。
- 点击任意文件时，把字节交给当前实例已安装的渲染器（`preset` / `presets` / `renderers`），因此 `.png`、`.csv`、`.md`、`.pdf`、`.xlsx` 等全部复用既有预览。
- 无外部运行时资源、无 Worker、无 WASM。

> STR 规范见 `SPEC.md`（STR 1.x）。自 v1.17.0 起保留名使用 `.str.` 前缀，元数据文件固定为 `.str.toml`。

## 关键约束：`.str` 是目录

STR bundle 是**目录**而不是单文件容器（规范 §2.2 明确不做二进制打包）。浏览器无法把真实目录交给渲染器，因此必须通过**目录源**提供：

```ts
// 1) 文件夹选择器 / 目录拖拽：File 自带 webkitRelativePath
input.addEventListener('change', () => {
  viewer.load({ files: [...input.files] })
})

// 2) 显式路径（例如从内存或远程目录接口重建）
viewer.load({
  files: [
    { path: '客户运营.str/.str.toml', file: rootManifestBlob },
    { path: '客户运营.str/<uuid>/profile.json', file: profileBlob }
  ]
})

// 3) 挂载时无法拿到目录，也可以走 options
mountViewer(el, {
  files: folderFiles,
  options: { str: { files: folderFiles } },
  filename: '客户运营.str'
})
```

`@file-viewer/core` 会把目录源的公共首层目录当作 bundle 根：`filename` 默认为该根目录名，并在根名以 `.str` 结尾（或根目录存在 `.str.toml`）时把扩展名判定为 `str`，从而路由到本渲染器。条目路径在进入渲染器前已经是**相对 bundle 根**的路径。

## macOS：`.str` 的三种交付形态

`str reveal` 会执行 `SetFile -a B`，让 Finder 把 `.str` 目录当成一个文件（包）。包位一置，浏览器能拿到什么取决于入口：

| 入口 | macOS 交付 | 本渲染器行为 |
| --- | --- | --- |
| 文件选择器（`<input type=file>`，`accept` 含 `.str`） | 包被**即时压缩**为 `<bundle>.str.zip`（`客户运营.str` → `客户运营.str.zip`） | 该名字被判定为 STR 数据束并**在内存解压**（stored / deflate），直接出结构树 |
| 文件夹选择器（`webkitdirectory`） | 无法进入该包 | 需走下面的替代路径 |
| 拖放 | 一个 **0 字节**条目 | 报出专用提示，而不是空白 |

入口拿不到内容时仍有两条路：

1. **取消包位**：`SetFile -a b 客户运营.str`（需 Xcode Command Line Tools；`str reveal` 用的是大写 `-a B`）；
2. **传入包内内容**：Finder 右键「显示包内容」，把里面的内容（**必须含根目录 `.str.toml`**）一起拖入或选中，或经 `source.files` / `options.str.files` 传入——渲染器凭根处 `.str.toml` 认出格式，bundle 名回退 `bundle.str`。

普通 `.zip`（名字不以 `.str.zip` 结尾）仍归压缩包渲染器。`options.str.files` 与 `source.files` 走同一套归一化（自动识别并以 `<name>.str` 为根剥离前缀）。

## 安装

```bash
npm install @file-viewer/renderer-str
```

`@file-viewer/preset-all` 已包含本渲染器；轻量组件请显式传入：

```ts
import { strRenderer } from '@file-viewer/renderer-str'
import { FileViewer } from '@file-viewer/vue3'

const options = { preset: officePreset, renderers: [strRenderer] }
```

### 选项

```ts
import type { FileViewerStrOptions } from '@file-viewer/core'

const str: FileViewerStrOptions = {
  files: folderFiles,          // FileViewerSource.files 缺省时的显式目录源
  initialPath: 'profile.json', // 首屏选中的 bundle 相对路径
  collapsedDepth: 2            // 深度 ≥ 该值的分支默认折叠
}
```

## 编程式解析

解析模型是纯同步的，可以直接复用：

```ts
import { parseStrBundle, parseStrBranchMeta, flattenStrBundle } from '@file-viewer/renderer-str'

const bundle = parseStrBundle({
  name: '客户运营.str',
  files: [
    { path: '.str.toml', text: rootToml },
    { path: '<uuid>/.str.toml', text: branchToml },
    { path: '<uuid>/orders.csv', blob: csvBlob }
  ]
})

bundle.branchCount      // 分支数
bundle.root.rows        // 结构树（顺序与 entries[].order 一致）
flattenStrBundle(bundle) // 平铺后的行列表，便于搜索/键盘导航
```

`parseStrBundle` 只对 `.str.toml` 要求解码后的文本，其余条目保留原始 `Blob`，预览时按需读取。

## 已知限制

- 需要目录源；单个 `File` / URL / `ArrayBuffer` 无法承载 bundle（此时渲染器会给出明确的引导状态而不是空白）。
- 结构树按清单映射，**不修改** bundle：清单漂移、未登记文件、缺失 `.str.toml`、挂载成环都以问题标记呈现。
- 软连接按目标分支展开（按身份去重，环会被截断）；硬链接展示目标的内容条目且只读。
- 不实现完整规范校验（`E_*` / `W_*` 全量检查由 `str validate` 负责）。
- 打开 `.str.zip` 时只遍历成员目录并解开各级 `.str.toml`，payload 保持压缩、到预览或下载时才解压；因此数百 MB 的数据束也能直接出结构树（单个成员超过 1 GiB、ZIP64、加密包会带原因拒绝）。

## 许可

Apache-2.0。
