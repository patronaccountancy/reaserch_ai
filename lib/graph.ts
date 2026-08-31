import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { StateGraph, Annotation, MemorySaver, START, END } from '@langchain/langgraph'
import { chat, parseJson, MODEL } from './ollama'
import {
  sentences,
  retrieve,
  numberGate,
  lexicalGate,
  numbers,
  norm,
  OVERLAP_FLOOR,
} from './checks'

export const MAX_REVISIONS = 3

export type Doc = { name: string; text: string }
export type Sent = { source: string; text: string; score: number }

/** Everything fact_check looked at for one claim — this is what the UI explains. */
export type GateDetail = {
  numeric: { claimNumbers: string[]; missing: string[]; pass: boolean }
  lexical: {
    candidates: Sent[]
    best: number
    floor: number
    uncovered: string[]
    pass: boolean | null
  }
  entailment:
    | { supported: boolean; sentence: number; reason: string; cited?: Sent }
    | null
}

export type Verdict = {
  claim: string
  index: number
  supported: boolean
  gate: 'numeric' | 'lexical' | 'entailment'
  reason: string
  evidence?: string
  evidenceSource?: string
  overlap: number
  detail: GateDetail
}

export type TraceEvent = { t: number; node: string; kind: string; [k: string]: unknown }
export type Emit = (e: Omit<TraceEvent, 't'>) => void

const S = Annotation.Root({
  selected: Annotation<string[]>,
  uploads: Annotation<Doc[]>,
  overclaim: Annotation<boolean>,
  docs: Annotation<Doc[]>,
  corpus: Annotation<string>,
  claims: Annotation<string[]>,
  cursor: Annotation<number>,
  verdicts: Annotation<Verdict[]>,
  revision: Annotation<number>,
  feedback: Annotation<Verdict[]>,
})
export type State = typeof S.State

const SUMMARISE_RULES = [
  'You are a research summariser. You may only state things the SOURCES state.',
  'Return JSON shaped {"claims": [<sentence>, <sentence>, ...]}.',
  '- Exactly 4 to 6 claims, every time, including on rewrites.',
  '- Each claim is one complete self-contained sentence of real prose.',
  '- Never emit placeholder text such as "..." or "<sentence>". Write the actual claim.',
  '- Copy figures exactly as written in the sources. Never round, scale or invent a number.',
  '- Keep the hedge: indoors stays indoors, one site stays one site, a range stays a range.',
  '- No forecasts, no "will", no "proves", no comparison the sources do not make.',
].join('\n')

const ENTAILMENT_RULES = [
  'Decide whether the CLAIM is fully supported by one of the numbered SENTENCES.',
  'Supported means a sentence states it. Merely being compatible is not support.',
  'Any extra scope, certainty or magnitude the sentence does not state = not supported.',
  'Return JSON: {"supported": true|false, "sentence": <number>, "reason": "<12 words max>"}',
].join('\n')

export const SOURCE_DIR = () => path.join(process.cwd(), 'sources')

export async function loadSources(): Promise<Doc[]> {
  const dir = SOURCE_DIR()
  const files = (await readdir(dir)).filter((f) => f.endsWith('.txt')).sort()
  return Promise.all(
    files.map(async (name) => ({ name, text: await readFile(path.join(dir, name), 'utf8') }))
  )
}

/**
 * A chosen file goes straight into the summariser prompt, so it has to fit the
 * model's context. Cap per file and in total, and report the truncation rather
 * than silently summarising only the first page.
 */
export const MAX_DOC_CHARS = 20_000
export const MAX_CORPUS_CHARS = 60_000

export function clampDocs(docs: Doc[]): (Doc & { truncated?: boolean })[] {
  let budget = MAX_CORPUS_CHARS
  return docs.map((d) => {
    const limit = Math.min(MAX_DOC_CHARS, Math.max(0, budget))
    const text = d.text.slice(0, limit)
    budget -= text.length
    return { name: d.name, text, truncated: text.length < d.text.length }
  })
}

/** Shared across requests so a paused run can be resumed by thread id. */
const checkpointer = new MemorySaver()

/**
 * The whole of fact-checking for ONE claim: gate 1, gate 2, gate 3, in order,
 * first failure wins.
 */
export async function checkClaim(
  claim: string,
  docs: Doc[],
  index: number
): Promise<Verdict> {
  const sents = sentences(docs)
  const corpus = norm(docs.map((d) => d.text).join('\n\n'))

  // GATE 1 - every numeric literal must exist as a token in the sources.
  const num = numberGate(claim, corpus)
  // GATE 2 - lexical grounding; its top 3 are the only admissible evidence.
  const candidates = retrieve(claim, sents)
  const lex = lexicalGate(claim, candidates)

  const detail: GateDetail = {
    numeric: { claimNumbers: numbers(claim), missing: num.missing, pass: num.pass },
    lexical: {
      candidates,
      best: lex.best,
      floor: OVERLAP_FLOOR,
      uncovered: lex.uncovered,
      pass: num.pass ? lex.pass : null,
    },
    entailment: null,
  }

  if (!num.pass)
    return {
      claim, index, supported: false, gate: 'numeric', overlap: lex.best, detail,
      reason: `figure(s) ${num.missing.join(', ')} appear nowhere in the sources`,
    }

  if (!lex.pass)
    return {
      claim, index, supported: false, gate: 'lexical', overlap: lex.best, detail,
      reason: `the retrieved sentences cover only ${lex.best} of the claim's content words (floor ${OVERLAP_FLOOR}); nothing accounts for ${lex.uncovered.slice(0, 4).join(', ')}`,
    }

  // GATE 3 - entailment over the retrieved sentences only. The model returns an
  // index, so it cannot cite evidence that does not exist.
  const raw = await chat(
    [
      { role: 'system', content: ENTAILMENT_RULES },
      {
        role: 'user',
        content:
          'SENTENCES:\n' +
          candidates.map((x, i) => `${i + 1}. ${x.text}`).join('\n') +
          `\n\nCLAIM: ${claim}`,
      },
    ],
    { json: true }
  )
  const a = parseJson(raw, { supported: false, sentence: 0, reason: 'unparseable verdict' })
  const cited = candidates[Number(a.sentence) - 1]
  const ok = !!a.supported && !!cited
  detail.entailment = {
    supported: !!a.supported,
    sentence: Number(a.sentence) || 0,
    reason: String(a.reason || ''),
    cited,
  }
  return {
    claim, index, supported: ok, gate: 'entailment', overlap: lex.best, detail,
    reason: ok
      ? String(a.reason || 'entailed by the cited sentence')
      : String(a.reason || 'no retrieved sentence entails the claim'),
    evidence: cited?.text,
    evidenceSource: cited?.source,
  }
}

export function buildGraph(emit: Emit, interactive = false) {
  const g = new StateGraph(S)

    // ---- node: read_source -------------------------------------------------
    .addNode('read_source', async (s: State) => {
      const all = await loadSources()
      const fromDisk = s.selected?.length ? all.filter((d) => s.selected.includes(d.name)) : []
      const uploaded = clampDocs(s.uploads ?? [])
      // Fall back to the bundled sources only when nothing at all was chosen.
      const docs = fromDisk.length || uploaded.length ? [...fromDisk, ...uploaded] : all
      const corpus = docs.map((d) => d.text).join('\n\n')
      emit({
        node: 'read_source',
        kind: 'loaded',
        files: docs.map((d) => ({
          name: d.name,
          words: d.text.trim().split(/\s+/).length,
          uploaded: uploaded.some((u) => u.name === d.name),
        })),
        sentences: sentences(docs).length,
        truncated: uploaded.filter((u) => u.truncated).map((u) => u.name),
      })
      return { docs, corpus, revision: 0, cursor: 0, verdicts: [], feedback: [] }
    })

    // ---- node: summarize ---------------------------------------------------
    .addNode('summarize', async (s: State) => {
      const revision = s.revision ?? 0
      const rejected = s.feedback ?? []
      const lastChance = revision >= MAX_REVISIONS - 1

      let user =
        'SOURCES:\n\n' + s.docs.map((d) => `--- ${d.name} ---\n${d.text}`).join('\n\n')

      if (rejected.length) {
        user +=
          '\n\nYour previous summary was rejected. These claims failed fact-checking:\n' +
          rejected
            .map((v, i) => `${i + 1}. "${v.claim}"\n   REJECTED (${v.gate} gate): ${v.reason}`)
            .join('\n') +
          '\n\nRewrite the summary. ' +
          (lastChance
            ? 'DELETE every rejected claim outright and replace it with different material from the sources.'
            : 'Delete or rewrite each rejected claim so it says only what the sources say.') +
          ' Repeat the claims that passed verbatim, and top the summary back up to 4-6' +
          ' claims using source material you have not used yet.'
      }

      // Step 4 of the brief: deliberately over-claim once, so the
      // fact_check -> summarize loop-back can be observed.
      if (revision === 0 && s.overclaim) {
        user +=
          '\n\nSABOTAGE (demo mode): also add exactly one extra claim that overstates the ' +
          'findings using an impressive, specific statistic that does NOT appear in the ' +
          'sources. Blend it in with the others. Do not flag it.'
      }

      emit({
        node: 'summarize',
        kind: 'start',
        revision,
        sabotaged: revision === 0 && !!s.overclaim,
        repairing: rejected.map((v) => ({ claim: v.claim, gate: v.gate, reason: v.reason })),
      })

      const raw = await chat(
        [
          { role: 'system', content: SUMMARISE_RULES },
          { role: 'user', content: user },
        ],
        { json: true }
      )
      const claims = (parseJson<{ claims: string[] }>(raw, { claims: [] }).claims ?? [])
        .map((c) => String(c).trim())
        .filter((c) => c && c !== '...')

      emit({ node: 'summarize', kind: 'claims', revision, claims })
      return { claims, revision, cursor: 0, verdicts: [], feedback: [] }
    })

    // ---- node: fact_check --------------------------------------------------
    // Checks exactly ONE claim per execution and loops back to itself, so a
    // presenter can pause on every individual claim.
    .addNode('fact_check', async (s: State) => {
      const cursor = s.cursor ?? 0
      const claim = s.claims[cursor]
      const prior = s.verdicts ?? []

      if (!claim) {
        emit({ node: 'fact_check', kind: 'pass_done', revision: s.revision, checked: prior.length, unsupported: 0 })
        return { feedback: [], revision: s.revision + 1 }
      }

      const v = await checkClaim(claim, s.docs, cursor)

      const verdicts = [...prior, v]
      const last = cursor + 1 >= s.claims.length
      emit({
        node: 'fact_check', kind: 'verdict', revision: s.revision,
        verdict: v, position: cursor + 1, total: s.claims.length,
      })

      if (!last) return { verdicts, cursor: cursor + 1 }

      const bad = verdicts.filter((x) => !x.supported)
      emit({
        node: 'fact_check', kind: 'pass_done', revision: s.revision,
        checked: verdicts.length, unsupported: bad.length,
      })
      return { verdicts, cursor: cursor + 1, feedback: bad, revision: s.revision + 1 }
    })

  // ---- edges ---------------------------------------------------------------
  const b = g as any
  b.addEdge(START, 'read_source')
  b.addEdge('read_source', 'summarize')
  b.addEdge('summarize', 'fact_check')
  b.addConditionalEdges(
    'fact_check',
    (s: State) => {
      // more claims left in this pass?
      if ((s.cursor ?? 0) < s.claims.length) return 'fact_check'

      const bad = (s.feedback ?? []).length
      const loop = bad > 0 && s.revision < MAX_REVISIONS
      emit({
        node: 'route', kind: 'decision', revision: s.revision, unsupported: bad,
        next: loop ? 'summarize' : 'END',
        why:
          bad === 0
            ? 'every claim passed all three gates'
            : loop
              ? `${bad} unsupported claim(s) -> loop back to summarize with the rejections attached`
              : `revision cap ${MAX_REVISIONS} reached; ending with ${bad} claim(s) still unsupported`,
      })
      return loop ? 'summarize' : END
    },
    { fact_check: 'fact_check', summarize: 'summarize', [END]: END }
  )

  return b.compile(
    interactive
      ? { checkpointer, interruptBefore: ['summarize', 'fact_check'] }
      : {}
  )
}

/** Non-interactive: run the whole thing (used by /api/run and TRACE.md). */
export async function run(
  overclaim: boolean,
  emit: Emit,
  selected: string[] = [],
  uploads: Doc[] = []
) {
  emit({ node: 'graph', kind: 'start', model: MODEL, overclaim, selected })
  const final = await buildGraph(emit).invoke(
    { overclaim, selected, uploads },
    { recursionLimit: 200 }
  )
  emit({
    node: 'graph', kind: 'done',
    revisions: final.revision, claims: final.claims, verdicts: final.verdicts,
  })
  return final
}
