// Minimal ZIP reader for STR bundles.
//
// macOS delivers a bundle package to a file input as a ZIP archive named
// `<bundle>.str.zip`, so the renderer has to open the container before it can
// read any `.str.toml` manifest.
//
// Members are **lazy**: opening an archive only walks the central directory, and
// payload bytes are inflated on first access. A real bundle can hold hundreds of
// megabytes of attachments, while the structure tree only needs the manifests -
// inflating everything up front would exhaust memory for no benefit.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Maximum members read from one archive. */
export const MAX_STR_ZIP_ENTRIES = 20000;
/** Per-member uncompressed ceiling, enforced from the central directory. */
export const MAX_STR_ZIP_ENTRY_BYTES = 1024 * 1024 * 1024;

export type StrZipErrorCode =
  | 'not-a-zip'
  | 'zip64'
  | 'encrypted'
  | 'unsupported-compression'
  | 'decompression-unavailable'
  | 'corrupt-entry'
  | 'limit-exceeded';

export class StrZipError extends Error {
  readonly code: StrZipErrorCode;

  constructor(code: StrZipErrorCode, message: string) {
    super(message);
    this.name = 'StrZipError';
    this.code = code;
  }
}

export interface StrZipEntry {
  /** Archive-relative path using `/` separators. */
  path: string;
  /** Uncompressed size declared by the central directory. */
  size: number;
  /** Compressed size declared by the central directory. */
  compressedSize: number;
  /** `0` for stored, `8` for deflate. */
  method: number;
  /** True when the payload is stored verbatim. */
  stored: boolean;
  /** Inflates this member on demand. The result is cached. */
  read: () => Promise<Uint8Array>;
}

const readUint16 = (view: DataView, offset: number) => view.getUint16(offset, true);
const readUint32 = (view: DataView, offset: number) => view.getUint32(offset, true);

const findEndOfCentralDirectory = (view: DataView, length: number) => {
  // The comment can be up to 64 KiB, so the record starts within that window.
  const minimum = Math.max(0, length - (0xffff + 22));
  for (let offset = length - 22; offset >= minimum; offset -= 1) {
    if (readUint32(view, offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
};

const inflateRaw = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const Decompressor = (globalThis as { DecompressionStream?: new (format: string) => unknown })
    .DecompressionStream;
  if (!Decompressor) {
    throw new StrZipError(
      'decompression-unavailable',
      'DecompressionStream is not available in this environment.'
    );
  }

  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new Decompressor('deflate-raw') as ReadableWritablePair<Uint8Array, Uint8Array>
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * Reads the member directory of a ZIP archive.
 *
 * Directory entries are skipped: the STR tree is rebuilt from `.str.toml`
 * manifests, so empty folders carry no information.
 */
export const readStrZipEntries = async (buffer: ArrayBuffer): Promise<StrZipEntry[]> => {
  if (buffer.byteLength < 22) {
    throw new StrZipError('not-a-zip', 'The archive is too small to be a ZIP container.');
  }

  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view, buffer.byteLength);
  if (eocd < 0) {
    throw new StrZipError('not-a-zip', 'No ZIP end-of-central-directory record was found.');
  }

  const entryCount = readUint16(view, eocd + 10);
  const directorySize = readUint32(view, eocd + 12);
  const directoryOffset = readUint32(view, eocd + 16);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new StrZipError('zip64', 'ZIP64 archives are not supported.');
  }
  if (entryCount > MAX_STR_ZIP_ENTRIES) {
    throw new StrZipError('limit-exceeded', `The archive declares ${entryCount} entries.`);
  }
  if (directoryOffset + directorySize > buffer.byteLength) {
    throw new StrZipError('corrupt-entry', 'The central directory is outside the archive.');
  }

  const bytes = new Uint8Array(buffer);
  const entries: StrZipEntry[] = [];
  let cursor = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.byteLength || readUint32(view, cursor) !== CENTRAL_SIGNATURE) {
      throw new StrZipError('corrupt-entry', `Central directory record ${index} is malformed.`);
    }

    const flags = readUint16(view, cursor + 8);
    const method = readUint16(view, cursor + 10);
    const compressedSize = readUint32(view, cursor + 20);
    const uncompressedSize = readUint32(view, cursor + 24);
    const nameLength = readUint16(view, cursor + 28);
    const extraLength = readUint16(view, cursor + 30);
    const commentLength = readUint16(view, cursor + 32);
    const localOffset = readUint32(view, cursor + 42);

    const nameStart = cursor + 46;
    const path = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    cursor = nameStart + nameLength + extraLength + commentLength;

    if (!path || path.endsWith('/')) {
      continue;
    }
    if (flags & 0x1) {
      throw new StrZipError('encrypted', `${path} is encrypted.`);
    }
    if (method !== 0 && method !== 8) {
      throw new StrZipError(
        'unsupported-compression',
        `${path} uses compression method ${method}; only stored and deflate are supported.`
      );
    }
    if (uncompressedSize > MAX_STR_ZIP_ENTRY_BYTES) {
      throw new StrZipError(
        'limit-exceeded',
        `${path} declares ${uncompressedSize} uncompressed bytes.`
      );
    }
    if (localOffset + 30 > buffer.byteLength || readUint32(view, localOffset) !== LOCAL_SIGNATURE) {
      throw new StrZipError('corrupt-entry', `The local header for ${path} is malformed.`);
    }

    // The local header owns its own extra-field length, which may differ.
    const localNameLength = readUint16(view, localOffset + 26);
    const localExtraLength = readUint16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.byteLength) {
      throw new StrZipError('corrupt-entry', `The data for ${path} is truncated.`);
    }

    const payload = bytes.subarray(dataStart, dataStart + compressedSize);
    let cached: Uint8Array | null = null;
    entries.push({
      path,
      size: uncompressedSize,
      compressedSize,
      method,
      stored: method === 0,
      read: async () => {
        if (cached) {
          return cached;
        }
        cached = method === 0 ? payload.slice() : await inflateRaw(payload);
        return cached;
      },
    });
  }

  return entries;
};

/**
 * A `Blob` over a lazy ZIP member.
 *
 * The STR renderer only ever converts preview payloads to an `ArrayBuffer` (and
 * materialises a real `Blob` for downloads), so the archive is never inflated
 * just to build the tree.
 */
export class StrZipLazyBlob extends Blob {
  private readonly entryRef: StrZipEntry;
  private readonly declaredType: string;
  private materialised: Blob | null = null;

  constructor(entry: StrZipEntry, type = '') {
    super([]);
    this.entryRef = entry;
    this.declaredType = type;
  }

  override get size(): number {
    return this.entryRef.size;
  }

  override get type(): string {
    return this.declaredType;
  }

  /** Inflated bytes without building a `Blob`. */
  readBytes(): Promise<Uint8Array> {
    return this.entryRef.read();
  }

  /** A real `Blob`, required by `URL.createObjectURL`. */
  async materialize(): Promise<Blob> {
    if (!this.materialised) {
      const value = await this.entryRef.read();
      this.materialised = this.declaredType
        ? new Blob([value as BlobPart], { type: this.declaredType })
        : new Blob([value as BlobPart]);
    }
    return this.materialised;
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    const value = await this.entryRef.read();
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }

  override async text(): Promise<string> {
    return new TextDecoder().decode(await this.entryRef.read());
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const entryRef = this.entryRef;
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      async start(controller) {
        try {
          controller.enqueue((await entryRef.read()) as Uint8Array<ArrayBuffer>);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    const from = start ?? 0;
    const to = end ?? this.entryRef.size;
    if (from === 0 && to === this.entryRef.size) {
      return this;
    }
    const entryRef = this.entryRef;
    return new StrZipLazyBlob(
      {
        ...entryRef,
        size: Math.max(0, to - from),
        read: async () => (await entryRef.read()).slice(from, to),
      },
      contentType ?? this.declaredType
    );
  }
}
