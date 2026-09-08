# tablet: state, problems, and plan

Written 2026-09-08 from a read of the source, a probe of the shared endpoint, and a
token measurement of the assembled prompts. The external research that this plan draws
on is in [research.md](research.md).

## Where we are

tablet is a bring-your-own-endpoint vscode extension. It speaks two formats to an
OpenAI-compatible `/completions` endpoint:

- `fim`: prefix, suffix, and a ring of cross-file chunks, in the Qwen `<|fim_*|>` layout.
- `next-edit`: the sweep layout. A file excerpt, diagnostics, cross-file chunks, recent
  changes, and an `original` and `current` window of 21 lines around the cursor. The
  model writes the `updated` window.

The pipeline is in `src/suggest.ts`. For `next-edit` it asks up to four times per
trigger: the cursor window, a second window centred on the nearest diagnostic, and up to
two windows in recently touched files. Deterministic repairs (whitespace drift, trailing
spaces, rename spread, final newline) answer before the model when the fault is on the
cursor line. The bench in `bench/` replays 248 generated cases through the same
`suggest()` and scores 97.6% with diagnostics, 79.8% without. The remaining failures are
the scorer and one insertion-shaped burst case.

What the extension does not have today:

- No token budget. Nothing counts tokens or trims sections.
- No accept, reject, or ignore record. `handleEndOfLifetime` only clears the remembered
  answer on a rejection.
- No status bar menu. A click opens the configuration picker.
- No edit history in the prompt beyond the last 8 coalesced hunks.
- No data collection.

## Problem 1: context overflow

The endpoint rejects, it does not truncate. The roadmap page said llama.cpp truncates
from the front silently. That is wrong for this server. A probe on 2026-09-08 returned:

```
400 {"error":{"code":400,"message":"request (9001 tokens) exceeds the available
context size (8192 tokens), try increasing it","type":"exceed_context_size_error",
"n_prompt_tokens":9001,"n_ctx":8192}}
```

The endpoint reports `n_ctx: 8192` per slot and `n_ctx_train: 32768`. The extension
sends `max_tokens: 1024` on every request. So the prompt must stay under about 7100
tokens, and there is nothing in the code that makes it do so.

Measured with the endpoint's own `/tokenize`, default configuration, cursor on line 150
(`.tmp/context-audit/measure.ts`):

| prompt content | typical `src/*.ts` file | `bench/run.ts` | `pnpm-lock.yaml` |
|---|---|---|---|
| 300 file lines + 2 windows, nothing else | 2400 to 3000 | 3400 | 7144 |
| + 8 changes + 10 long tsc diagnostics | 3900 to 4500 | 4900 | 8643 |
| + 8 changes + 50 long tsc diagnostics | 6600 to 7200 | 7600 | 11343 |

Add 1024 for `max_tokens` and four of the seven rows in the bottom band overflow. This is
why the failure appears "after a while of editing": a file mid-refactor accumulates
diagnostics, the change log fills to 8 entries, and the last few hundred tokens tip it
over. Long-line files (lock files, minified code, data) overflow on the file excerpt
alone.

Where the tokens go, in order of size and variance:

1. `{{file}}`: `contextLines: 300` lines of the target file. 2.4k to 3.5k tokens for
   code, unbounded for long lines. Constant cost, never trimmed.
2. `{{diagnostics}}`: up to 50 entries (`ERROR_LIMIT` 30 + fill to `DIAGNOSTIC_LIMIT`
   50 in `src/provider.ts`). A TypeScript message is often 200 to 400 characters. This is
   the section that grows during a session. Up to 4k tokens.
3. `{{changes}}`: 8 coalesced hunks, each `before` and `after` with 2 lines of padding.
   A burst that pastes or reformats a block carries the whole block twice. Unbounded.
4. `{{context}}`: ring chunks plus `contextFiles` windows. See the finding below.
5. `{{original}}` and `{{current}}`: 21 lines each, small.

A second finding from the same measurement: the ring buffer is dead for ordinary files.
`chunksAround` in `src/context/ring-buffer.ts` picks one chunk `scopeLines` (1024) above
the cursor and one 1024 below. For any file under about 1040 lines both spans clamp to
zero length and are filtered out. Every bench seed and every file in `src/` is shorter
than that, so `{{context}}` has only ever held the `recentFileChunks` windows. The
`tablet.ringBuffer` setting has no effect in practice. This is not the cause of the
overflow, but it means the cross-file context design has never been exercised.

A third finding: each trigger can issue up to four requests, each with its own full
prompt, and the extension does not stop after the first overflow. The status bar shows
the 400 for each.

Where the popup comes from: the source in `src/` never calls `showErrorMessage` for a
request failure. The failure goes to the output channel and the status bar with a warning
background. If a notification is visible, it comes from a build older than the current
source, or from vscode itself. Worth confirming with the exact text next time it shows.

### Fix

Count tokens locally and trim to a budget before sending. Every system in research.md
does this: Copilot with a cap per section, Zed with one budget at 90% and bytes divided
by 3. Concretely:

- A token estimator in `src/format/budget.ts`. A characters-per-token ratio calibrated
  against `/tokenize` on this endpoint is enough (code lands near 4.0 to 4.3 characters
  per token, yaml near 1.9). Use a conservative 3.5 and keep the measurement script so
  the constant can be re-checked. No tokenizer dependency.
- A `contextBudget` field per configuration, default 7000 tokens for an 8192 slot.
  `maxTokens` is subtracted from it. Read the endpoint's `/v1/models` `meta.n_ctx` once
  at activation when the server exposes it, and warn in the status bar when the
  configured budget exceeds it.
- Assembly order by priority, and trim from the lowest: the two windows and the
  instruction are fixed. Then diagnostics on the window, then changes newest first, then
  the file excerpt shrinking symmetrically around the window, then diagnostics outside
  the window, then cross-file chunks. Each section gets a cap in tokens, not lines, and
  a line longer than 400 characters is cut with a marker.
- Diagnostics: keep the first sentence of a message. TypeScript's second and third
  sentences are the type dump. Cap at 12 entries, errors first, nearest first.
- Changes: cap each hunk at 12 lines per side. A large paste is summarised as the first
  and last lines and a count.
- One overflow rejection per trigger halves the file excerpt and retries once, then
  records the working budget for the session.
- Bench flag `--budget` and a bench check that no assembled prompt exceeds it, so the
  regression is caught offline without a request.

This is roadmap item R6 on the overview page, with the truncation claim corrected.

## Problem 2: status bar menu

Today the click opens the configuration picker. Wanted: a menu with

- enable or disable automatic suggestions for this session
- enable or disable data collection (off by default)
- pick configuration
- open the data folder
- show log

vscode has no native popover for status bar items. The idiom is a `QuickPick` opened by
the status bar command, with items rendered as toggles (`$(check)` and `$(circle-large-outline)`
icons, or `$(pass-filled)` and `$(circle-large-outline)`) and separators between groups.
The menu becomes the status bar command in every state, and the existing commands stay
registered so keybindings keep working.

The `enabled` override already exists in the memento (`ENABLED_KEY`). Collection is a new
`tablet.collect` setting with a session override on the same pattern, and the status bar
text shows a `$(record)` glyph while collection is on so it is never on by surprise.

## Problem 3: data collection

Goal: build a local dataset from the primary user's own editing, without a network, in a
format close enough to the zeta dataset that we can mix with it later and extend with
diagnostics and lsp hints.

### What to record

One record per served suggestion, completed when its lifetime ends. Fields:

- `id`, `timestamp`, `language`, `path` (relative, workspace name only), `config` name,
  `format`
- `prompt`: the exact string sent, after redaction. This is the ground truth of what
  the model saw and is what makes a record replayable in the bench.
- `input`: the structured inputs the prompt was built from: file excerpt, window,
  cursor, `events` (the change log as diffs, in the zeta `User edited "path":` unified
  diff style), `diagnostics`, `chunks`.
- `output`: what the model returned, raw texts, and the parsed edits.
- `outcome`: `accepted`, `rejected`, `ignored`, with `userTypingDisagreed` and partial
  accept lengths when the API gives them. Latency in milliseconds. Endpoint failure
  kind when there was one.
- `resolution`: what the user did next. This is the DPO signal.

### The resolution rule

On `Rejected` or `Ignored` with `userTypingDisagreed`, start watching the document. The
window of interest is the suggestion's edit range extended by the 21 line window. Stop
watching, and write the record, when the first of these happens:

- the document has been idle for 1000 ms after at least one change inside the window
- the cursor leaves the window plus 50 lines, or the active editor changes
- 60 seconds pass

The record then holds `resolution.text`, the window text at that moment, and
`resolution.diff` against the window at suggestion time. When the user changed nothing
in the window, `resolution` is `none`, which is also useful: it says the model should
have stayed silent.

On `Accepted`, `resolution` is the accepted edit, and a short follow-up watch (same rule)
records whether the user immediately edited what was accepted.

Everything the record carries passes through `redactSecrets`, secret paths are refused
at the source, and the whole feature is off unless the menu turns it on.

### Where it goes

`context.globalStorageUri/collect/<workspace>/<yyyy-mm-dd>.jsonl`, one JSON object per
line, appended as records complete. The menu entry "Open data folder" reveals it in the
file manager, and the status bar tooltip shows the count for the day. A
`tablet.exportDataset` command packs the folder as a `tar.gz` for hand-off. No upload
code in the extension at any point.

### What the record is for

Three uses, in the order they pay off:

1. Replay. A record re-runs through `suggest()` offline, so prompt and budget changes
   are measured on real editing (roadmap R4).
2. Preference pairs. A rejected suggestion with a resolution is a DPO row: the
   resolution is `output`, the model text is `rejected`. Zed needed about 150 of these
   for zeta 1.
3. Teacher labels. Zed's zeta 2 lesson is to train on a strong model's answer given the
   user's starting state, not on what the user typed. The record holds the starting
   state, so a later script can ask a teacher for the label and keep the user's edit as
   the check.

### Making it useful later

- `bench/replay.ts` reads a collect file and re-runs `suggest()` on the stored inputs, so
  a recorded session becomes an eval case (roadmap R4) and every prompt or budget
  change is measured against real editing.
- `bench/export-zeta.ts` maps records to the zeta dataset columns, so the local set can
  sit beside the public one on huggingface. Fields the zeta schema lacks (diagnostics,
  lsp hints, latency, outcome) go in extra columns under a `tablet_` prefix.

## Problem 4: edit history and the zeta prompt format

See research.md for the exact formats. The gap between tablet's `changes` section and
what zeta and copilot send: they keep an ordered log of unified diffs across files,
grouped by time and line distance, newest kept under a token budget, emitted oldest
first. tablet keeps 8 before/after blocks with 2 lines of padding and a word-level
analysis block. Sweep's model was trained on the block form, so the block form stays for
that endpoint. The plan is:

- One change log, held as unified diff hunks with a timestamp and a path. Grouping rule
  from Zed: edits within 8 lines and 1 second join one event, an event over 6 KB is
  dropped. The log renders to the sweep block form or the unified form by template.
  It also serves as the dataset `events` field and the bench replay input.
- Mark an accepted tablet suggestion in the log the way Zed does, so the model and the
  dataset can tell a user edit from an accepted prediction.
- Add a `zeta` prompt format beside `fim` and `next-edit`. Zeta 2.1 is suffix,
  prefix, middle in Seed-Coder tokens with numbered `<|marker_N|>` blocks of 6 to 16
  lines and a 4096 token budget. The block splitter and the output parser are the new
  code. The markers and tokens are template strings, so the existing template machinery
  carries it and a Qwen-token variant costs one configuration.
- The bench runs the same cases through both formats against the same host, so the
  choice of model is measured and not argued.

## Order of work

Each item is one session: change, `pnpm check`, bench run, keep or revert.

1. Token budget and trimming (Problem 1). Unblocks daily use. Bench check for prompt
   size runs offline.
2. Ring buffer fix, together with 1, because the budget decides how many chunks fit.
3. Status bar menu with the enabled and collection toggles (Problem 2).
4. Collection: records, the resolution watcher, the data folder, the export command
   (Problem 3). Runs on the primary user's machine from this point on.
5. Replay bench from collected records (R4). First real edit-history cases.
6. Change log as unified diffs, the `zeta` format, and a bench comparison of sweep
   against zeta-2.1 on the same endpoint host.
7. Suppression from collected outcomes. Copilot's client scores accept 1, reject 0,
   ignore 0.5 and moves an eagerness level on thresholds 0.7 and 0.4. The same rule
   fits tablet's debounce and idle trigger once records exist.
8. Cursor jump and long-distance targets. Copilot runs a separate location model only
   when the edit model returns nothing, and shows the jump only when an edit comes back
   at the target. tablet's diagnostic-centred second window is the rule-based form of
   this and stays until the replay bench can score a learned one.

Fine-tuning our own model comes after 5 and 6 have produced a few thousand records.

## Status, 2026-09-08

Landed in one session, all under `pnpm check` with 201 tests:

- **P1 token budget.** `src/format/budget.ts` estimates tokens at 3.5 characters each and
  `fitToBudget()` trims sections in a fixed order. `assembleNextEdit()`, `assembleFim()`,
  and `assembleZeta()` all take a `budget`. Diagnostics are cut to 12 entries and their
  first sentence. A change hunk is cut to 12 lines a side. A line over 400 characters is
  clipped outside the windows. Each configuration has `contextBudget`, default 7000 for
  sweep and fim, 4096 for zeta. A 400 `exceed_context_size_error` from llama.cpp is read
  as a `context` failure, the reported size is held for the session in
  `runtime.contextLimit`, and the ask is repeated once within it. `pnpm bench --budget`
  reports an oversized prompt offline.
- **P2 ring buffer.** `chunksAround()` picks just outside the span the prompt carries.
  `scopeLines` default is 150. The ring holds chunks for ordinary files for the first time.
- **P3 menu.** The status bar click opens `tablet.menu`, a quick pick with two switches
  and four entries. Paused shows `$(debug-pause)`, collecting shows `$(record)`.
- **P4 collection.** `tablet.collect` is a resource scoped setting, off by default, toggled
  from the menu into the workspace settings. `src/collect/` holds the record type, the
  redaction pass, the jsonl store under global storage, and the resolution watcher. The
  provider captures every exchange and settles the record from `handleEndOfLifetime`.
  `tablet.openDataFolder` and `tablet.exportDataset` are the ways out. `bench/export-zeta.ts`
  maps records to the zeta columns.
- **P6 in part.** `RecentEdit` carries its start line and `src/format/udiff.ts` renders a
  unified hunk. The `zeta` format is a third configuration format: `src/format/zeta.ts`
  splits the editable region into 6 to 16 line blocks, writes the markers, and reads the
  reply span. `pnpm bench --format zeta` runs the corpus through it.

Measured after the change:

| run | result |
|---|---|
| sweep, full corpus | 240 of 248, the same six real failures as before, plus two missing fixtures |
| sweep, full corpus, model edits ranked before local repairs | 235 of 248: three 429s from an overlapping run, two missing fixtures, and four `missing-punct` or `trailing` cases where the model's first edit is wrong and the local fix now sits second |
| zeta 2.1, first 60 cases | 49 of 60, 2 missing fixtures, 9 no-ops of which 6 are `away` placements the 32 line window cannot reach, mean 2.9 s per case |

The two `env-secret-*` cases reference a `.env` fixture that the repository ignores, so
they are missing on a fresh checkout. `pnpm bench:generate` restores them.

Not done, in the order they are worth doing:

1. P5 replay bench from collected records.
2. The accepted-prediction mark in the change log, which needs the record's outcome to
   reach the tracker.
3. A diagnostic-centred second window for zeta, which is what sweep has and zeta lacks,
   and what the `away` placements need.
4. One record per served item. Today several items from one ask share one record and the
   first lifetime event settles it.
5. P7 suppression and P8 jumps.
