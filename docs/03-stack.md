# Every file and every dependency

What is in the project, what each piece does, and why it is there.

---

## Dependencies

Four runtime packages. Nothing else was added.

| Package | Installed | What it does here |
| --- | --- | --- |
| `@langchain/langgraph` | 0.2.74 | `StateGraph`, `Annotation`, conditional edges, `MemorySaver`, `interruptBefore`. The whole graph runtime. |
| `next` | 15.5.24 | App Router, API routes, the dev/build/start toolchain. |
| `react` / `react-dom` | 19.2.8 | The UI. |

Dev-only:

| Package | Installed | What it does here |
| --- | --- | --- |
| `tailwindcss` + `@tailwindcss/postcss` | 4.3.3 | Styling. v4, so config is a `@theme` block in CSS — no `tailwind.config.js`. |
| `typescript` | 5.9.3 | Types. Enforced by `next build`, **not** by `next dev`. |
| `@types/node`, `@types/react` | — | Type definitions. |

**No LLM SDK.** Ollama is reached with plain `fetch` against its HTTP API — about 30 lines
in [`lib/ollama.ts`](../lib/ollama.ts). An SDK would have earned nothing.

**No test framework.** `scripts/check.ts` is `node:assert` and runs on bare Node.

### External services

None. The app makes no internet request at any point and needs no API key. The only URLs
anywhere in the repo are in `scripts/setup.mjs`, for the one-time Ollama install.

### Deviation from the brief

The brief recommends **Python**. This is TypeScript on `@langchain/langgraph`, the official
JS port — same `StateGraph`, same nodes, same conditional edges, same interrupt/checkpointer
model. Ollama, `qwen2.5:3b`, local text files and no-internet are all as specified. Be ready
to say this out loud; it is the one thing a jury will notice immediately.

---

## The model

`qwen2.5:3b` via Ollama, called at `http://localhost:11434/api/chat`.

- `temperature: 0` on every call — the same inputs give the same claims and verdicts. The
  recorded trace reproduced with byte-identical timings across two runs.
- `format: 'json'` — Ollama constrains output to valid JSON. `parseJson()` still keeps a
  fallback that extracts the first `{…}` or `[…]` from the response, because a small model
  occasionally wraps its JSON in prose anyway.
- Overridable: `OLLAMA_HOST`, `OLLAMA_MODEL`.

Two calls happen per run per unit of work: one `summarize` per revision, and one gate-3
entailment call per claim that reaches gate 3. On a 3B model on a laptop, budget roughly
20–60s per node.

---

## Files

### `lib/`

**`graph.ts`** — the whole graph. Node definitions, state channels, edges, the
`interruptBefore` compile, the `globalThis`-pinned checkpointer, `checkClaim()`, both
prompts, and `run()` for the non-interactive path. If you only read one file, read this.

**`checks.ts`** — the deterministic half of fact-checking. Pure functions, no I/O, no model:
`sentences()`, `contentWords()`, `numbers()`, `numberGate()`, `retrieve()`, `lexicalGate()`,
and `OVERLAP_FLOOR`. Kept separate precisely so it can be tested without a model running.

**`ollama.ts`** — `chat()` and `parseJson()`. That is the entire model integration.

### `app/`

**`page.tsx`** — both screens: the file picker and the stepper. Holds `steps[]` and a cursor,
does the prefetch, filters content-free screens, and renders every stage including the
three gate panels.

**`api/step/route.ts`** — advances the graph by exactly one node. Stateless; a run is
addressed by `threadId`. Returns `{ threadId, events, status, next, state }`.

**`api/run/route.ts`** — runs the graph start to finish, streaming NDJSON. Used by
`npm run trace`.

**`layout.tsx`, `globals.css`** — shell and Tailwind theme tokens.

### `scripts/`

**`setup.mjs`** — makes the machine ready: installs Ollama if missing (`winget` / `brew` /
the official install script), starts `ollama serve` detached and waits up to 40s, pulls the
model. Every step is skipped if already satisfied, so re-running costs about a second. Runs
automatically as `postinstall`, `predev` and `prestart`. `SKIP_SETUP=1` bypasses it.

**`check.ts`** — the deterministic-gate self-check. `node:assert`, no model, no server.

**`trace.mjs`** — drives `/api/run` and writes the annotated `TRACE.md`. Flags:
`--sources a.txt,b.txt` and `--no-sabotage`.

### `sources/`

Three sample documents on one topic — a lab report, a trade-press brief, a field-trial note,
all about perovskite solar cells. Deliberately written the way real documents are: full of
specific figures, and full of explicit hedges ("we make no claim about outdoor performance",
"twelve months is too short a window to extrapolate"). Those hedges are what a summariser
strips, which is what makes them useful here.

Nothing loads them automatically — pick them in the file dialog like any other file. They
are also what `npm run check` and `npm run trace` use.

### Root

`TRACE.md` (the recorded annotated trace), `README.md`, `next.config.ts`, `tsconfig.json`,
`postcss.config.mjs`, `package.json`.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm install` | deps, then `setup.mjs` — installs Ollama if missing, pulls `qwen2.5:3b` |
| `npm run dev` | runs `setup.mjs`, then the dev server on :3000 |
| `npm run build` | production build. **Stop the dev server first** — same `.next` directory |
| `npm start` | runs `setup.mjs`, then serves the build |
| `npm run check` | deterministic gate self-check, no model needed |
| `npm run trace` | runs the graph, prints the annotated trace, writes `TRACE.md` (needs a server running) |

---

## Things that will bite you

**`next build` while `next dev` is running.** They share `.next`. The build overwrites the
chunks the dev server is serving and you get `Cannot find module './611.js'` and an Internal
Server Error. Stop the dev server first.

**`next dev` does not typecheck.** Only `next build` runs TypeScript. A circular return type
in `page.tsx` sat there invisibly until the first production build caught it. Build before
you trust it.

**Paused runs live in memory.** `MemorySaver` only. Restart the server and any in-progress
run is gone; the UI tells you to press restart.

**First request per route in dev is slow.** Next compiles routes on demand. Click one step
before a presentation and everything after is warm — or use `npm run build && npm start`,
where the first `/api/step` responded in 0.089s.

**File size cap.** Chosen files are clamped to 20,000 characters each and 60,000 total,
because the text goes straight into the summariser prompt. Truncation is reported in the
`read_source` step rather than silently summarising page one.
