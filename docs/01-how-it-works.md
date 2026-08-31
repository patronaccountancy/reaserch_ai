# How it works

End-to-end mechanism, from a file on your disk to a summary that has been forced to
justify itself. Read [02-fact-check.md](02-fact-check.md) next for the gates in detail.

---

## The one-paragraph version

A summariser is a machine for dropping caveats. You give it three documents and it hands
back fluent prose that reads exactly the same whether or not it is true. This project puts
a **verifier between the summariser and you**: every sentence the model produces is
checked back against the source text, and any sentence that cannot be grounded is sent
*back to the summariser* with the reason attached. The graph refuses to terminate until
every claim is grounded, or until it hits a revision cap and says so out loud.

---

## The graph

Three nodes, defined in [`lib/graph.ts`](../lib/graph.ts) using LangGraph's `StateGraph`.

```
                 ┌──────────────────────────────────┐
                 │                                  │  (unsupported claims exist
                 ▼                                  │   and revision < 3)
START ─→ read_source ─→ summarize ─→ fact_check ────┤
                                        ▲           │
                                        │           └─→ END
                                        └───────────────┘
                                     (more claims left in this pass)
```

`fact_check` has **two** loop edges, which is the part people miss:

- **to itself** — it checks exactly one claim per execution, so a presenter can pause on
  each claim individually. With 6 claims, the node runs 6 times.
- **back to `summarize`** — only after the last claim of a pass, and only if something was
  unsupported.

### Node: `read_source`

Loads the chosen `.txt` files, concatenates them into a corpus, and splits them into a
sentence index. It emits how many files and sentences it found.

The sentence index is the whole point: **it is the entire universe of provable facts** for
the rest of the run. `fact_check` can only ever cite from here.

Splitting is paragraph-first, then sentence-wise within each paragraph
([`checks.ts` → `sentences()`](../lib/checks.ts)). That order matters — splitting the
whole file on sentence boundaries glued a document's header onto its first real sentence,
which made every evidence quote start with `INTERNAL LAB REPORT — … Author: …`. Evidence
quotes get read aloud; they need to be clean. Sentences shorter than 4 words are dropped.

### Node: `summarize`

Sends the full source text to `qwen2.5:3b` and demands JSON: `{"claims": [...]}`, 4–6
claims, each one self-contained. The system prompt (`SUMMARISE_RULES`) forbids the exact
failure modes this project exists to catch:

```
- Copy figures exactly as written in the sources. Never round, scale or invent a number.
- Keep the hedge: indoors stays indoors, one site stays one site, a range stays a range.
- No forecasts, no "will", no "proves", no comparison the sources do not make.
```

These are instructions, not guarantees. The model violates them regularly — which is why
the gates exist. **Prompting is not verification.**

Two extra behaviours:

- **Revision 0 is sabotaged.** One instruction is appended asking for exactly one extra
  claim that overstates the findings with a statistic not in the sources. This is step 4
  of the brief: it guarantees a rejection and a visible loop-back. It is applied only on
  revision 0, never on a repair pass.
- **Repair passes get the rejections.** On revision ≥ 1 the prompt carries every rejected
  claim verbatim, the gate that rejected it, and the reason. On the final allowed revision
  the instruction hardens from "rewrite or drop" to "delete outright and replace", so the
  loop always converges or terminates.

### Node: `fact_check`

Takes `claims[cursor]`, runs it through three gates, appends a verdict, increments the
cursor. On the last claim of a pass it also computes `feedback` (the unsupported verdicts)
and increments `revision`.

All the gate logic is one exported function, `checkClaim(claim, docs, index)` — see
[02-fact-check.md](02-fact-check.md).

### The conditional edge

```ts
(s: State) => {
  if ((s.cursor ?? 0) < s.claims.length) return 'fact_check'   // more claims this pass
  const bad = (s.feedback ?? []).length
  const loop = bad > 0 && s.revision < MAX_REVISIONS
  return loop ? 'summarize' : END
}
```

`MAX_REVISIONS = 3`. Without that cap a model that keeps making the same unsupported
claim would loop forever. When the cap fires, the run ends with the claim still marked
unsupported — the system does **not** quietly accept it, and does not pretend it
converged.

---

## State

LangGraph state channels, declared with `Annotation.Root`. Each is last-write-wins.

| Channel | Holds |
| --- | --- |
| `selected` | bundled source filenames to use (CLI path) |
| `uploads` | documents chosen in the browser, `{name, text}` |
| `overclaim` | whether revision 0 gets the sabotage instruction |
| `docs` | the resolved documents for this run |
| `corpus` | all document text concatenated |
| `claims` | the current revision's claims |
| `cursor` | which claim `fact_check` checks next |
| `verdicts` | verdicts accumulated this pass |
| `revision` | pass counter, checked against `MAX_REVISIONS` |
| `feedback` | the unsupported verdicts, fed back into `summarize` |

---

## Pausing: interrupts, not a UI timer

The graph is compiled with:

```ts
b.compile({ checkpointer, interruptBefore: ['summarize', 'fact_check'] })
```

`interruptBefore` makes LangGraph stop *before* entering those nodes and persist its state
to the checkpointer. A run is resumed by calling `invoke(null, {configurable: {thread_id}})`,
which continues from the saved checkpoint.

Because `fact_check` loops to itself and is in the interrupt list, the graph genuinely
halts between every individual claim. **The pauses are real graph state, not the UI
withholding output it already has.**

### The checkpointer gotcha

```ts
const globalScope = globalThis as typeof globalThis & { __rsgCheckpointer?: MemorySaver }
const checkpointer = (globalScope.__rsgCheckpointer ??= new MemorySaver())
```

The `MemorySaver` is pinned to `globalThis` deliberately. Next's dev server re-evaluates
the module on every recompile; a plain module-level `const` would be replaced by an empty
saver, and the next resume would find no checkpoint for its thread and fail with
`Received no input writes for "__start__"`. This actually happened during development.

Consequence to know: **runs live in memory only.** Restart the server and any paused run
is gone. The API detects that specific failure and returns a message telling you to press
restart, rather than surfacing a raw LangGraph error.

---

## The request lifecycle

### `POST /api/step` — advance exactly one node

The route holds no state of its own. A run is addressed entirely by its `threadId`.

```
POST {}                 -> starts a run, returns { threadId, events, status, next, state }
POST { threadId }       -> runs the next node, returns the same shape
```

Internals:

1. Build the graph with an `emit` callback that pushes into a local `events` array.
2. `invoke(input, config)` — a fresh run passes the initial state, a resume passes `null`.
   Either way it returns when the next interrupt is hit.
3. `getState(config)` — `snap.next[0]` is the node that will run on the next call, or
   `undefined` at the end.
4. Respond with the events emitted during this node, plus `status: 'paused' | 'done'`.

The `emit` callback is created per request and captured by that request's graph instance,
so there is no shared mutable emitter and no chance of one request's events landing in
another's response.

### `POST /api/run` — the whole thing, streamed

Used by `npm run trace`. Same graph compiled *without* the checkpointer or interrupts, so
it runs start to finish. Emits NDJSON — one JSON event per line — as it goes.

---

## The client

[`app/page.tsx`](../app/page.tsx). Two screens.

**Setup.** A native `<input type="file">`. Files are read in the browser with `File.text()`
and posted to `localhost`. Nothing leaves the machine; the app makes no external request
at any point.

**Run.** The client keeps every event it has received in `steps[]` and a cursor `idx`.
Advancing is just `idx++` — which is why `Back` works, and why a presenter can step
backwards to re-explain a point.

Two behaviours worth knowing:

- **Prefetch.** The moment the cursor reaches the newest event, the next node starts
  computing in the background without waiting for a press. By the time the presenter
  finishes talking, `Next step` is usually instant instead of a 20–60s wait. Pressing
  Next mid-computation queues the jump rather than doing nothing.
- **Skipped screens.** Three event kinds render as a bare heading and are filtered out of
  the step list: `graph/start`, `summarize/start` on revision 0, and `pass_done` (which
  repeats the count the routing decision already prints). If a node produces *only*
  skipped events, the next node runs immediately so no press is ever dead. On a one-file
  run this turns 15 raw events into 11 screens.

---

## What a run looks like

Measured, one source file:

```
press 1   read_source · 1 source, 7 sentences
press 2   summarize rev0 · 1 claim
press 3   fact_check · claim 1/1 FAIL lexical
press 4   route -> summarize            <- the loop-back
press 5   summarize rev1 · re-prompt with 1 rejection
press 6   summarize rev1 · 3 claims
press 7-9 fact_check · claims 1-3 PASS
press 10  route -> END
press 11  END · 2 passes
```

---

## Determinism

`temperature: 0` on every model call. The same sources produce the same claims and the
same verdicts run after run — the recorded [TRACE.md](../TRACE.md) reproduced byte-identical
timings across two runs. Useful for rehearsing a presentation; it also means a bug is
reproducible rather than a coin flip.
