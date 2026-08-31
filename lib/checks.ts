// Deterministic (no-LLM) grounding checks used by the fact_check node.
// Everything here is pure and unit-tested by scripts/check.ts.

const STOP = new Set(
  ('a an and are as at be been by for from has have in into is it its of on or that the their there these this to was were will with than then over under across'
  ).split(' ')
)

export const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Split the corpus into sentences, keeping the file each one came from. */
export function sentences(docs: { name: string; text: string }[]) {
  return docs.flatMap((d) =>
    d.text
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
      .map((s) => s.trim())
      .filter((s) => s.split(' ').length >= 4)
      .map((text) => ({ source: d.name, text }))
  )
}

export const contentWords = (s: string) =>
  new Set(
    norm(s)
      .replace(/[^a-z0-9.% ]/g, ' ')
      .split(' ')
      .filter((w) => w.length > 2 && !STOP.has(w))
  )

/**
 * GATE 1 — every numeric literal asserted by a claim must exist, as a token,
 * somewhere in the sources. "27.4" passes, an invented "40" does not.
 */
export const numbers = (s: string) =>
  (s.replace(/,(?=\d{3})/g, '').match(/\d+(?:\.\d+)?/g) ?? []).map((n) =>
    String(parseFloat(n))
  )

export function numberGate(claim: string, corpus: string) {
  const have = new Set(numbers(corpus))
  const missing = numbers(claim).filter((n) => !have.has(n))
  return { pass: missing.length === 0, missing }
}

/**
 * GATE 2 — lexical grounding. Rank source sentences by the share of the
 * claim's content words they contain; the best one must clear FLOOR.
 */
export const OVERLAP_FLOOR = 0.34

export function retrieve(
  claim: string,
  sents: { source: string; text: string }[],
  k = 3
) {
  const want = contentWords(claim)
  const scored = sents
    .map((s) => {
      const have = contentWords(s.text)
      let hit = 0
      for (const w of want) if (have.has(w)) hit++
      return { ...s, score: want.size ? hit / want.size : 0 }
    })
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

export function lexicalGate(top: { score: number }[]) {
  const best = top[0]?.score ?? 0
  return { pass: best >= OVERLAP_FLOOR, best: Number(best.toFixed(2)) }
}
