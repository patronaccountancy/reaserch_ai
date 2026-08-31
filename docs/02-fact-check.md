# How `fact_check` decides — the exact checks

This is jury question 1. Everything here is real code from
[`lib/checks.ts`](../lib/checks.ts) and [`lib/graph.ts`](../lib/graph.ts).

---

## The shape of it

One function, `checkClaim(claim, docs, index)`, runs **three gates in order**. A claim must
clear all three. **The first failure stops the checking** and becomes the recorded reason —
so a claim rejected at gate 1 never reaches the model at all.

| Gate | Kind | Question it answers |
| --- | --- | --- |
| 1 · numeric | deterministic, no model | Does every number in this claim exist in the sources? |
| 2 · lexical | deterministic, no model | Is there anything in the sources this claim is even *about*? |
| 3 · entailment | `qwen2.5:3b` | Does a specific source sentence actually *state* this? |

**Two of the three involve no model opinion at all.** That matters: when a jury asks "how do
you know the checker isn't just another hallucination", gates 1 and 2 are arithmetic and set
intersection. They give the same answer every time and they are the ones that hold when the
model is having a bad day.

---

## Gate 1 — numeric literals

> Every number a claim asserts must exist, as a token, somewhere in the sources.

```ts
export const numbers = (s: string) =>
  (s.replace(/,(?=\d{3})/g, '').match(/\d+(?:\.\d+)?/g) ?? []).map((n) =>
    String(parseFloat(n))
  )

export function numberGate(claim: string, corpus: string) {
  const have = new Set(numbers(corpus))
  const missing = numbers(claim).filter((n) => !have.has(n))
  return { pass: missing.length === 0, missing }
}
```

Normalisation, in order: thousands separators are stripped (`1,000` → `1000`), then every
numeric literal is extracted and pushed through `parseFloat`, so `27.4 percent` and `27.4%`
produce the same token `"27.4"`.

**Set membership, not substring.** This is deliberate. A substring check would let a
fabricated `90` pass because the corpus contains `9`. Token equality does not.

### What it catches

The single most common and most dangerous hallucination: a **real finding restated with a
different number**. The claim is about the right subject, cites the right study, uses the
right units — and the figure is wrong. It is almost impossible to catch by reading, and
trivial to catch by set difference.

From the recorded run, with sabotage asking for *one* over-claim:

| Claim fragment | Missing | Source actually says |
| --- | --- | --- |
| "a remarkable **30 percent** certified power conversion efficiency" | `30` | 27.4 percent |
| "retained 82 percent … after just **300 hours**" | `300` | 1,000 hours |
| "degraded below 50 percent … within **100 hours**" | `100` | 200 hours |

Only the first was requested. **Two of the three number corruptions were never asked for** —
the model produced them on its own while being told, in its system prompt, to copy figures
exactly. That is the argument for this gate in one line: the instruction did not work, the
check did.

### Honest limitation

It only sees digits. "Most cells", "nearly all", "a majority" carry no numeric token and
sail through to gates 2 and 3. Spelled-out numbers ("twelve") likewise.

---

## Gate 2 — lexical grounding

> Retrieve the 3 best-matching source sentences; together they must account for at least
> half of the claim's content words.

```ts
export const OVERLAP_FLOOR = 0.5

export function lexicalGate(claim: string, top: { text: string }[]) {
  const want = contentWords(claim)
  const pool = new Set<string>()
  for (const s of top) for (const w of contentWords(s.text)) pool.add(w)

  const uncovered = [...want].filter((w) => !pool.has(w))
  const coverage = want.size ? (want.size - uncovered.length) / want.size : 0
  return { pass: coverage >= OVERLAP_FLOOR, best: Number(coverage.toFixed(2)), uncovered }
}
```

"Content words" means: lowercased, punctuation stripped, tokens of 3+ characters, minus a
small stopword list. Retrieval (`retrieve()`) scores every source sentence by the fraction of
the claim's content words it contains and keeps the top 3.

### Why the union, not the best single sentence

The gate originally scored against the single best-matching sentence. That **falsely rejected
legitimate claims** — a claim correctly combining two adjacent facts from one paragraph
matched neither sentence well enough on its own. In one measured run, 5 of 6 claims failed,
most of them wrongly.

It now measures coverage against the union of the retrieved top 3, with the floor raised
from 0.34 to 0.5. The union is the honest denominator because **the union is exactly what
gate 3 is shown** — asking "is there enough here to check against" should be asked of the
same evidence the checker gets. `scripts/check.ts` carries a regression case for this.

### What it catches

Fluent, on-topic, entirely ungrounded prose. The real rejection from the recorded run:

> "This single site trial **demonstrates significant performance advantages** for
> perovskite-silicon tandem cells in controlled indoor conditions, setting a new efficiency
> record and **highlighting their potential for future applications**."
>
> coverage **0.23** / 0.5 — nothing accounts for `single`, `trial`, `demonstrates`, `significant`

Nothing in that sentence is a lie you could point at. It is the kind of sentence that ends
up in a press release. The documents simply do not contain it, and set arithmetic says so.

The `uncovered` list is the most legible output in the system: it names, word by word, what
the sources do not account for. On screen those words are chipped in red.

### Honest limitation

It is bag-of-words. A claim that reuses the source's vocabulary while inverting its meaning —
"the cells did **not** retain 82 percent" — clears this gate comfortably. That is gate 3's job.

---

## Gate 3 — entailment

> The model sees only the 3 retrieved sentences, numbered, and must reply with the **index**
> of the one that states the claim.

```
Decide whether the CLAIM is fully supported by one of the numbered SENTENCES.
Supported means a sentence states it. Merely being compatible is not support.
Any extra scope, certainty or magnitude the sentence does not state = not supported.
Return JSON: {"supported": true|false, "sentence": <number>, "reason": "<12 words max>"}
```

```ts
const cited = candidates[Number(a.sentence) - 1]
const ok = !!a.supported && !!cited
```

### The design decision that matters

**It returns an index, not a quote.** The usual approach — "quote the passage that supports
this" — invites the model to hallucinate a plausible-sounding quote, which is precisely the
failure you were trying to detect. Returning an index into a list *we* built makes that
structurally impossible: the evidence either is one of three real sentences or the verdict is
rejected. An out-of-range index fails the claim regardless of what the model said.

The prompt also draws the line explicitly at **scope, certainty and magnitude**, not just
factual contradiction. "Merely being compatible is not support" is what catches the
over-claim that contains no false statement, only an unearned one.

### What it catches

The failure the deterministic gates cannot see. From the recorded run, the model tried
**three times across three revisions** to describe the *outdoor rooftop field trial* as
showing advantages "under controlled indoor conditions" — laundering the lab report's indoor
caveat onto the outdoor trial. Every number in it was real. Gate 3's verdict:

> `states efficiency but not performance advantages or controlled indoor conditions`

### Honest limitation

It is a 3-billion-parameter model and it will be wrong in both directions occasionally. This
is exactly why it is gate *three*: by the time a claim reaches it, the fabricated numbers and
the ungrounded prose are already gone, and it is judging a narrow question against three
sentences rather than free-associating over a whole corpus.

---

## What happens to a rejection

Every unsupported verdict goes into the `feedback` channel and is injected into the next
`summarize` prompt — the claim verbatim, the gate that rejected it, and the reason:

```
Your previous summary was rejected. These claims failed fact-checking:
1. "Cell B-14 achieved a remarkable 30 percent certified power conversion efficiency…"
   REJECTED (numeric gate): figure(s) 30 appear nowhere in the sources
```

The model is told to keep what passed verbatim and fix or drop the rest. On the last allowed
revision the instruction hardens to "delete outright and replace with different material",
which is what makes the loop terminate rather than oscillate.

---

## Verifying the gates without a model

```bash
npm run check
```

[`scripts/check.ts`](../scripts/check.ts) asserts the deterministic gates against the real
source files — no Ollama, no server, runs in under a second. It covers number extraction,
a fabricated figure being rejected, the classic rounding over-claim (82% reported as 95%),
a grounded claim passing, the multi-sentence claim that used to be falsely rejected, an
off-topic claim failing the floor, and `uncovered` naming the right word.

If you change a threshold or a regex, this is what tells you whether you broke something.
