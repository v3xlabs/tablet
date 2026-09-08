# Next edit prediction: research notes

Collected 2026-09-08 for tablet. Every fact below names its source. Quoted strings are
literal. Where a source could not be read, the section says so.

Companion: [plan.md](plan.md) holds what we do with this.

## Link index

Models and datasets

- Zed zeta-2.1 model card: https://huggingface.co/zed-industries/zeta-2.1
- Zed zeta-2 model card: https://huggingface.co/zed-industries/zeta-2
- Zed zeta (v1) model card: https://huggingface.co/zed-industries/zeta
- Zed zeta dataset: https://huggingface.co/datasets/zed-industries/zeta
- Continue instinct model: https://huggingface.co/continuedev/instinct
- Continue instinct dataset: https://huggingface.co/datasets/continuedev/instinct-data
- Continue instinct training code: https://github.com/continuedev/instinct
- Sweep next-edit-v2-7B: https://huggingface.co/sweepai/sweep-next-edit-v2-7B
- Sweep next-edit-1.5B: https://huggingface.co/sweepai/sweep-next-edit-1.5B
- NextEditPrediction (Lu et al.): https://github.com/lurf21/NextEditPrediction, paper https://arxiv.org/abs/2508.10074, data https://huggingface.co/datasets/lurf21/NextEditPrediction
- SAFIM: https://github.com/gonglinyuan/safim, paper https://arxiv.org/abs/2403.04814, data https://huggingface.co/datasets/gonglinyuan/safim
- RepoBench: https://github.com/Leolty/repobench, paper https://arxiv.org/abs/2306.03091, data https://huggingface.co/datasets/tianyang/repobench_python_v1.1
- CommitPackFT: https://huggingface.co/datasets/bigcode/commitpackft
- EditPackFT, CanItEdit: https://huggingface.co/datasets/nuprl/EditPackFT, https://huggingface.co/datasets/nuprl/CanItEdit
- NextCoder and SeleKT: https://github.com/microsoft/NextCoder, data https://huggingface.co/datasets/microsoft/NextCoderDataset
- CoEdPilot: https://arxiv.org/abs/2408.01733, https://github.com/code-philia/CoEdPilot, data https://huggingface.co/datasets/kraalfar/CoEdPilot-generator-processed
- InstructCoder: https://huggingface.co/datasets/likaixin/InstructCoder

Writeups

- Cursor, Tab update (Fusion): https://cursor.com/blog/tab-update
- Cursor, instant apply: https://cursor.com/blog/instant-apply
- Cursor, online RL for Tab: https://cursor.com/blog/tab-rl
- Cursor, Tab docs: https://cursor.com/docs/tab/overview
- Zed, edit prediction (zeta 1): https://zed.dev/blog/edit-prediction
- Zed, zeta2: https://zed.dev/blog/zeta2
- Zed, how we developed zeta2: https://zed.dev/blog/how-we-developed-zeta2
- VS Code, long distance NES: https://code.visualstudio.com/blogs/2026/02/26/long-distance-nes
- VS Code, NES announcement: https://code.visualstudio.com/blogs/2025/02/12/next-edit-suggestions
- GitHub, NES custom model training: https://github.blog/ai-and-ml/github-copilot/evolving-github-copilots-next-edit-suggestions-through-custom-model-training/
- Sweep, open source next edit (paused, HTTP 402 at time of writing): https://blog.sweep.dev/posts/oss-next-edit, discussion https://news.ycombinator.com/item?id=46713106
- Pochi, training a NES model: https://dev.to/getpochi/what-it-really-took-to-train-a-next-edit-suggestion-model-4bf2

Source code

- Zed prompt builder: https://github.com/zed-industries/zed/tree/main/crates/zeta_prompt
- Zed client: https://github.com/zed-industries/zed/tree/main/crates/edit_prediction/src
- Zed data and training tooling: https://github.com/zed-industries/zed/tree/main/crates/edit_prediction_cli
- Copilot NES client (archived 2026-05-20): https://github.com/microsoft/vscode-copilot-chat, directory `src/extension/xtab`

## Cursor Tab

Source: the three Cursor posts and the Lex Fridman transcript.

- The Fusion model (January 2025) against the original Tab model (March 2024):
  server p50 latency 475 ms to 260 ms, context 5500 to 13000 tokens, and "instant,
  accurate" cursor jumps where the original had none.
- "custom sparse language model trained to predict edits on billions of tokens". The
  team says on the podcast that Tab is a mixture of experts model, "incredibly pre-fill
  token hungry", served with "speculative edits" where the current text is the draft.
- Inputs named in the docs: "your recent edits, surrounding code, and linter errors".
  Cross-file suggestions render in "a portal window" at the bottom of the editor.
- Online RL post (September 2025): 400 million requests a day. Reward 0.75 for an
  accept, -0.25 for a reject, 0 for showing nothing, so the policy shows a suggestion
  only when it estimates the accept chance at 25% or more. A checkpoint rolls out and
  collects the next batch in 1.5 to 2 hours. Result: 21% fewer suggestions, 28% higher
  accept rate.
- The same post describes the 2022 Copilot filter: a logistic regression over 11
  features, suggestion hidden below a 15% score.
- Speculation on the client: fire the next request as if the shown suggestion were
  accepted, so the next one is ready when Tab is pressed.
- Not published: model size, prompt format, how edit history is encoded.

## GitHub Copilot NES and VS Code long distance NES

Sources: the two VS Code posts, the GitHub blog, and the archived
`microsoft/vscode-copilot-chat` source.

Training, from the GitHub blog:

- PR data failed because it "Shows only the final state, not the intermediate edits
  developers make". They ran "a large-scale custom data collection effort that captured
  code editing sessions from a set of internal volunteers". "a smaller volume of
  high-quality edit data led to better models".
- SFT on that data, then RL with "a large reasoning model with specific grading
  criteria" as the grader.
- Each release cut prompt size: "Trimmed the prompt, reused more cached tokens between
  calls, and removed unneeded markup". A/B against production: April shown rate +17.9%
  and accept +10.0%; May shown -18.8% and accept +23.2%; November shown -24.5% and
  accept +26.5%.

Two models for long distance, from the VS Code post:

- "We trained a dedicated location model whose sole responsibility is to predict where
  the next edit should happen." The NES model then edits at that location.
- Trained on the same editing trajectories, filtered so the jump target appears in the
  prompt. SFT first, which "learned to jump confidently but hadn't learned when to stay
  put", fixed by rebalancing, then RL with verified rewards.
- Result: 23% more code written through NES. Far suggestions are rejected more often.

The prompt, from `src/extension/xtab/common/tags.ts` and `promptCrafting.ts`:

```
<|recently_viewed_code_snippets|>
<|recently_viewed_code_snippet|>
code_snippet_file_path: <path>
<lines>
<|/recently_viewed_code_snippet|>
<|/recently_viewed_code_snippets|>

<|current_file_content|>
current_file_path: <path>
<clipped file, with the block below spliced in>
<|area_around_code_to_edit|>
<up to 15 lines above>
<|code_to_edit|>
<2 lines above the cursor, the cursor line with <|cursor|>, 5 lines below>
<|/code_to_edit|>
<up to 15 lines below>
<|/area_around_code_to_edit|>
<|/current_file_content|>

<|linter|> ... <|/linter|>            (optional)

<|edit_diff_history|>
--- <path>
+++ <path>
@@ -<start>,<len> +<start>,<len> @@
-old
+new
<|/edit_diff_history|>

<|area_around_code_to_edit|> ... <|/area_around_code_to_edit|>   (repeated)
<post-script instruction>
```

Budgets from `xtabPromptOptions.ts`: current file 2000 tokens clipped in 10-line pages
around the edit window, recently viewed documents 5 files and 2000 tokens, diff history
25 entries and 1000 tokens, edit window 2000 tokens, hard cap 30k tokens at 4 chars per
token. The legacy endpoint record says `max_prompt_tokens: 12285`.

Edit history: per-file unified diffs, newest kept first under the budget, then emitted
oldest to newest. Adjacent line edits merge into one hunk. Whitespace-only hunks are
dropped. Bursts split after a 100 ms gap.

Diagnostics: `line:col - severity source(code): message` plus the flagged line, sorted by
distance from the cursor, warnings only when there are no errors, at most 5 for the
location model. The main edit model gets none by default.

Suppression: the model emits `<|edit_intent|>low|medium|high|no_edit<|/edit_intent|>`
and the client compares it with an eagerness level. An adaptive score (accept 1, reject 0,
ignore 0.5, thresholds 0.7 and 0.4) picks the level automatically. Post filters drop
import-only edits, whitespace-only edits, and an edit that undoes the last insertion.
Debounce base 100 ms, 2000 ms extra at end of line.

Location model on the client (`xtabNextCursorPredictor.ts`): runs only when the edit
model returned nothing. System prompt: "Your task is to predict the line number where the
developer is most likely to make their next edit. If you jump in the current file, just
output the line number. If you want to jump to another file, output the filepath
(relative to workspace root), colon, then line number." Same user prompt with `N| ` line
numbers, 40 output tokens. The client then re-runs the edit model at that line and shows
the jump only when an edit comes back.

Speculative decoding: `prediction: true` sends the edit window as the predicted output.

## Zed zeta 1, 2, and 2.1

Sources: the model and dataset cards, the three Zed posts, and `crates/zeta_prompt`.

Zeta 1 (February 2025): Qwen2.5-Coder-7B, SFT with Unsloth and LoRA on about 50 Claude
examples plus about 400 from the team's own usage, then DPO on about 150 hand-picked
pairs. Latency targets p50 under 200 ms and p90 under 500 ms, reached with n-gram
speculative decoding because "the output often mirrors the input closely". Prompt:

```
### Instruction:
You are a code completion assistant and your task is to analyze user edits and then
rewrite an excerpt that the user provides, suggesting the appropriate edits within the
excerpt, taking into account the cursor location.

### User Edits:

User edited "models/customer.rb":

```diff
@@ -2,5 +2,5 @@
-      @name = name
+      @name = name.capitalize
```

### User Excerpt:

```models/customer.rb
<context before>
<|editable_region_start|>
<editable, with <|user_cursor_is_here|>>
<|editable_region_end|>
<context after>
```

### Response:
```

Budgets in the client: editable 350 tokens, context 150 tokens, 6 events in the prompt
out of 10 kept. Edits within 8 lines and 1 second group into one event. A diff over 6144
bytes is dropped. Unified diffs carry 3 context lines.

Zeta 2 (early 2026): "nearly 100,000 examples collected on an opt-in basis in
open-source licensed repositories". Acceptance 30% better than zeta 1. The key
method is distillation: "we collect starting states from users like cursor position and
recent edits, but we don't train on what users actually write. Instead, we feed that
starting state to the teacher (Sonnet 4.6 as of now) and use its predictions as the
training signal". Commit-derived synthetic data was "too clean". Base switched to
Seed-Coder-8B for about 1% acceptance. Context now includes LSP definitions of symbols
near the cursor. The teacher prompt has one hard rule: "NEVER undo or revert the user's
recent edits."

Zeta 2.1: `ByteDance-Seed/Seed-Coder-8B-Base`, Apache-2.0, format `V0318SeedMultiRegions`.
The prompt is suffix, prefix, middle in Seed-Coder tokens, and the editable region is
split into numbered blocks:

```
<[fim-suffix]>
code after editable region
<[fim-prefix]><filename>related/file.py
related file content

<filename>edit_history
--- a/some_file.py
+++ b/some_file.py
-old
+new

<filename>path/to/target_file.py
code before editable region
<|marker_1|>
code that
needs to<|user_cursor|>
be rewritten
<|marker_2|>
<[fim-middle]>
```

Output is `<|marker_1|>` rewritten block `<|marker_2|>` then `<[end▁of▁sentence]>`. Rules
from `multi_region.rs`: blocks of 6 to 16 lines, boundaries preferred after blank lines
and not on structural tail lines (`}`, `)`, `return`, `end`), no newline after a tag. A
no-op is the same tag twice. `<|user_cursor|>` in the output moves the cursor after
accept. Prompt budget 4096 tokens at 90% margin, estimated as bytes divided by 3.
Editable and context ranges grow to enclosing tree-sitter node boundaries when they fit.
An accepted prediction in the history is prefixed `// User accepted prediction:`.

Later Zed formats worth knowing: `V0420Diagnostics` adds a `<filename>diagnostics`
section at 8192 tokens, and `V0615HashRegions` hashes every region so the model can name
a far target without a cursor-centred editable region. Jumps ship behind a flag: the
client sends cursor, events, editable context, syntax ranges, and active diagnostics,
and the server returns a unified diff that may land elsewhere. A diagnostics update
triggers a refresh.

Dataset `zed-industries/zeta`: 583 rows, Apache-2.0, five string columns `events`,
`input`, `output`, `rejected`, `assertions`. `train` 418, `dpo` 132 with `rejected`
filled, `eval` 33 with plain-English `assertions` judged by Claude. `input` is a fenced
block whose info string is the path, holding the zeta 1 markers. Rows are generated from
markdown files with `<events>`, `<input>`, `<output>`, `<rejected>`, `<assertions>`
tags. The 100k zeta 2 set is not released.

## Sweep next-edit (the current tablet endpoint)

Source: the two model cards and their `inference.py`, plus the HN thread. The blog is
down.

- v2-7B: Qwen2.5-Coder-7B, 32768 context, Apache-2.0, "SFT -> GRPO -> DPO on developer
  editing traces". About 100k SFT examples from permissive repos, then 2000 RL steps
  with tree-sitter parse checks and a size penalty.
- Prompt, verbatim from `inference.py`:

```
<|file_sep|>{file_path}
{initial_file}{retrieval_results}
{recent_changes}
<|file_sep|>original/{file_path}:{start_line}:{end_line}
{prev_section}
<|file_sep|>current/{file_path}:{start_line}:{end_line}
{code_block}
<|file_sep|>updated/{file_path}:{start_line}:{end_line}
{prefill}
```

  with each recent change as `<|file_sep|>{path}:{start}:{end}\noriginal:\n{old}\nupdated:\n{new}`.
- Window 10 lines above and below the cursor, file context 150 lines above and below,
  stop on `<|endoftext|>` and `<|file_sep|>`, 1024 new tokens, greedy. Default prefill
  is the window up to the cursor line, so edits land at or below the cursor.
- Sweep says a genetic search over 30 diff formats found `original`/`updated` blocks beat
  unified diffs for small models, and that exact match tracked usability best.
- No dataset released.

## Continue instinct

Source: the dataset rows, the model card, the blog.

- Qwen2.5-Coder-7B fine-tuned with SeleKT (5% of weights, 5 epochs). Apache-2.0.
- 9044 rows in `messages` form (system, user, assistant). 4370 TypeScript rows are real
  edits from the Continue team, keystroke data chunked "with line- and timing-based
  heuristics". Python, Java, Rust, and C are translated from the TypeScript rows with
  Qwen3-Coder-30B.
- Format is the zeta 1 format wrapped in a chat template: `### Context:` with
  `<|context_file|>` and `<|snippet|>`, `### User Edits:` as `User edited file "<path>"`
  plus a fenced unified diff, most recent first, five entries, and `### User Excerpt:`
  with `<|editable_region_start|>`, `<|user_cursor_is_here|>`,
  `<|editable_region_end|>`. Editable region is one line above the cursor to five below.
- Judge: LLM score on a 5 point scale, instinct 3.877 against zeta 3.735.

## NextEditPrediction (Lu et al., 2025)

- Task defined as predicting "both the location and content of the subsequent edit"
  from interaction history. 3211 training samples in 7 languages from CommitPackFT,
  keeping commits with two or more hunks of five lines or less, then dropping the last
  hunk to make a partial state. GPT-4o-mini labelling removed 72.8% as incoherent.
  Benchmark 210 hand-verified commits.
- Prompt `<|original_code|>{old}<|edits_diff|>{diff}<|current_version|>{current}<|next_version|>{new}`.
- Metrics: exact match, partial match, position match, LLM judge. Best fine-tune
  Qwen2.5-Coder-32B at 51.43% exact match. Location and content are separable skills.

## Adjacent benchmarks

- SAFIM: 17720 syntax-aware fill-in-the-middle tasks with unit tests, pass@1. A
  regression check that a next-edit fine-tune keeps plain completion ability.
- RepoBench: retrieval and next-line completion with cross-file context, exact match and
  edit similarity. Relevant to the retrieval side, has no edit history.
- CanItEdit, EditPackFT, InstructCoder, NextCoderDataset: instruction-conditioned
  editing. Useful as base-model checks, not as next-edit training data.
- CoEdPilot: 3.76M commit-derived rows with `code_before`, `edits`, `next_edit`, and
  line-level keep/add/replace labels. The largest public prior-edits-to-next-edit set.

## Format comparison

| system | editable region | history | context | budget | jump |
|---|---|---|---|---|---|
| sweep v2 | 21-line window, `original` and `current` blocks, rewrite `updated` | `original:` and `updated:` blocks per change | 300 file lines, retrieval | 8192 on our server | none |
| zeta 1 | `<\|editable_region_start\|>` to end, cursor marker | unified diff per event, 6 events | 150 context tokens | small | none |
| zeta 2.1 | numbered `<\|marker_N\|>` blocks, 6 to 16 lines each | unified diff, `// User accepted prediction:` | related files by LSP, suffix first | 4096 | flag, patch from server, hashed regions |
| copilot xtab | `<\|code_to_edit\|>` 2 above and 5 below, `<\|area_around_code_to_edit\|>` 15 each side | `<\|edit_diff_history\|>` unified, 25 entries, 1000 tokens | current file 2000, 5 recent files 2000, linter | 12285 legacy, 30k cap | separate location model |
| instinct | zeta 1 markers, 1 above and 5 below | unified diff, 5 entries, newest first | `<\|context_file\|>` snippets | chat | none |
| NEP paper | whole file | unified diff | none | 2048 | implicit |

## What this says for tablet

1. Everyone budgets in tokens with a fixed order of sections. Copilot gives each section
   its own cap. Zed uses one budget at 90% and bytes divided by 3. tablet has no
   budget, which is the overflow bug.
2. The edit window is small everywhere: 7 to 8 lines for Copilot and instinct, 6 to 16
   per block for zeta 2.1, 21 for sweep. The file excerpt around it is the largest
   section and the first to clip.
3. Edit history is a unified diff in every system except sweep, grouped by time and line
   distance, newest kept under a budget, emitted oldest first. Sweep found its block
   form better for a small model, so the format should stay a template choice.
4. Diagnostics reach the prompt in Copilot's location model and Zed's `V0420` format,
   as one line per diagnostic near the cursor, at most 5 in Copilot. tablet sends up to
   50 with full messages.
5. The data that trains these models is editing sessions, not commits. GitHub, Zed, and
   Continue all say this. Zed's second lesson is that the label should come from a
   teacher given the user's starting state, not from what the user typed next.
6. Suppression is learned or scored: Cursor's reward, Copilot's edit intent, Zed's DPO
   negatives. The signal is accept, reject, and ignore per suggestion.
7. Jumps are a second decision. Copilot trains a separate location model and only shows
   a jump when the edit model produces an edit there. Zed returns a patch and lets hashed
   regions name the target. tablet's diagnostic-centred second window is a rule-based
   version of the same idea.
8. Speculative decoding on the current text is what makes rewrite-the-window formats
   fast. llama.cpp supports it through a draft, and vLLM through n-gram lookup.
