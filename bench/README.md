# eval

An offline harness that measures how well a next-edit endpoint repairs deliberately broken
code, end to end through the same `suggest()` pipeline the extension runs.

## Layout

- `seeds/` — clean source files the corpus is derived from
- `generate.ts` — applies deterministic faults to the seeds and writes `cases/`
- `cases/<id>/` — one broken scenario: `case.json`, the broken `files/`, and the `expected/` repaired text
- `run.ts` — drives every case against a live endpoint and scores the answers
- `results/` — one JSONL file per run, not committed

## Fault categories

`indent` (a line pushed 5 spaces right), `trailing` (5 spaces appended), `missing-punct`
(a semicolon dropped), `missing-line` (a load-bearing line deleted), `duplicate` (a
declaration doubled), `typo` (an identifier misspelled), `truncated` (a line cut mid-word,
cursor at the cut), `stale-rename` (a rename left half applied, with the rename in
`recentEdits`), `stale-rename-cross` (the stale use sits in a file the cursor is not in),
and `clean` (nothing wrong; the only right answer is no suggestion).

Cases that a real editor would annotate carry the matching diagnostics in `case.json`.

Each fault appears in up to three cursor placements: `near` (on the faulty line), `far`
(8 lines away, fault still inside the window), and `away` (25 lines away, fault outside
the window, reachable only through a diagnostic).

## Running

```sh
pnpm bench:generate            # rebuild cases/ from seeds/ (deterministic)
pnpm bench                     # full run against the default endpoint
pnpm bench -- --limit 20 --concurrency 4
pnpm bench -- --filter series-indent
pnpm bench -- --no-diagnostics # measure what the diagnostics contribute
pnpm bench -- --no-format-marker # drop the formatter instruction from the prompt
pnpm bench -- --windowLines 31 --contextLines 100 --endpoint http://127.0.0.1:8080/v1 --model m
```

Scoring: the first suggestion is applied to the file it names, then the case is asked
again on the changed text, up to three rounds, the way a reader tabs through successive
suggestions. `pass` is an exact match, `pass-loose` differs only in blank lines,
`format-pass` is a formatter request on a fault a formatter would fix. Everything else
counts against the run: `no-op`, `wrong-edit`, `wrong-file`, `false-positive` (an edit on a
clean file), `format-wrong`, `error`.
