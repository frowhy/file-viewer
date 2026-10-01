// Minimal TOML reader for STR manifests (`.str.toml`).
//
// It intentionally covers the subset the STR specification relies on rather
// than the whole TOML 1.0 surface: line comments, bare / quoted / dotted keys,
// basic and literal strings (single-line and multi-line), integers, floats,
// booleans, offset date-times, arrays, inline tables, `[table]` headers and
// `[[array-of-tables]]` headers.
//
// Offset date-times are returned as their raw source text because STR only ever
// displays them. Unsupported constructs fail loudly through `TomlParseError`
// instead of being silently misread.

export type TomlPrimitive = string | number | boolean

export type TomlValue = TomlPrimitive | TomlValue[] | TomlTable

export interface TomlTable {
  [key: string]: TomlValue
}

export class TomlParseError extends Error {
  readonly offset: number

  constructor(message: string, offset: number) {
    super(`${message} (at offset ${offset})`)
    this.name = 'TomlParseError';
    this.offset = offset;
  }
}

const KEY_BARE_PATTERN = /[A-Za-z0-9_-]/;
const HEX_PATTERN = /^[0-9A-Fa-f]+$/;
const DECIMAL_PATTERN = /^[+-]?(\d+)(\.\d+)?([eE][+-]?\d+)?$/;
const RADIX_PATTERN = /^([+-]?)(0[xob])([0-9A-Fa-f]+)$/;

const parseTomlNumber = (raw: string): number | undefined => {
  const value = raw.replace(/_/g, '');
  const radix = RADIX_PATTERN.exec(value);
  if (radix) {
    const sign = radix[1] === '-' ? -1 : 1;
    const base = radix[2] === '0x' ? 16 : radix[2] === '0o' ? 8 : 2;
    const digits = base === 2 ? radix[3].replace(/[^01]/g, '') : radix[3];
    const parsed = Number.parseInt(digits, base);
    return Number.isNaN(parsed) ? undefined : sign * parsed;
  }
  if (/^[+-]?inf$/.test(value)) {
    return value.startsWith('-') ? -Infinity : Infinity;
  }
  if (/^[+-]?nan$/.test(value)) {
    return Number.NaN;
  }
  if (DECIMAL_PATTERN.test(value)) {
    return Number(value);
  }
  return undefined;
};

const setTableValue = (target: TomlTable, path: readonly string[], value: TomlValue) => {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    const existing = cursor[key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      const created: TomlTable = {};
      cursor[key] = created;
      cursor = created;
      continue;
    }
    cursor = existing as TomlTable;
  }
  cursor[path[path.length - 1]] = value;
};

class TomlScanner {
  index = 0;

  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  get eof() {
    return this.index >= this.source.length;
  }

  private readonly table: TomlTable = {};

  peek(offset = 0) {
    return this.source[this.index + offset] ?? '';
  }

  next() {
    return this.source[this.index++] ?? '';
  }

  fail(message: string): never {
    throw new TomlParseError(message, this.index);
  }

  skipSpaces() {
    while (this.peek() === ' ' || this.peek() === '\t') {
      this.index += 1;
    }
  }

  skipComment() {
    if (this.peek() !== '#') {
      return;
    }
    while (!this.eof && this.peek() !== '\n') {
      this.index += 1;
    }
  }

  skipLineBreaks() {
    for (;;) {
      const ch = this.peek();
      if (ch === '\n') {
        this.index += 1;
        continue;
      }
      if (ch === '\r' && this.peek(1) === '\n') {
        this.index += 2;
        continue;
      }
      break;
    }
  }

  /** Skips whitespace, comments and line breaks (all legal inside arrays). */
  skipTrivia() {
    for (;;) {
      const before = this.index;
      this.skipSpaces();
      this.skipComment();
      this.skipLineBreaks();
      if (this.index === before) {
        return;
      }
    }
  }

  expect(char: string) {
    if (this.peek() !== char) {
      this.fail(`expected \`${char}\``);
    }
    this.index += 1;
  }

  readKeyPath(): string[] {
    const segments: string[] = [];
    for (;;) {
      this.skipSpaces();
      segments.push(this.readKeySegment());
      this.skipSpaces();
      if (this.peek() !== '.') {
        return segments;
      }
      this.index += 1;
    }
  }

  readKeySegment(): string {
    const ch = this.peek();
    if (ch === '"') {
      return this.readBasicString(false);
    }
    if (ch === '\'') {
      return this.readLiteralString(false);
    }
    let value = '';
    while (!this.eof && KEY_BARE_PATTERN.test(this.peek())) {
      value += this.next();
    }
    if (!value) {
      this.fail('expected a TOML key');
    }
    return value;
  }

  readValue(): TomlValue {
    const ch = this.peek();
    if (ch === '"') {
      return this.peek(1) === '"' && this.peek(2) === '"'
        ? this.readBasicString(true)
        : this.readBasicString(false);
    }
    if (ch === '\'') {
      return this.peek(1) === '\'' && this.peek(2) === '\''
        ? this.readLiteralString(true)
        : this.readLiteralString(false);
    }
    if (ch === '[') {
      return this.readArray();
    }
    if (ch === '{') {
      return this.readInlineTable();
    }
    return this.readBareValue();
  }

  readBasicString(multiline: boolean): string {
    let value = '';
    if (multiline) {
      this.index += 3;
      if (this.peek() === '\r' && this.peek(1) === '\n') {
        this.index += 2;
      } else if (this.peek() === '\n') {
        this.index += 1;
      }
      for (;;) {
        if (this.eof) {
          this.fail('unterminated multi-line basic string');
        }
        if (this.peek() === '"' && this.peek(1) === '"' && this.peek(2) === '"') {
          this.index += 3;
          return value;
        }
        const ch = this.next();
        if (ch === '\\') {
          if (this.peek() === '\n' || this.peek() === '\r') {
            this.skipLineBreaks();
            this.skipSpaces();
            while (this.peek() === '\n' || this.peek() === '\r') {
              this.skipLineBreaks();
              this.skipSpaces();
            }
            continue;
          }
          value += this.readEscape();
          continue;
        }
        value += ch;
      }
    }

    this.index += 1;
    for (;;) {
      if (this.eof) {
        this.fail('unterminated basic string');
      }
      const ch = this.next();
      if (ch === '"') {
        return value;
      }
      if (ch === '\n') {
        this.fail('newline inside a single-line basic string');
      }
      if (ch === '\\') {
        value += this.readEscape();
        continue;
      }
      value += ch;
    }
  }

  readLiteralString(multiline: boolean): string {
    let value = '';
    if (multiline) {
      this.index += 3;
      if (this.peek() === '\r' && this.peek(1) === '\n') {
        this.index += 2;
      } else if (this.peek() === '\n') {
        this.index += 1;
      }
      for (;;) {
        if (this.eof) {
          this.fail('unterminated multi-line literal string');
        }
        if (this.peek() === '\'' && this.peek(1) === '\'' && this.peek(2) === '\'') {
          this.index += 3;
          return value;
        }
        value += this.next();
      }
    }

    this.index += 1;
    for (;;) {
      if (this.eof) {
        this.fail('unterminated literal string');
      }
      const ch = this.next();
      if (ch === '\'') {
        return value;
      }
      if (ch === '\n') {
        this.fail('newline inside a single-line literal string');
      }
      value += ch;
    }
  }

  readEscape(): string {
    const ch = this.next();
    switch (ch) {
      case 'b': return '\b';
      case 't': return '\t';
      case 'n': return '\n';
      case 'f': return '\f';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      case 'u': return this.readUnicodeEscape(4);
      case 'U': return this.readUnicodeEscape(8);
      default: return this.fail(`unsupported escape sequence \\${ch}`);
    }
  }

  readUnicodeEscape(length: number): string {
    let hex = '';
    for (let index = 0; index < length; index += 1) {
      const ch = this.next();
      if (!HEX_PATTERN.test(ch)) {
        this.fail('invalid unicode escape');
      }
      hex += ch;
    }
    const codePoint = Number.parseInt(hex, 16);
    if (!Number.isFinite(codePoint) || codePoint > 0x10FFFF) {
      this.fail('unicode escape out of range');
    }
    return String.fromCodePoint(codePoint);
  }

  readArray(): TomlValue[] {
    this.index += 1;
    const items: TomlValue[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.peek() === ']') {
        this.index += 1;
        return items;
      }
      if (this.eof) {
        this.fail('unterminated array');
      }
      items.push(this.readValue());
      this.skipTrivia();
      if (this.peek() === ',') {
        this.index += 1;
        continue;
      }
      if (this.peek() === ']') {
        this.index += 1;
        return items;
      }
      this.fail('expected `,` or `]` inside an array');
    }
  }

  readInlineTable(): TomlTable {
    this.index += 1;
    const table: TomlTable = {};
    this.skipSpaces();
    if (this.peek() === '}') {
      this.index += 1;
      return table;
    }
    for (;;) {
      this.skipSpaces();
      const path = this.readKeyPath();
      this.skipSpaces();
      this.expect('=');
      this.skipSpaces();
      setTableValue(table, path, this.readValue());
      this.skipSpaces();
      if (this.peek() === ',') {
        this.index += 1;
        continue;
      }
      this.expect('}');
      return table;
    }
  }

  readBareValue(): TomlValue {
    const start = this.index;
    while (!this.eof) {
      const ch = this.peek();
      if (ch === '\n' || ch === '\r' || ch === ',' || ch === ']' || ch === '}' || ch === '#') {
        break;
      }
      this.index += 1;
    }
    const raw = this.source.slice(start, this.index).trim();
    if (!raw) {
      this.fail('expected a TOML value');
    }
    if (raw === 'true') {
      return true;
    }
    if (raw === 'false') {
      return false;
    }
    const numeric = parseTomlNumber(raw);
    return numeric === undefined ? raw : numeric;
  }

  /** Resolves `[a.b]` to its table, creating missing intermediate tables. */
  ensureTable(path: readonly string[]): TomlTable {
    let cursor = this.table;
    for (const key of path) {
      const existing = cursor[key];
      if (Array.isArray(existing)) {
        const last = existing[existing.length - 1];
        if (!last || typeof last !== 'object' || Array.isArray(last)) {
          this.fail(`\`${key}\` is not a table`);
        }
        cursor = last as TomlTable;
        continue;
      }
      if (existing && typeof existing === 'object') {
        cursor = existing as TomlTable;
        continue;
      }
      const created: TomlTable = {};
      cursor[key] = created;
      cursor = created;
    }
    return cursor;
  }

  /** Resolves `[[a.b]]` and appends a fresh table to the array. */
  pushArrayTable(path: readonly string[]): TomlTable {
    const parent = this.ensureTable(path.slice(0, -1));
    const key = path[path.length - 1];
    const existing = parent[key];
    const created: TomlTable = {};
    if (existing === undefined) {
      parent[key] = [created];
      return created;
    }
    if (!Array.isArray(existing)) {
      this.fail(`\`${key}\` is not an array of tables`);
    }
    existing.push(created);
    return created;
  }

  run(): TomlTable {
    let current = this.table;
    for (;;) {
      this.skipTrivia();
      if (this.eof) {
        return this.table;
      }

      if (this.peek() === '[') {
        this.index += 1;
        const isArrayTable = this.peek() === '[';
        if (isArrayTable) {
          this.index += 1;
        }
        this.skipSpaces();
        const path = this.readKeyPath();
        this.skipSpaces();
        this.expect(']');
        if (isArrayTable) {
          this.expect(']');
        }
        current = isArrayTable ? this.pushArrayTable(path) : this.ensureTable(path);
        continue;
      }

      const path = this.readKeyPath();
      this.skipSpaces();
      this.expect('=');
      this.skipSpaces();
      const value = this.readValue();
      setTableValue(current, path, value);
    }
  }
}

/** Parses a `.str.toml` document into a plain object tree. */
export const parseToml = (source: string): TomlTable => {
  return new TomlScanner(String(source ?? '').replace(/^\uFEFF/, '')).run();
};

export const isTomlTable = (value: TomlValue | undefined): value is TomlTable =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const readTomlString = (value: TomlValue | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

export const readTomlNumber = (value: TomlValue | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const readTomlStringArray = (value: TomlValue | undefined): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
};

export const readTomlTableArray = (value: TomlValue | undefined): TomlTable[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isTomlTable);
};
