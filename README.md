# mend v2 (roni)

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/anjay1933/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/anjay1933/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies an edit an AI model
wrote to a tree of text files. It reads four formats — unified diffs, SEARCH/REPLACE
blocks, V4A patches, and JSON text-editor tool calls — matches old lines by content
at three whitespace tiers (so wrong line numbers and drifted indentation still apply),
and changes every file or nothing at all.

## Run it

    node main.ts [options] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the tree root).
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`, or
  `auto` (the default), which detects the format from the patch text.
- `--check` does everything but write: same output and exit code, no file created,
  changed, or deleted.
- `--strict` matches lines exactly (tier 0 only).

On success it prints one line per changed path (`A`, `D`, `M`, or `R old -> new`)
and `ok: <n> files`, and exits 0. On a failed edit it prints one
`error: <code> <path>` line per failure plus `failed: <k> of <n> edits` and exits 1
without writing anything. Usage, unreadable patch, undetected format, and parse
problems exit 2 with a single `error: ...` line. See `SPEC.md` for the full rules.

## How it works

- A line-cursor scanner reads the patch once into plain edit records; it never
  re-scans the patch.
- A context-hash matcher finds old lines by content: a tier-normalized rolling hash
  over the file's lines, verified by direct comparison, so line numbers are only a
  nearest hint for unified hunks and never trusted.
- Every file is a `LineFile` (its own break, its lines, its final break), so CRLF
  files and files without a final line break round-trip exactly.
- One dispatcher applies the records in patch order against an in-memory tree; a
  failed edit changes nothing for that edit, later edits still run, and when any
  edit failed nothing is written to disk.

## Practice check

The kit's practice set lives outside this directory, at
`../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json`.
Run it with the kit's checker:

    node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
    node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json u-offset s-basic

It prints every check this build gets wrong, with what differed, and the practice
score. In a trial, `main.ts` hands over to `runner.ts` when `MAKEFUN_ENV_URL` is
set; keep both files as they are.

## Files

- `main.ts` — the whole tool: Node 22, standard library only, single file.
- `runner.ts` — the trial runner (kit file, kept as-is).
- `check.ts` — the practice-set checker (kit file, kept as-is).
- `SPEC.md` — the specification this build implements.
- `LICENSE` — MIT.

## Notes

- Paths in a patch must be safe (relative, no `\`, no empty, `.`, or `..` segments);
  an unsafe path fails that edit with `error: unsafe <path>` before anything else
  about the edit is checked.
- Unified hunks match the occurrence nearest to the hunk's stated line (with the
  section's drift `d` accumulated), ties going to the earlier one; SEARCH/REPLACE
  blocks fail as `ambiguous` when the old lines occur more than once; V4A chunks
  walk a cursor forward from the top of the file, anchored when an `@@` line names
  one.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4hz31wc4&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
