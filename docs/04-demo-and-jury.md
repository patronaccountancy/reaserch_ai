# Running the demo, and the jury answers

---

## Before the room fills

```bash
npm install          # first time only: deps + Ollama + qwen2.5:3b
npm run build
npm start            # :3000
```

Use the production build for the presentation. In dev mode Next compiles each route on
first hit, which is a multi-second stall on your first press; on the build, the first
`/api/step` responded in 0.089s.

Sanity check with no model needed:

```bash
npm run check        # -> ok — 35 sentences indexed from 3 sources, all gate checks pass
```

Confirm Ollama is up: `curl http://localhost:11434/api/tags` should list `qwen2.5:3b`.

---

## Driving it

1. **Choose a file.** Any `.txt` from anywhere on the machine — the OS file dialog. The
   three sample documents are in `sources/`.
2. **Start run.**
3. **Step** with `Next step`, `→`, or space. `←` and `Back` go backwards, so you can return
   to a screen and re-explain it. `Run to end` plays it out if you are short on time.

The next node computes in the background while you talk, so presses are usually instant.
Every screen carries content — the empty ones are filtered out.

### Bringing an unseen document

The strongest move available. Take a paragraph from someone in the room, or any file the
project has never seen, and run it. A one-paragraph Mars sample-return note dropped in cold
produced:

- "Tube 21 contained a carbonate-rich mudstone weighing 14.9 grams" → **supported**, with
  the source sentence cited
- "Organic carbon was detected in **9** of the 12 tubes" → **gate 1**, `9` is not in the file
- "The organic carbon **proves life** once existed on Mars" → **gate 2**, nothing accounts
  for `proves`, `life`, `existed`

Nothing is tuned to the sample documents. Deselecting a source also works as a demo: drop
the field trial and watch claims about outdoor performance start failing.

---

## What the recorded trace shows

[`TRACE.md`](../TRACE.md), regenerate with `npm run trace`. Two loop-backs, then the cap.

**Revision 0 — 6 claims, 4 rejected.** The sabotage asked for *one* over-claim. The model
produced four:

| Claim | Gate | Why |
| --- | --- | --- |
| "a remarkable **30 percent** certified power conversion efficiency" | 1 numeric | the planted one; real figure 27.4 |
| "retained 82 percent … after just **300 hours**" | 1 numeric | source says 1,000 hours |
| "degraded below 50 percent … within **100 hours**" | 1 numeric | source says 200 hours |
| "demonstrates significant performance advantages … potential for future applications" | 2 lexical | coverage 0.23; nothing accounts for `single`, `trial`, `demonstrates`, `significant` |

Two of the three number corruptions were never requested. Make that point — it is stronger
than the planted one, because the system prompt explicitly said *"copy figures exactly,
never round, scale or invent a number"* and the model did it anyway. The instruction failed;
the check did not.

**Revisions 1 and 2 — the same laundered claim, three times.** Across all three revisions the
model keeps trying to describe the *outdoor rooftop field trial* as showing advantages
"under controlled indoor conditions" — moving the lab report's indoor caveat onto the outdoor
trial. Every number in it is real. It is rejected three times, by a different gate each time
as it rewords:

| Rev | Restated as | Caught by |
| --- | --- | --- |
| 0 | "…demonstrates significant performance advantages … in controlled indoor conditions" | gate 2, coverage 0.23 |
| 1 | "This field trial at Site 7 … under controlled indoor conditions" | gate 3 — *"states efficiency but not performance advantages or controlled indoor conditions"* |
| 2 | "Despite the performance advantages observed in controlled indoor conditions at Site 7…" | gate 2, coverage 0.44 |

**The end — the cap fires.** `MAX_REVISIONS = 3`, so the run ends with that one claim still
marked unsupported, printed as `-` in the final summary.

**Do not apologise for this.** It is the honest outcome and a better story than a clean
convergence: the system refuses to launder the claim *and* refuses to pretend it converged.
A loop with no cap would run forever; a loop that accepted the claim at the cap would be
worse than no loop at all. Just know it is coming so the `-` does not catch you off guard.

---

## Jury question 1 — how does `fact_check` decide a claim is unsupported? Show me the exact check.

Full detail in [02-fact-check.md](02-fact-check.md). The short answer:

**Three gates, in order, first failure wins. Two involve no model at all.**

**Gate 1, numeric — deterministic.** Every number in the claim must exist as a token in the
sources.

```ts
const have = new Set(numbers(corpus))
const missing = numbers(claim).filter((n) => !have.has(n))
```

Set membership, not substring — so a fabricated `90` cannot ride on a real `9`. `27.4 percent`
and `27.4%` normalise to the same token; `1,000` becomes `1000`.

**Gate 2, lexical — deterministic.** Score every source sentence by the share of the claim's
content words it contains, keep the top 3, and require that together they cover ≥ 0.5 of
those words. Below that, nothing in the corpus is even *about* this claim. Those same 3
sentences are the only evidence gate 3 is allowed to see. The gate also reports which words
nothing accounted for.

**Gate 3, entailment — `qwen2.5:3b`.** The model sees only those 3 sentences, numbered, and
must return the **index** of the one that states the claim, not a quote. It therefore cannot
cite evidence that does not exist — which is the standard failure of "quote the supporting
passage". An out-of-range index fails the claim regardless of what the model said.

If they push on "but the third gate is an LLM too" — that is the right question, and the
answer is that gates 1 and 2 are arithmetic and set intersection, they are deterministic,
and they are the ones that catch the fabricated numbers and the ungrounded prose before the
model is ever consulted. Gate 3 judges a narrow question against three sentences, not a free
association over a whole corpus.

---

## Jury question 2 — what real-world risk does this loop protect against?

**A confident, well-written summary that is not what the sources say** — and a reader with no
cheap way to notice, because the entire point of reading a summary is not reading the sources.

Make it concrete with the actual documents. The lab report says one cell hit 27.4% **indoors**
and explicitly refuses to claim outdoor performance. The field trial reports a 9% energy
advantage at **one** humid coastal site and explicitly refuses to extrapolate a lifetime
degradation rate. A fluent summariser merges those into *"perovskite tandems deliver 27.4%
efficiency in the field and degrade only 3.1% per year"* — every number real, every number
lifted out of the hedge that made it true. That is exactly what this run's model tried three
times to do.

The general shape: **fluency is not evidence.** Summarisation is precisely where a caveat
gets dropped — an indoor result becomes a field result, one site becomes a general finding,
a range becomes its best endpoint, a pilot line becomes market readiness. Downstream, in an
investment memo or a clinical brief or a compliance filing, the caveat cannot be recovered:
nobody who reads the summary knows it was ever there.

The loop makes the pipeline **fail loudly and retry** instead of silently laundering an
uncertain source into a confident sentence. And when it cannot fix it, it says so rather than
shipping it.

---

## Questions you should expect after those two

**"Why not just prompt it better?"** The system prompt already says *"copy figures exactly,
never round, scale or invent a number"* and *"keep the hedge"*. The model produced three
corrupted figures anyway, and pursued the same laundered indoor/outdoor claim across three
revisions. Prompting is a request. Verification is a check.

**"What stops it looping forever?"** `MAX_REVISIONS = 3`, and on the final revision the
prompt hardens from "rewrite or drop" to "delete outright and replace". If it still fails,
the run ends with the claim marked unsupported rather than accepted.

**"Is the pausing real or is the UI just holding output?"** Real. The graph is compiled with
`interruptBefore: ['summarize', 'fact_check']` over a `MemorySaver`, and `fact_check` loops to
itself checking one claim per execution — so it genuinely halts between individual claims and
is resumed by thread id.

**"How do I know the checker itself works?"** `npm run check` — asserts the deterministic
gates against the real source files with no model and no server, including a fabricated
figure, a rounding over-claim, an off-topic claim, and a regression case for a false rejection
that an earlier version of gate 2 produced.

**"What are its limitations?"** Gate 1 only sees digits — "most cells", "nearly all" pass
through. Gate 2 is bag-of-words, so a claim reusing source vocabulary while inverting the
meaning clears it. Gate 3 is a 3B model and will be wrong occasionally in both directions.
The design answer is the ordering: the cheap deterministic checks remove the easy failures
first, so the fallible one judges a narrow question against three sentences.
