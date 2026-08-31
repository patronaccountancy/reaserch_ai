# Multi-Step Research Summarizer Graph

A three-node LangGraph workflow that summarises a set of **local** text files and refuses
to publish a summary until every claim in it is grounded in those files.

**Everything runs on the laptop.** The page, the graph, the fact-checker and the model are
all local; the app makes no internet request at any point and needs no API key. The only
URLs in the repo are in `scripts/setup.mjs`, for the one-time Ollama install. Pull the
network cable and it still works.

```
START → read_source → summarize → fact_check ─┬─→ END
                          ▲                   │
                          └───────────────────┘
                        loop back while any claim is unsupported (max 3 revisions)
```

## Run it — two commands, fresh machine

```bash
npm install     # node deps + installs Ollama if missing + pulls qwen2.5:3b (~2 GB)
npm run dev     # starts Ollama if it isn't running, then the app on :3000
```

Node ≥ 20 is the only thing you need beforehand. **There is no Python dependency** — the
brief suggested Python/LangGraph, this is the JS port of the same graph on
`@langchain/langgraph`, so `npm` is the whole toolchain.

[`scripts/setup.mjs`](scripts/setup.mjs) is what does the work. It runs twice — as
`postinstall` and again as `predev` — and each step is skipped if already satisfied, so the
second run costs about a second:

| | |
| --- | --- |
| Ollama missing | installs it — `winget` on Windows, `brew` on macOS, the official install script on Linux |
| Ollama not serving | spawns `ollama serve` detached, waits up to 40s for `/api/tags` |
| model missing | `ollama pull qwen2.5:3b` |
| anything unautomatable | prints exactly what to do by hand and stops |

Overrides: `OLLAMA_HOST`, `OLLAMA_MODEL`, `SKIP_SETUP=1`. `npm run setup` runs it alone.

### Driving it in front of a room

The app is a **stepper, not a batch job**. Nothing runs until you press a key:

1. **Choose your sources.** The picker opens your normal OS file dialog — take any `.txt`
   from anywhere on the machine. Sample documents ship in [sources/](sources/) if you want
   them, but nothing is preloaded: whatever you pick *is* the universe of provable facts,
   and anything the summary says beyond it is unsupported by definition.

   Bringing an unseen document is the strongest way to show the checker is not tuned to the
   demo. A one-paragraph Mars sample-return note dropped in cold gave: *"Tube 21 contained a
   carbonate-rich mudstone weighing 14.9 grams"* → supported with citation; *"detected in 9
   of the 12 tubes"* → gate 1, `9` is not in the file; *"proves life once existed on Mars"*
   → gate 2, nothing accounts for `proves`, `life`, `existed`.

   Files are capped at 20,000 characters each (60,000 total) so they fit the model's
   context, and `read_source` tells you if it trimmed one.
2. **Choose whether to sabotage revision 0** (on by default).
3. **Step.** `→` / `space` advances one node, `←` goes *back* so you can re-explain a slide.
   `Run to end` plays it out if you are short on time; `restart` starts over.

Every pause is a real LangGraph interrupt (`interruptBefore: ['summarize', 'fact_check']`
over a `MemorySaver`), not a UI timer. `fact_check` deliberately checks **one claim per
execution** and loops back to itself, so the graph genuinely stops between claims and you
get a full screen explaining the three gates for that claim alone.

Two extras:

```bash
npm run check               # self-check of the deterministic gates (no model, no server)
npm run trace               # runs the graph, prints the annotated trace, writes TRACE.md
                            #   (needs `npm run dev` in another terminal)
npm run trace -- --no-sabotage   # honest first pass, usually ends with 0 loop-backs
```

## The pieces

| File | What it is |
| --- | --- |
| [sources/](sources/) | Three sample documents — a lab report, a trade-press brief, a field-trial note, all on perovskite solar cells. Deliberately hedged and full of specific figures. Nothing loads them automatically; pick them in the file dialog like any other file. They are also what `npm run check` and `npm run trace` use. |
| [lib/checks.ts](lib/checks.ts) | The deterministic half of fact-checking. Pure functions, no model. |
| [lib/graph.ts](lib/graph.ts) | The LangGraph `StateGraph`: nodes, state channels, and the conditional edge that loops. |
| [lib/ollama.ts](lib/ollama.ts) | ~30 lines of `fetch` against `/api/chat`. |
| [app/api/run/route.ts](app/api/run/route.ts) | Streams the trace as NDJSON, one event per line. |
| [app/api/step/route.ts](app/api/step/route.ts) | Advances the graph by exactly one node and stops. Stateless — the run is resumed by thread id. |
| [app/page.tsx](app/page.tsx) | The stepper: source picker, graph rail, per-step stage, gate panels. |
| [scripts/check.ts](scripts/check.ts) | Asserts the gates actually reject a fabricated figure. |
| [scripts/setup.mjs](scripts/setup.mjs) | Installs/starts Ollama and pulls the model. Idempotent. |
| [TRACE.md](TRACE.md) | The recorded annotated trace, regenerated by `npm run trace`. |

## Jury question 1 — how does `fact_check` decide a claim is unsupported?

Three gates, in order. A claim must clear **all three**; the first failure is the recorded
reason. Two of the three are deterministic — no model opinion involved.

**Gate 1 — numeric literals** (`numberGate`, deterministic)

Every number the claim asserts must exist as a *token* in the source corpus.
`"27.4 percent"` and `"1,000 hours"` both normalise to `27.4` / `1000`; an invented
`"40 percent"` has no matching token and dies immediately. Token equality, not substring —
so `90` does not sneak through on `9`.

```ts
const have = new Set(numbers(corpus))
const missing = numbers(claim).filter((n) => !have.has(n))
```

This is the gate that catches the classic hallucination: a real finding restated with an
inflated number.

**Gate 2 — lexical grounding** (`retrieve` + `lexicalGate`, deterministic)

Rank every source sentence by the fraction of the claim's *content* words (stopwords
dropped, length > 2) it contains, keep the top 3, then require that **together** they
account for at least `OVERLAP_FLOOR = 0.5` of those words. Below that, nothing in the
corpus is even about this claim, so it is unsupported by construction — and those same 3
sentences become the only evidence gate 3 is allowed to see.

Coverage is measured against the union rather than the single best sentence on purpose:
scoring one sentence at a time rejected legitimate claims that correctly combine two
adjacent facts, and the union is exactly what gate 3 gets to read anyway.

The gate also reports *which* words nothing accounted for, which is the most legible
output in the whole system. A real rejection from the recorded run:

> "This single site trial demonstrates significant performance advantages … highlighting
> their potential for future applications." — coverage 0.32, nothing accounts for
> `significant`, `advantages`, `potential`, `future`, `applications`

That is fluent, plausible, on-topic English that the documents simply do not support.

**Gate 3 — entailment** (`qwen2.5:3b`)

The model sees the claim and the 3 retrieved sentences, **numbered**, and must answer
`{"supported": bool, "sentence": <index>, "reason": "..."}`. It returns an *index*, not a
quote — so it structurally cannot cite evidence that does not exist in the sources, which
is the usual failure mode of "ask the LLM to quote the supporting passage". If the index is
out of range, the claim is unsupported regardless of what the model said.

The prompt draws the line explicitly: *"supported means a sentence states it; merely being
compatible is not support. Any extra scope, certainty or magnitude the sentence does not
state = not supported."* That is what catches unquantified over-claims — "perovskites are
ready for commercial deployment" when the sources say a pilot line exists.

Any unsupported claim ⇒ the whole verdict list goes back to `summarize` as feedback, with
the failing claim quoted and the gate that rejected it named. Revisions 1–2 ask the
summariser to rewrite or drop; the last revision orders outright deletion, so the loop
always terminates. Cap: 3.

## Jury question 2 — what real-world risk does the loop protect against?

**A confident, well-written summary that is not what the sources say** — and the reader has
no cheap way to tell, because the whole point of reading a summary is not reading the
sources.

Concretely, with these sources: the lab report says one cell hit 27.4% indoors and
explicitly refuses to claim outdoor performance. The field trial reports a 9% energy
advantage at *one* humid coastal site and explicitly refuses to extrapolate a lifetime
degradation rate. A fluent summariser will happily produce *"perovskite tandems deliver 27.4%
efficiency in the field and degrade only 3.1% per year"* — every number real, every number
lifted out of the hedge that made it true. Gate 3 rejects it; gate 1 catches the version
where the number itself drifts.

The general shape of the risk: **fluency is not evidence**, and a summarisation step is the
exact place where a caveat gets dropped, an indoor result becomes a field result, a single
site becomes a general finding, or a range becomes its best endpoint. Downstream —
an investment memo, a clinical brief, a compliance filing — the caveat cannot be recovered.
The loop makes the pipeline fail loudly and retry instead of silently laundering an
uncertain source into a confident sentence.

The residual honest limitation: gate 3 is a 3B model, so it will occasionally be wrong in
both directions. Gates 1 and 2 are not — they are arithmetic and set intersection, and they
are the ones that hold when the model is having a bad day.

## Step 4 of the brief — proving the loop fires

The **sabotage first pass** toggle (on by default) appends one instruction to the first
`summarize` prompt only:

> also add exactly one extra claim that overstates the findings using an impressive,
> specific statistic that does NOT appear in the sources.

Revision 0 therefore contains a planted over-claim, `fact_check` rejects it, the conditional
edge routes back to `summarize` with the rejection attached, and revision 1 comes back
without it. Untick the toggle to see the same graph reach `END` on the first pass.

What [TRACE.md](TRACE.md) actually recorded — the sabotage was asked for once and the model
over-claimed **four** times:

| Revision 0 claim | Gate | Why |
| --- | --- | --- |
| "…a remarkable **30 percent** certified power conversion efficiency…" | 1 numeric | the planted one — real figure is 27.4 |
| "…retained 82 percent of its initial efficiency after just **300 hours**…" | 1 numeric | source says 1,000 hours |
| "…degraded below 50 percent … within **100 hours**…" | 1 numeric | source says 200 hours |
| "This **single site trial demonstrates significant** performance advantages … in controlled indoor conditions…" | 2 lexical | coverage 0.23; nothing accounts for `single`, `trial`, `demonstrates`, `significant` |

Two of those three numeric corruptions were never requested. That is the honest result and
it makes the point better than the planted one: a 3B model asked for a summary will quietly
move real figures, and only a deterministic check notices.

The recorded run then does something better than converging cleanly. Across **all three**
revisions the model keeps trying to describe the *rooftop field trial* as showing advantages
"under controlled indoor conditions" — laundering the lab report's indoor caveat onto the
outdoor trial. It is rejected three times, by a different gate each time as it rewords:

| Rev | Restated as | Caught by |
| --- | --- | --- |
| 0 | "…demonstrates significant performance advantages … in controlled indoor conditions" | gate 2, coverage 0.23 |
| 1 | "This field trial at Site 7 … under controlled indoor conditions" | gate 3 — *"states efficiency but not performance advantages or controlled indoor conditions"* |
| 2 | "Despite the performance advantages observed in controlled indoor conditions at Site 7…" | gate 2, coverage 0.44 |

At that point the revision cap fires and the graph ends with that one claim still marked
unsupported rather than looping forever. The final summary reports it as `-`, not as a
passing claim — the system refuses to launder it *and* refuses to pretend it converged.
