// mend v2 — a fresh, single-file implementation of SPEC.md (hidden-spec-cli-01-run-20261122).
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
//
// Design (streaming-first): a line-cursor scanner reads the patch once into edit records
// (plain data, not closures); a context-hash matcher finds old lines by content at three
// whitespace tiers; a LineFile model ({break, lines, finalBreak}) holds each file; one
// dispatcher applies the records in patch order against an in-memory tree; nothing is
// written unless every edit succeeds.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file as lines: its own break, its lines, whether it ends with a break. */
interface LineFile {
  brk: '\n' | '\r\n';
  lines: string[];
  final: boolean;
}

function parseFile(text: string): LineFile {
  if (text === '') return { brk: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const brk: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  const final = text.endsWith(brk);
  if (final) parts.pop();
  return { brk, lines: parts, final };
}

function serializeFile(lf: LineFile): string {
  if (lf.lines.length === 0) return '';
  return lf.lines.join(lf.brk) + (lf.final ? lf.brk : '');
}

function freshLf(lines: string[], final: boolean): LineFile {
  return { brk: '\n', lines, final: lines.length === 0 ? false : final };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

// ---- tier-normalized rolling hash matcher (SPEC section 5) ----

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function lineHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h;
}

/** All 0-based positions where oldLines occur in lines at the given tier, via a
 *  polynomial rolling hash over tier-normalized per-line hashes; every hash hit is
 *  verified by direct comparison, so a collision can never match wrongly. */
function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const k = oldLines.length;
  if (k === 0 || k > lines.length) return [];
  const B = 131;
  const normOld = oldLines.map((l) => normLine(l, tier));
  let oh = 0;
  for (const l of normOld) oh = (Math.imul(oh, B) + lineHash(l) + 1) >>> 0;
  const n = lines.length;
  const pref = new Array<number>(n + 1);
  pref[0] = 0;
  for (let i = 0; i < n; i++) pref[i + 1] = (Math.imul(pref[i]!, B) + lineHash(normLine(lines[i]!, tier)) + 1) >>> 0;
  let pow = 1;
  for (let i = 0; i < k; i++) pow = Math.imul(pow, B) >>> 0;
  const out: number[] = [];
  for (let i = 0; i + k <= n; i++) {
    const wh = (pref[i + k]! - Math.imul(pref[i]!, pow)) >>> 0;
    if (wh !== oh) continue;
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (normLine(lines[i + j]!, tier) !== normOld[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** Positions of oldLines at the first tier (0, then 1, then 2; only 0 when strict)
 *  at which at least one occurrence exists, or null when there is none. */
function tierPositions(lines: string[], oldLines: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const p = occurrences(lines, oldLines, t);
    if (p.length > 0) return { tier: t, pos: p };
  }
  return null;
}

/** One new line: `text` plus, for a context line, its index into O (written as the
 *  file's own matched line, never the patch's). */
interface NLine {
  text: string;
  ctx: number | null;
}

/** Build the replacement lines for a match at `pos`: context lines come from the
 *  file; at tier 2 every other non-blank line starting with O's first-line indent P
 *  has P replaced by the file's first matched line indent F. */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = (/^[ \t]*/.exec(fileLines[pos]!) ?? [''])[0]!;
    p = (/^[ \t]*/.exec(o[0]!) ?? [''])[0]!;
  }
  for (const e of n) {
    if (e.ctx !== null) {
      out.push(fileLines[pos + e.ctx]!);
      continue;
    }
    const t = e.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

// ---- edit records (plain data) ----

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNl: boolean;
  /** A `\` line follows the hunk's last `+` line, or null when it has none. */
  plusNoNl: boolean | null;
}
interface Chunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

type Edit =
  | { kind: 'uCreate'; path: string; lines: string[]; final: boolean }
  | { kind: 'uDelete'; path: string }
  | { kind: 'uChange'; path: string; hunks: Hunk[] }
  | { kind: 'uMove'; path: string; newPath: string; hunks: Hunk[] }
  | { kind: 'srCreate'; path: string; lines: string[] }
  | { kind: 'srReplace'; path: string; o: string[]; n: string[] }
  | { kind: 'vAdd'; path: string; lines: string[] }
  | { kind: 'vDelete'; path: string }
  | { kind: 'vUpdate'; path: string; newPath: string | null; chunks: Chunk[] }
  | { kind: 'jCreate'; path: string; text: string }
  | { kind: 'jStr'; path: string; oldStr: string; newStr: string }
  | { kind: 'jInsert'; path: string; line: number; add: string[] };

// ---- the one apply dispatcher ----

/** Apply a section's hunks in order to a LineFile (SPEC section 6). */
function applyUnifiedHunks(lf: LineFile, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = tierPositions(lf.lines, h.o, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bd = Math.abs(best - target);
      for (const p of found.pos) {
        const dd = Math.abs(p - target);
        if (dd < bd) {
          bd = dd;
          best = p;
        }
      }
      const rep = buildReplacement(lf.lines, best, h.o, h.n, found.tier);
      const toEnd = best + h.o.length === lf.lines.length;
      lf.lines.splice(best, h.o.length, ...rep);
      if (toEnd) lf.final = !h.noNl;
      d += h.n.length - h.o.length;
    } else {
      const ins = Math.min(Math.max(h.a + d, 0), lf.lines.length);
      const rep = h.n.map((e) => e.text);
      const atEnd = ins === lf.lines.length;
      lf.lines.splice(ins, 0, ...rep);
      if (atEnd && rep.length > 0) lf.final = !h.noNl;
      d += h.n.length;
    }
  }
}

/** Apply a V4A section's chunks in order, with the anchor cursor (SPEC section 8). */
function applyV4aChunks(lf: LineFile, chunks: Chunk[], path: string, strict: boolean): void {
  const tiers = strict ? [0] : [0, 1, 2];
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      let idx = -1;
      for (const t of tiers) {
        const na = normLine(c.anchor, t);
        for (let i = cursor; i < lf.lines.length; i++) {
          if (normLine(lf.lines[i]!, t) === na) {
            idx = i;
            break;
          }
        }
        if (idx >= 0) break;
      }
      if (idx < 0) throw new Fail('no-match', path);
      cursor = idx + 1;
    }
    if (c.o.length > 0) {
      let hit: { tier: number; pos: number } | null = null;
      for (const t of tiers) {
        const ps = occurrences(lf.lines, c.o, t).filter(
          (p) => p >= cursor && (!c.eof || p + c.o.length === lf.lines.length),
        );
        if (ps.length > 0) {
          hit = { tier: t, pos: ps[0]! };
          break;
        }
      }
      if (!hit) throw new Fail('no-match', path);
      const rep = buildReplacement(lf.lines, hit.pos, c.o, c.n, hit.tier);
      lf.lines.splice(hit.pos, c.o.length, ...rep);
      cursor = hit.pos + rep.length;
    } else {
      const ins = c.eof ? lf.lines.length : cursor;
      const rep = c.n.map((e) => e.text);
      lf.lines.splice(ins, 0, ...rep);
      cursor = ins + rep.length;
    }
  }
}

function applyJsonStr(tree: Tree, path: string, oldStr: string, newStr: string): void {
  const before = tree.get(path);
  if (before === null) throw new Fail('missing', path);
  const nl = before.indexOf('\n');
  const crlf = nl > 0 && before[nl - 1] === '\r';
  const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
  const t = lf(before);
  const old = lf(oldStr);
  let count = 0;
  for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
  if (count === 0) throw new Fail('no-match', path);
  if (count > 1) throw new Fail('ambiguous', path);
  const at = t.indexOf(old);
  const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
  tree.now.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
}

/** Apply one edit record to the tree. Returns a move pair when a move succeeded. */
function applyEdit(tree: Tree, e: Edit, strict: boolean): { old: string; new: string } | null {
  switch (e.kind) {
    case 'uCreate': {
      if (!safe(e.path)) throw new Fail('unsafe', e.path);
      if (tree.get(e.path) !== null) throw new Fail('exists', e.path);
      tree.now.set(e.path, serializeFile(freshLf(e.lines, e.final)));
      return null;
    }
    case 'uDelete': {
      if (!safe(e.path)) throw new Fail('unsafe', e.path);
      if (tree.get(e.path) === null) throw new Fail('missing', e.path);
      tree.now.set(e.path, null);
      return null;
    }
    case 'uChange':
    case 'uMove': {
      if (!safe(e.path)) throw new Fail('unsafe', e.path);
      if (e.kind === 'uMove' && !safe(e.newPath)) throw new Fail('unsafe', e.newPath);
      const before = tree.get(e.path);
      if (before === null) throw new Fail('missing', e.path);
      if (e.kind === 'uMove' && tree.get(e.newPath) !== null) throw new Fail('exists', e.newPath);
      const lf = parseFile(before);
      applyUnifiedHunks(lf, e.hunks, e.path, strict);
      const out = serializeFile(lf);
      if (e.kind === 'uMove') {
        tree.now.set(e.path, null);
        tree.now.set(e.newPath, out);
        return { old: e.path, new: e.newPath };
      }
      tree.now.set(e.path, out);
      return null;
    }
    case 'srCreate': {
      if (!safe(e.path)) throw new Fail('unsafe', e.path);
      if (tree.get(e.path) !== null) throw new Fail('exists', e.path);
      tree.now.set(e.path, serializeFile(freshLf(e.lines, true)));
      return null;
    }
    case 'srReplace': {
      if (!safe(e.path)) throw new Fail('unsafe', e.path);
      const before = tree.get(e.path);
      if (before === null) throw new Fail('missing', e.path);
      const lf = parseFile(before);
      const found = tierPositions(lf.lines, e.o, strict);
      if (!found) throw new Fail('no-match', e.path);
      if (found.pos.length > 1) throw new Fail('ambiguous', e.path);
      const rep = buildReplacement(
        lf.lines,
        found.pos[0]!,
        e.o,
        e.n.map((t) => ({ text: t, ctx: null })),
        found.tier,
      );
      lf.lines.splice(found.pos[0]!, e.o.length, ...rep);
      tree.now.set(e.path, serializeFile(lf));
      return null;
    }
    case 'vAdd': {
      if (!safe(e.path)) throw new Fail('unsafe', e.path);
      if (tree.get(e.path) !== null) throw new Fail('exists', e.path);
      tree.now.set(e.path, serializeFile(freshLf(e.lines, true)));
      return null;
    }
    case 'vDelete': {
      if (!safe(e.path)) throw new Fail('unsafe', e.path);
      if (tree.get(e.path) === null) throw new Fail('missing', e.path);
      tree.now.set(e.path, null);
      return null;
    }
    case 'vUpdate': {
      if (!safe(e.path)) throw new Fail('unsafe', e.path);
      if (e.newPath !== null && !safe(e.newPath)) throw new Fail('unsafe', e.newPath);
      const before = tree.get(e.path);
      if (before === null) throw new Fail('missing', e.path);
      if (e.newPath !== null && tree.get(e.newPath) !== null) throw new Fail('exists', e.newPath);
      const lf = parseFile(before);
      applyV4aChunks(lf, e.chunks, e.path, strict);
      const out = serializeFile(lf);
      if (e.newPath !== null) {
        tree.now.set(e.path, null);
        tree.now.set(e.newPath, out);
        return { old: e.path, new: e.newPath };
      }
      tree.now.set(e.path, out);
      return null;
    }
    case 'jCreate': {
      if (!safe(e.path)) throw new Fail('unsafe', e.path);
      if (tree.get(e.path) !== null) throw new Fail('exists', e.path);
      tree.now.set(e.path, e.text);
      return null;
    }
    case 'jStr': {
      if (!safe(e.path)) throw new Fail('unsafe', e.path);
      applyJsonStr(tree, e.path, e.oldStr, e.newStr);
      return null;
    }
    case 'jInsert': {
      if (!safe(e.path)) throw new Fail('unsafe', e.path);
      const before = tree.get(e.path);
      if (before === null) throw new Fail('missing', e.path);
      const lf = parseFile(before);
      if (e.line < 0 || e.line > lf.lines.length) throw new Fail('no-match', e.path);
      lf.lines.splice(e.line, 0, ...e.add);
      tree.now.set(e.path, serializeFile(lf));
      return null;
    }
  }
}

// ---- format detection (SPEC section 4) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- JSON edits (SPEC section 9) ----

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create' && typeof o.file_text === 'string') return { kind: 'jCreate', path: p, text: o.file_text };
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    return { kind: 'jStr', path: p, oldStr: o.old_str, newStr: (o.new_str as string | undefined) ?? '' };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    return { kind: 'jInsert', path: p, line: o.insert_line, add: patchLines(o.new_str) };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (SPEC section 6), SEARCH/REPLACE (section 7), V4A (section 8) ----
// (parsers below; each scans the patch lines once with a cursor and yields edit records)

function parseHunkHeader(line: string): { a: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { a: Number(m[1]) };
}

/** The path after `--- ` / `+++ `: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  hasPair: boolean;
}

/** Parse one hunk body starting at `start`; returns the index of the first line past it. */
function parseHunkBody(lines: string[], start: number, sec: Section, a: number): number {
  const entries: { kind: string; text: string; noNl: boolean }[] = [];
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
    if (line.startsWith(' ')) {
      entries.push({ kind: ' ', text: line.slice(1), noNl: false });
      i += 1;
      continue;
    }
    if (line.startsWith('-')) {
      entries.push({ kind: '-', text: line.slice(1), noNl: false });
      i += 1;
      continue;
    }
    if (line.startsWith('+')) {
      entries.push({ kind: '+', text: line.slice(1), noNl: false });
      i += 1;
      continue;
    }
    if (line.startsWith('\\')) {
      if (entries.length > 0) entries[entries.length - 1]!.noNl = true;
      i += 1;
      continue;
    }
    if (line === '') {
      entries.push({ kind: ' ', text: '', noNl: false });
      i += 1;
      continue;
    }
    break;
  }
  // A `\` line follows the body's last context or `+` line; the last `+` line likewise.
  // Read both before dropping trailing empty context lines, which are not part of the body.
  let noNl = false;
  let plusNoNl: boolean | null = null;
  let seenCtxPlus = false;
  for (let k = entries.length - 1; k >= 0; k--) {
    const e = entries[k]!;
    if ((e.kind === ' ' || e.kind === '+') && !seenCtxPlus) {
      noNl = e.noNl;
      seenCtxPlus = true;
    }
    if (e.kind === '+' && plusNoNl === null) plusNoNl = e.noNl;
    if (seenCtxPlus && plusNoNl !== null) break;
  }
  while (entries.length > 0) {
    const last = entries[entries.length - 1]!;
    if (last.kind === ' ' && last.text === '') entries.pop();
    else break;
  }
  const o: string[] = [];
  const nn: NLine[] = [];
  for (const e of entries) {
    if (e.kind === ' ') {
      const idx = o.length;
      o.push(e.text);
      nn.push({ text: e.text, ctx: idx });
    } else if (e.kind === '-') {
      o.push(e.text);
    } else {
      nn.push({ text: e.text, ctx: null });
    }
  }
  sec.hunks.push({ a, o, n: nn, noNl, plusNoNl });
  return i;
}

/** Parse one section's header lines and hunks starting at `start`; returns the index
 *  of the first line past the section (the next section's start, or the end). */
function parseSectionBody(lines: string[], start: number, sec: Section): number {
  let i = start;
  const n = lines.length;
  let inHeader = true;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) return i;
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      if (inHeader && !sec.hasPair) {
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(lines[i + 1]!);
        sec.hasPair = true;
        i += 2;
        continue;
      }
      return i;
    }
    if (line.startsWith('@@')) {
      const h = parseHunkHeader(line);
      if (!h) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      i += 1;
      i = parseHunkBody(lines, i, sec, h.a);
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        sec.pairNew = headerPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.create = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.del = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

function sectionToEdit(sec: Section): Edit {
  const isCreate = sec.pairOld === '/dev/null' || sec.create;
  const isDelete = sec.pairNew === '/dev/null' || sec.del;
  let oldP: string | null = sec.pairOld ?? sec.renFrom ?? sec.diffOld;
  let newP: string | null = sec.pairNew ?? sec.renTo ?? sec.diffNew;
  if (oldP === null) oldP = newP;
  if (newP === null) newP = oldP;
  if (oldP === null) oldP = '';
  if (newP === null) newP = '';
  if (oldP !== '/dev/null') oldP = stripAB(oldP);
  if (newP !== '/dev/null') newP = stripAB(newP);
  if (isCreate) {
    const plus: string[] = [];
    let plusNoNl: boolean | null = null;
    for (const h of sec.hunks) {
      for (const e of h.n) if (e.ctx === null) plus.push(e.text);
      if (h.plusNoNl !== null) plusNoNl = h.plusNoNl;
    }
    return { kind: 'uCreate', path: newP, lines: plus, final: plus.length > 0 ? !(plusNoNl ?? false) : false };
  }
  if (isDelete) return { kind: 'uDelete', path: oldP };
  if (oldP !== newP) return { kind: 'uMove', path: oldP, newPath: newP, hunks: sec.hunks };
  return { kind: 'uChange', path: oldP, hunks: sec.hunks };
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = {
        diffOld: m[1]!,
        diffNew: m[2]!,
        pairOld: null,
        pairNew: null,
        renFrom: null,
        renTo: null,
        create: false,
        del: false,
        hunks: [],
        hasPair: false,
      };
      sections.push(sec);
      i += 1;
      i = parseSectionBody(lines, i, sec);
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      const sec: Section = {
        diffOld: null,
        diffNew: null,
        pairOld: headerPath(line),
        pairNew: headerPath(lines[i + 1]!),
        renFrom: null,
        renTo: null,
        create: false,
        del: false,
        hunks: [],
        hasPair: true,
      };
      sections.push(sec);
      i += 2;
      i = parseSectionBody(lines, i, sec);
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map(sectionToEdit);
}

function srEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    if (oldLines.length === 0) edits.push({ kind: 'srCreate', path, lines: newLines });
    else edits.push({ kind: 'srReplace', path, o: oldLines, n: newLines });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'del' | 'upd' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headIdx = i;
    i += 1;
    // Gather this section's raw lines (with their patch line numbers) up to the next
    // section start or `*** End Patch`; blank lines at the end are not part of it.
    const raw: { t: string; no: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ t: l, no: i });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
    if (kind === 'add') {
      const fl: string[] = [];
      for (const r of raw) {
        if (r.t === '') fl.push('');
        else if (r.t.startsWith('+')) fl.push(r.t.slice(1));
        else throw new Exit2(`error: parse ${r.no + 1}`);
      }
      edits.push({ kind: 'vAdd', path, lines: fl });
    } else if (kind === 'del') {
      for (const r of raw) {
        if (!blank(r.t)) throw new Exit2(`error: parse ${r.no + 1}`);
      }
      edits.push({ kind: 'vDelete', path });
    } else {
      let newPath: string | null = null;
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let afterEof = false;
      for (const r of raw) {
        const t = r.t;
        if (t.startsWith('*** Move to: ')) {
          if (newPath !== null || chunks.length > 0 || cur !== null) throw new Exit2(`error: parse ${r.no + 1}`);
          newPath = t.slice('*** Move to: '.length).trim();
          continue;
        }
        if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.no + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          afterEof = true;
          continue;
        }
        if (t.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
          afterEof = false;
          continue;
        }
        if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (afterEof) throw new Exit2(`error: parse ${r.no + 1}`);
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.no + 1}`);
            cur = { anchor: null, eof: false, o: [], n: [] };
          }
          if (t.startsWith(' ')) {
            const idx = cur.o.length;
            cur.o.push(t.slice(1));
            cur.n.push({ text: t.slice(1), ctx: idx });
          } else if (t.startsWith('-')) {
            cur.o.push(t.slice(1));
          } else if (t.startsWith('+')) {
            cur.n.push({ text: t.slice(1), ctx: null });
          } else {
            const idx = cur.o.length;
            cur.o.push('');
            cur.n.push({ text: '', ctx: idx });
          }
          continue;
        }
        throw new Exit2(`error: parse ${r.no + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && newPath === null) throw new Exit2(`error: parse ${headIdx + 1}`);
      edits.push({ kind: 'vUpdate', path, newPath, chunks });
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- invocation, output and exit codes (SPEC sections 1, 2, 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = srEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: { old: string; new: string }[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const m = applyEdit(tree, edit, strict);
      if (m) moves.push(m);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.get(m.old);
    const wasNew = tree.original(m.new);
    const nowNew = tree.now.get(m.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      const di = rows.findIndex((r) => r.text === `D ${m.old}`);
      if (di >= 0) rows.splice(di, 1);
      const ai = rows.findIndex((r) => r.text === `A ${m.new}`);
      if (ai >= 0) rows.splice(ai, 1);
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
