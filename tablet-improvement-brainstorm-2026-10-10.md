# Tablet improvement brainstorming handoff

Review date: 10 October 2026 UTC  
Repository: [v3xlabs/tablet](https://github.com/v3xlabs/tablet)  
Reviewed default branch: master  
Verified HEAD: [52c813a618344e3061bfc9d4771360706cecdfe8](https://github.com/v3xlabs/tablet/commit/52c813a618344e3061bfc9d4771360706cecdfe8), committed 8 September 2026

## Purpose and starting point

These are ideas for an agent to investigate, challenge, and selectively implement with the owner’s approval. They are not a specification or a request to implement everything.

The owner uses Zeta 2.1 after switching from Sweep, values edit history and suggestions away from the cursor, and has observed an internal marker appearing in a suggestion. The exact previously used Sweep checkpoint and the current serving hardware, runtime, quantization, and configuration were not established.

The strongest initial opportunity appears to be making the existing Zeta pipeline reliable and measuring its full editor latency before replacing the model. Tablet already contains substantial useful behavior: edit history, accepted-prediction annotations, diagnostic retargeting, derived repairs, context selection, caching, accept-ahead requests, stale-document rejection, secret filtering, and adaptive eagerness. Preserve those benefits while testing changes.

This was a read-only source review, supplemented by primary model and editor documentation. No repository files were changed, no dependencies were installed, and no tests, live endpoint benchmarks, or editor replay sessions were run. “Confirmed” below means visible in the reviewed source; performance and user-experience consequences remain hypotheses unless explicitly described as historical measurements.

## Candidate priorities

### 1 Make multi-region parsing a small correctness project

**Confirmed:** `readZeta` finds the first and last numbered marker, takes everything between them, and removes only the cursor marker. An intermediate marker therefore remains in replacement text. The end-marker lookup also falls back to the editable window’s end whenever an index is missing, including an invalid index. This offers a concrete source-level explanation for the reported marker leak, without proving that every observed occurrence has this cause. [Tablet parser](https://github.com/v3xlabs/tablet/blob/52c813a618344e3061bfc9d4771360706cecdfe8/src/format/zeta.ts#L223-L255)

**Candidate:** Interpret the numbered-region protocol structurally. Validate marker identities, ordering, and bounds; concatenate the intended region contents without leaking control tokens; distinguish valid no-change output from malformed or truncated output. Preserve code whitespace exactly. Avoid a blanket cleanup regex that could accidentally conceal a protocol error.

**Small experiment:** Add fixtures for one region, several adjacent regions, unchanged output, invalid end IDs, reversed or repeated boundaries, incomplete output, empty edits, Unicode, and cursor markers. A useful success criterion is exact expected edits with no control-token leakage and no malformed response widening the replacement range. Keep a regression fixture matching the owner’s raw response when one is available.

Zed’s parser is a useful behavioral reference for [adjacent-region concatenation](https://github.com/zed-industries/zed/blob/f16f9652ec57bf806e65b2a0d51bb92a63644914/crates/zeta_prompt/src/multi_region.rs#L746-L788) and [boundary validation](https://github.com/zed-industries/zed/blob/f16f9652ec57bf806e65b2a0d51bb92a63644914/crates/zeta_prompt/src/multi_region.rs#L855-L888). Check licenses before incorporating upstream code: the [official bindings](https://pypi.org/project/zed-zeta-bindings/) declare GPL-3.0-or-later, while [Zeta 2.1 weights](https://huggingface.co/zed-industries/zeta-2.1) are Apache-2.0. Those are separate artifacts.

### 2 Recheck the context-overflow retry

**Confirmed:** The provider computes `suggestInput.budget` once. On an overflow failure it updates `runtime.contextLimit`, but calls the same closure again with the original input. The log announces the reduced budget while this retry still receives the old one. [Provider](https://github.com/v3xlabs/tablet/blob/52c813a618344e3061bfc9d4771360706cecdfe8/src/provider.ts#L279-L344)

**Candidate:** Rebuild the input budget before the retry, keeping it consistent with output-token reservation and the server’s reported limit.

**Small experiment:** Mock a first response reporting overflow. Check that the second assembled prompt is smaller and fits the revised budget, with one bounded retry and unchanged behavior for unrelated failures. This is likely inexpensive to investigate independently of model performance.

### 3 Establish an editor-realistic baseline

**Confirmed:** The benchmark defaults to Sweep’s next-edit format, a 7,000-token budget, and concurrency 8. Zeta’s extension default is 4,096. The harness invokes the suggestion pipeline directly, excluding provider debounce, live LSP gathering, editor display, and accept-ahead scheduling. Its score can reflect up to three successive edits. These are useful tests, but do not directly measure the first suggestion’s usefulness or pause-to-display latency. [Defaults](https://github.com/v3xlabs/tablet/blob/52c813a618344e3061bfc9d4771360706cecdfe8/bench/run.ts#L25-L34), [scoring](https://github.com/v3xlabs/tablet/blob/52c813a618344e3061bfc9d4771360706cecdfe8/bench/README.md), [Zeta defaults](https://github.com/v3xlabs/tablet/blob/52c813a618344e3061bfc9d4771360706cecdfe8/src/format/zeta.ts#L20-L36).

**Candidate:** Keep the existing synthetic suite and add a small replay set of real editing sessions. Match the actual Zeta profile, explicitly including format, endpoint, model, budget, and generation settings. Start at concurrency 1; measure realistic overlapping requests separately.

Record p50/p95 time from typing pause to the first valid displayed edit, first-edit usefulness, multi-Tab completion, invalid outputs, stale responses, false positives on clean code, acceptance, and retained edits. Separate debounce, context gathering, queueing, prefill, decoding, parsing, and rendering where instrumentation permits.

**Small experiment:** Replay the same held-out traces before and after each candidate change. Report sample counts and cold/warm conditions; avoid choosing a winner solely from tokens per second or a tiny aggregate accuracy change. Collect or reuse recordings with appropriate consent and redaction.

### 4 Make existing accept-ahead work cooperate with foreground requests

**Confirmed:** Tablet already predicts the next state as though the first suggestion were accepted. Its background call receives a fresh abort signal whose controller is discarded. Cache reuse covers completed results, with no visible pending-request joining in this path. Acceptance before background completion can therefore issue another request; whether this materially slows the user depends on server scheduling. [Provider](https://github.com/v3xlabs/tablet/blob/52c813a618344e3061bfc9d4771360706cecdfe8/src/provider.ts#L403-L432), [cache use](https://github.com/v3xlabs/tablet/blob/52c813a618344e3061bfc9d4771360706cecdfe8/src/ask-zeta.ts#L38-L46).

**Candidate:** Give speculation an explicit lifecycle: one cancellable pending job, a predicted-state identity, promotion or joining on a matching acceptance, and foreground priority when the user diverges. Account for configuration and relevant context, not just file text.

**Small experiment:** Test rapid acceptance, rejection, continued typing, file switches, and slow servers. Compare duplicate request count, wasted generation, speculation hit rate, and foreground p95. A simpler scheduler is worthwhile only if it preserves the already-good rapid-Tab flow.

### 5 Keep useful LSP context while reducing critical-path work

**Confirmed:** The provider awaits definitions before inference. Identifier lookups run concurrently with 400 ms timeout races, followed by sequential referenced-file reads. The timeout is neither a guaranteed 400 ms delay nor a total bound on context assembly. Later, Zeta filters out every chunk matching the target path, including potentially useful distant same-file definitions already fetched. [Provider](https://github.com/v3xlabs/tablet/blob/52c813a618344e3061bfc9d4771360706cecdfe8/src/provider.ts#L237-L289), [LSP collection](https://github.com/v3xlabs/tablet/blob/52c813a618344e3061bfc9d4771360706cecdfe8/src/lsp.ts#L9-L75), [path filter](https://github.com/v3xlabs/tablet/blob/52c813a618344e3061bfc9d4771360706cecdfe8/src/ask-zeta.ts#L22-L34).

**Candidates:** Cache version-aware definition excerpts, warm them during idle time, bound the entire collection phase, and deduplicate by range rather than dropping a whole file. Consider bounded parallel reads. Cancellation should remain effective throughout context gathering.

**Small experiment:** Compare fresh, cached, and deadline-limited context on traces with useful external and distant same-file definitions. Inspect both latency and edit quality; removing LSP altogether could discard valuable information.

### 6 Try serving changes before a model replacement

These are **measurement-needed experiments**, not verified fixes for this installation:

- Keep the model resident; measure warm and cold requests separately.
- Try server-side n-gram or prompt-lookup speculative decoding. It drafts likely copied text for the model to verify and is distinct from Tablet’s client-side accept-ahead request. Rewriting code is a promising workload, but gains depend on hardware, draft acceptance, and load. [llama.cpp documentation](https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md)
- Measure prefix-cache hit rate and prefill savings. Prefix caching does not accelerate output decoding, and Zeta’s suffix-first format can limit reuse when early prompt content changes. Preserve its trained prompt contract before experimenting with rearrangement. [vLLM prefix caching](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/)
- Compare quantization choices only after identifying the actual runtime and GPU. Measure protocol validity and retained-edit quality alongside speed.

Zeta 2.1 remains an 8B Seed-Coder fine-tune. Its multi-region output is intended to reduce rewriting. Zed reported mean output falling from roughly 270 to 90 tokens versus Zeta 2, with faster production responses; those figures are not a promise about this local endpoint. [Release measurements](https://zed.dev/blog/zeta2-1)

**Small experiment:** Sweep one serving change at a time against identical traces and settings, then rerun the promising combination under interactive load. Pin runtime versions because flags and supported speculation methods change.

## Further ideas if the first passes pay off

### Streaming and presentation

**Confirmed:** The request body forces `stream: false`, including when extra-body settings request otherwise. [Endpoint](https://github.com/v3xlabs/tablet/blob/52c813a618344e3061bfc9d4771360706cecdfe8/src/endpoint.ts#L125-L150)

Streaming could improve time to a usable suggestion, but arbitrary partial Zeta text is not yet a valid edit. An experiment would buffer until a complete, validated region is available, bind it to the source snapshot, and handle later regions without flicker or stale replacements. Progressive reveal of an already validated longer suggestion is another, separable UI experiment.

Copilot’s recent work offers useful inspiration: caching follow-on patches, preserving stable prompt prefixes, progressive reveal, and suppressing ignored ghost text when it would otherwise reappear in another presentation mode. Its prompt and patch contracts differ from Zeta’s, so copying its cursor-last layout into Zeta blindly would be risky. [Architecture](https://code.visualstudio.com/blogs/2026/09/16/building-the-github-copilot-inline-suggestions-model-part-one), [client experiments](https://code.visualstudio.com/blogs/2026/09/23/building-the-github-copilot-inline-suggestions-model-part-two).

### History and farther-away edits

Keep the existing history behavior central to evaluation. Zeta currently targets the active-file cursor and then an active-file diagnostic; related-file context does not itself provide cross-file edit prediction. The project already lists cross-file Zeta targets as future work. [Target selection](https://github.com/v3xlabs/tablet/blob/52c813a618344e3061bfc9d4771360706cecdfe8/src/ask-zeta.ts#L81-L108), [project notes](https://github.com/v3xlabs/tablet/blob/52c813a618344e3061bfc9d4771360706cecdfe8/docs/plan.md#L330-L345).

Possible experiments include a bounded candidate selector for related call sites and retaining the model’s predicted cursor for follow-on suggestions. Today the parser strips the cursor marker and speculation assumes the cursor ends at the insertion. Validate cursor behavior against actual editor acceptance before changing it; converting to upstream byte-based APIs would also require explicit offset conversion. [Speculative state](https://github.com/v3xlabs/tablet/blob/52c813a618344e3061bfc9d4771360706cecdfe8/src/speculate.ts#L7-L39).

Do not remove diagnostics solely because they add tokens. Historical repository notes report 54 to 56 passes on a 60-case slice, with mean time rising from 1.4 to 1.9 seconds. That is a small, historical quality/latency trade-off worth remeasuring on the current setup, not a current benchmark result.

### Optional model comparisons

There is no verified universally better replacement here. If comparison remains useful, try [Sweep next-edit v2](https://huggingface.co/sweepai/sweep-next-edit-v2-7B) only after confirming whether it was already tested. For a lighter completion-only lane, [Qwen2.5-Coder-1.5B base](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B) and [Mellum-4b-sft-all](https://huggingface.co/JetBrains/Mellum-4b-sft-all) are candidates, with their own FIM templates and evaluation.

A model adapter should make prompt format, stop tokens, parser, supported edit types, and cursor behavior explicit. A fast FIM insertion is not evidence that deletion, replacement, history-following, and far-away suggestions improved.

## Suggested handoff outcome

An agent could begin with parser fixtures and the overflow retry, then establish the replay baseline and choose one latency experiment. A useful report would show the reproduced issue, the smallest proposed change, before/after evidence, preserved behavior, and remaining uncertainty. Revisit priorities freely as measurements arrive.

