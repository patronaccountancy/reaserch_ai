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
      // Split paragraphs first, so a document header never gets glued onto the
      // first real sentence — evidence quotes are read aloud, keep them clean.
      .split(/\n\s*\n/)
      .flatMap((para) =>
        para
          .replace(/\s+/g, ' ')
          .trim()
          .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
      )
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
 * GATE 2 — lexical grounding. Retrieve the best source sentences, then require
 * that together they account for at least FLOOR of the claim's content words.
 *
 * Coverage is measured against the *union* of the retrieved sentences, not the
 * single best one, because that union is exactly what gate 3 is shown. Scoring
 * against one sentence rejected legitimate claims that correctly combine two
 * adjacent facts from a source.
 */
export const OVERLAP_FLOOR = 0.5

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

export function lexicalGate(claim: string, top: { text: string }[]) {
  const want = contentWords(claim)
  const pool = new Set<string>()
  for (const s of top) for (const w of contentWords(s.text)) pool.add(w)

  const uncovered = [...want].filter((w) => !pool.has(w))
  const coverage = want.size ? (want.size - uncovered.length) / want.size : 0
  return {
    pass: coverage >= OVERLAP_FLOOR,
    best: Number(coverage.toFixed(2)),
    uncovered,
  }
}
