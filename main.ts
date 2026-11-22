// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file as lines, its line break and whether it ends with one (SPEC §3). */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const parts = text.split(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function serializeFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.finalBreak ? s.br : '');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const trimTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Line equality at a matching tier (SPEC §5). */
function lineEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrailWs(a) === trimTrailWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** Positions where O occurs in lines at a tier, searching from `from`. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const start = Math.max(0, from);
  for (let i = start; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineEq(tier, O[k]!, lines[i + k]!)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier with an occurrence at or after `from`, or null. */
function findTier(O: string[], lines: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of O or N: ctx >= 0 is a context line (its index among context lines). */
interface OLN {
  text: string;
  ctx: number;
}

/** Re-indent one non-context N line at tier 2 (SPEC §5). */
function reindent(line: string, P: string, F: string): string {
  if (line === '' || line.trim() === '') return line;
  return line.startsWith(P) ? F + line.slice(P.length) : line;
}

/** Replace O at pos with N; context lines come from the file, others re-indented at tier 2. */
function replaceAt(lines: string[], pos: number, O: OLN[], N: OLN[], tier: number): string[] {
  const oPosOfCtx = new Map<number, number>();
  O.forEach((e, i) => {
    if (e.ctx >= 0) oPosOfCtx.set(e.ctx, i);
  });
  const P = O.length > 0 ? leadWs(O[0]!.text) : '';
  const F = O.length > 0 ? leadWs(lines[pos] ?? '') : '';
  const seg: string[] = [];
  for (const n of N) {
    if (n.ctx >= 0) seg.push(lines[pos + oPosOfCtx.get(n.ctx)!]!);
    else seg.push(tier === 2 ? reindent(n.text, P, F) : n.text);
  }
  return [...lines.slice(0, pos), ...seg, ...lines.slice(pos + O.length)];
}

/** O/N of a unified hunk body, plus whether `\` follows its last context or `+` line (SPEC §6). */
function hunkON(body: string[]): { O: OLN[]; N: OLN[]; backslashAfterLast: boolean } {
  const kinds: (' ' | '-' | '+')[] = [];
  const texts: string[] = [];
  const backs: boolean[] = [];
  for (const l of body) {
    if (l.startsWith('\\')) {
      if (backs.length > 0) backs[backs.length - 1] = true;
    } else if (l === '') {
      kinds.push(' '); texts.push(''); backs.push(false);
    } else {
      kinds.push(l[0] as ' ' | '-' | '+'); texts.push(l.slice(1)); backs.push(false);
    }
  }
  const O: OLN[] = [];
  const N: OLN[] = [];
  let ctx = 0;
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] === ' ') { O.push({ text: texts[i]!, ctx }); N.push({ text: texts[i]!, ctx }); ctx++; }
    else if (kinds[i] === '-') O.push({ text: texts[i]!, ctx: -1 });
    else N.push({ text: texts[i]!, ctx: -1 });
  }
  let backslashAfterLast = false;
  for (let i = kinds.length - 1; i >= 0; i--) {
    if (kinds[i] === ' ' || kinds[i] === '+') { backslashAfterLast = backs[i]!; break; }
  }
  return { O, N, backslashAfterLast };
}

/** O/N of a V4A chunk body (SPEC §8): no `\` lines. */
function chunkON(body: string[]): { O: OLN[]; N: OLN[] } {
  const O: OLN[] = [];
  const N: OLN[] = [];
  let ctx = 0;
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      const t = l === '' ? '' : l.slice(1);
      O.push({ text: t, ctx }); N.push({ text: t, ctx }); ctx++;
    } else if (l[0] === '-') O.push({ text: l.slice(1), ctx: -1 });
    else N.push({ text: l.slice(1), ctx: -1 });
  }
  return { O, N };
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

type Edit = (tree: Tree) => void;

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
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

/** A successful move, for the `R` output line (SPEC §2). */
type Move = { old: string; new: string };

/** One output row of a successful run. */
interface Row {
  key: string;
  text: string;
  kind: string;
  path: string;
  oldPath: string | null;
}

// ---- Unified diffs (SPEC §6) ----

interface UnifiedHunk {
  A: number;
  body: string[];
}

interface UnifiedSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UnifiedHunk[];
}

/** Path from a `--- `/`+++ ` header line: after 4 chars, up to first tab, spaces removed, a//b/ stripped. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseHunkBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: j };
}

/** The `+` lines of a creation's hunks, and whether `\` follows its last `+` line. */
function creationPlus(hunks: UnifiedHunk[]): { plus: string[]; suppress: boolean } {
  const plus: string[] = [];
  let suppress = false;
  for (const h of hunks) {
    let hasPlus = false;
    let lastPlusBack = false;
    for (let i = 0; i < h.body.length; i++) {
      const l = h.body[i]!;
      if (l.startsWith('\\')) continue;
      if (l.startsWith('+')) {
        plus.push(l.slice(1));
        hasPlus = true;
        lastPlusBack = (h.body[i + 1] ?? '').startsWith('\\');
      }
    }
    if (hasPlus) suppress = lastPlusBack;
  }
  return { plus, suppress };
}

function applyUnifiedHunks(st: FileState, hunks: UnifiedHunk[], path: string, strict: boolean): FileState {
  let lines = [...st.lines];
  let finalBreak = st.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const { O, N, backslashAfterLast } = hunkON(h.body);
    if (O.length === 0) {
      const beforeLen = lines.length;
      const at = Math.min(Math.max(h.A + d, 0), beforeLen);
      lines = [...lines.slice(0, at), ...N.map((e) => e.text), ...lines.slice(at)];
      if (at === beforeLen) finalBreak = !backslashAfterLast;
    } else {
      const found = findTier(O.map((e) => e.text), lines, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let pos = found.occ[0]!;
      for (const o of found.occ) {
        if (Math.abs(o - target) < Math.abs(pos - target)) pos = o;
      }
      const toEnd = pos + O.length === lines.length;
      lines = replaceAt(lines, pos, O, N, found.tier);
      if (toEnd) finalBreak = !backslashAfterLast;
    }
    d += N.length - O.length;
  }
  return { lines, br: st.br, finalBreak };
}

function unifiedSectionEdit(sec: UnifiedSection, strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : (sec.diffOld ?? null);
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : (sec.diffNew ?? null);
    if (sec.pairOld === null || sec.newFile) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const { plus, suppress } = creationPlus(sec.hunks);
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (suppress ? '' : '\n'));
      return;
    }
    if (sec.pairNew === null || sec.deletedFile) {
      if (oldP === null) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyUnifiedHunks(parseFile(cur), sec.hunks, oldP, strict);
      tree.now.set(oldP, null);
      tree.now.set(newP, serializeFile(out));
      moves.push({ old: oldP, new: newP });
      return;
    }
    if (oldP === null) return;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    const out = applyUnifiedHunks(parseFile(cur), sec.hunks, oldP, strict);
    tree.now.set(oldP, serializeFile(out));
  };
}

function unifiedEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: UnifiedSection[] = [];
  const blankSection = (): UnifiedSection => ({
    pairOld: undefined, pairNew: undefined, renameOld: undefined, renameNew: undefined,
    diffOld: undefined, diffNew: undefined, newFile: false, deletedFile: false, hunks: [],
  });
  let cur: UnifiedSection | null = null;
  let curHasPair = false;
  let inBody = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || l === 'diff --git') {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = blankSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      sections.push(s);
      cur = s;
      curHasPair = false;
      inBody = false;
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      const nx = lines[i + 1];
      if (nx !== undefined && nx.startsWith('+++ ')) {
        if (cur === null || curHasPair || inBody) {
          const s = blankSection();
          sections.push(s);
          cur = s;
          curHasPair = false;
          inBody = false;
        }
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(nx);
        curHasPair = true;
        i += 2;
        continue;
      }
      if (cur !== null && !inBody) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = parseHunkBody(lines, i + 1);
      cur.hunks.push({ A: Number(m[1]), body });
      inBody = true;
      i = next;
      continue;
    }
    if (cur !== null && !inBody) {
      if (l.startsWith('rename from ')) cur.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict, moves));
}

// ---- SEARCH/REPLACE blocks (SPEC §7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const st = parseFile(cur);
    const found = findTier(oldLines, st.lines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const O = oldLines.map((t) => ({ text: t, ctx: -1 }));
    const N = newLines.map((t) => ({ text: t, ctx: -1 }));
    const out = replaceAt(st.lines, found.occ[0]!, O, N, found.tier);
    tree.now.set(path, serializeFile({ lines: out, br: st.br, finalBreak: st.finalBreak }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchIdx = i;
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { eq = j; break; }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC §8) ----

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = parseFile(cur);
    let lines = [...st.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier([ch.anchor], lines, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const { O, N } = chunkON(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...N.map((e) => e.text), ...lines.slice(at)];
        cursor = at + N.length;
      } else {
        const found = findTier(O.map((e) => e.text), lines, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        let pos = -1;
        for (const o of found.occ) {
          if (!ch.eof || o + O.length === lines.length) { pos = o; break; }
        }
        if (pos < 0) throw new Fail('no-match', path);
        lines = replaceAt(lines, pos, O, N, found.tier);
        cursor = pos + N.length;
      }
    }
    const out = serializeFile({ lines, br: st.br, finalBreak: st.finalBreak });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isStarter = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const isAdd = l.startsWith('*** Add File: ');
      const isDelete = l.startsWith('*** Delete File: ');
      const prefix = isAdd ? '*** Add File: ' : isDelete ? '*** Delete File: ' : '*** Update File: ';
      const path = l.slice(prefix.length).trim();
      const updateLineNo = i + 1;
      let j = i + 1;
      let moveTo: string | null = null;
      if (!isAdd && !isDelete && j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const raw: { text: string; no: number }[] = [];
      while (j < last && !isStarter(lines[j]!)) { raw.push({ text: lines[j]!, no: j + 1 }); j++; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      if (isAdd) {
        const addLines: string[] = [];
        for (const r of raw) {
          if (r.text === '') addLines.push('');
          else if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
          else throw new Exit2(`error: parse ${r.no}`);
        }
        edits.push((tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) !== null) throw new Fail('exists', path);
          tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
        });
      } else if (isDelete) {
        for (const r of raw) throw new Exit2(`error: parse ${r.no}`);
        edits.push((tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) === null) throw new Fail('missing', path);
          tree.now.set(path, null);
        });
      } else {
        const chunks: V4AChunk[] = [];
        let k = 0;
        let firstChunk = true;
        while (k < raw.length) {
          const r = raw[k]!;
          let anchor: string | null = null;
          let eof = false;
          if (r.text.startsWith('@@')) {
            const a = r.text.slice(2).trim();
            anchor = a === '' ? null : a;
            k++;
          } else if (!firstChunk) {
            throw new Exit2(`error: parse ${r.no}`);
          }
          const body: string[] = [];
          while (k < raw.length) {
            const b = raw[k]!;
            if (b.text === '*** End of File') { eof = true; k++; break; }
            if (b.text.startsWith('@@')) break;
            if (b.text === '' || b.text.startsWith(' ') || b.text.startsWith('-') || b.text.startsWith('+')) {
              body.push(b.text);
              k++;
              continue;
            }
            throw new Exit2(`error: parse ${b.no}`);
          }
          chunks.push({ anchor, eof, body });
          firstChunk = false;
        }
        if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
        edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
      }
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

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
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Row[] = [];
  const covered = new Set<string>();
  for (const m of moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.new);
    const nowNew = tree.get(m.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}`, kind: 'R', path: m.new, oldPath: m.old });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, kind: was === null ? 'A' : now === null ? 'D' : 'M', path: p, oldPath: null });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const r of rows) {
      if (r.kind === 'D') rmSync(r.path, { force: true });
      else if (r.kind === 'R') {
        rmSync(r.oldPath!, { force: true });
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, tree.now.get(r.path)!);
      } else {
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, tree.now.get(r.path)!);
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
