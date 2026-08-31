import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { chat, parseJson, MODEL } from './ollama'
import {
  sentences,
  retrieve,
  numberGate,
  lexicalGate,
  norm,
  OVERLAP_FLOOR,
} from './checks'

export const MAX_REVISIONS = 3

export type Doc = { name: string; text: string }
export type Verdict = {
  claim: string
  supported: boolean
  gate: 'numeric' | 'lexical' | 'entailment'
  reason: string
  evidence?: string
  evidenceSource?: string
  overlap: number
}
export type TraceEvent = { t: number; node: string; kind: string; [k: string]: unknown }
export type Emit = (e: Omit<TraceEvent, 't'>) => void

const S = Annotation.Root({
  overclaim: Annotation<boolean>,
  docs: Annotation<Doc[]>,
  corpus: Annotation<string>,
  claims: Annotation<string[]>,
  verdicts: Annotation<Verdict[]>,
  revision: Annotation<number>,
  feedback: Annotation<Verdict[]>,
})
type State = typeof S.State

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

export function buildGraph(emit: Emit) {
  const g = new StateGraph(S)

    // ---- node: read_source -------------------------------------------------
    .addNode('read_source', async () => {
      const dir = path.join(process.cwd(), 'sources')
      const files = (await readdir(dir)).filter((f) => f.endsWith('.txt')).sort()
      const docs: Doc[] = await Promise.all(
        files.map(async (name) => ({
          name,
          text: await readFile(path.join(dir, name), 'utf8'),
        }))
      )
      const corpus = docs.map((d) => d.text).join('\n\n')
      emit({
        node: 'read_source',
        kind: 'loaded',
        files: docs.map((d) => ({ name: d.name, words: d.text.trim().split(/\s+/).length })),
        sentences: sentences(docs).length,
      })
      return { docs, corpus, revision: 0, verdicts: [], feedback: [] }
    })

    // ---- node: summarize ---------------------------------------------------
    .addNode('summarize', async (s: State) => {
      const revision = s.revision ?? 0
      const rejected = s.feedback ?? []
      const lastChance = revision >= MAX_REVISIONS - 1

      let user =
        'SOURCES:\n\n' +
        s.docs.map((d) => `--- ${d.name} ---\n${d.text}`).join('\n\n')

      if (rejected.length) {
        user +=
          '\n\nYour previous summary was rejected. These claims failed fact-checking:\n' +
          rejected
            .map(
              (v, i) =>
                `${i + 1}. "${v.claim}"\n   REJECTED (${v.gate} gate): ${v.reason}`
            )
            .join('\n') +
          '\n\nRewrite the summary. ' +
          (lastChance
            ? 'DELETE every rejected claim outright.'
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
        repairing: rejected.length,
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
        .filter(Boolean)

      emit({ node: 'summarize', kind: 'claims', revision, claims })
      return { claims, revision, feedback: [] }
    })

    // ---- node: fact_check --------------------------------------------------
    .addNode('fact_check', async (s: State) => {
      const sents = sentences(s.docs)
      const corpus = norm(s.corpus)
      const verdicts: Verdict[] = []

      for (const claim of s.claims) {
        const num = numberGate(claim, corpus) // GATE 1
        const top = retrieve(claim, sents)
        const lex = lexicalGate(top) // GATE 2

        if (!num.pass) {
          verdicts.push({
            claim,
            supported: false,
            gate: 'numeric',
            overlap: lex.best,
            reason: `figure(s) ${num.missing.join(', ')} appear nowhere in the sources`,
          })
        } else if (!lex.pass) {
          verdicts.push({
            claim,
            supported: false,
            gate: 'lexical',
            overlap: lex.best,
            reason: `best source sentence covers only ${lex.best} of the claim's content words (floor ${OVERLAP_FLOOR})`,
          })
        } else {
          // GATE 3 - entailment, restricted to the retrieved sentences so the
          // model cannot cite evidence that does not exist.
          const raw = await chat(
            [
              { role: 'system', content: ENTAILMENT_RULES },
              {
                role: 'user',
                content:
                  'SENTENCES:\n' +
                  top.map((x, i) => `${i + 1}. ${x.text}`).join('\n') +
                  `\n\nCLAIM: ${claim}`,
              },
            ],
            { json: true }
          )
          const v = parseJson(raw, {
            supported: false,
            sentence: 0,
            reason: 'unparseable verdict',
          })
          const cite = top[Number(v.sentence) - 1]
          const ok = !!v.supported && !!cite
          verdicts.push({
            claim,
            supported: ok,
            gate: 'entailment',
            overlap: lex.best,
            reason: ok
              ? String(v.reason || 'entailed by the cited sentence')
              : String(v.reason || 'no retrieved sentence entails the claim'),
            evidence: cite?.text,
            evidenceSource: cite?.source,
          })
        }

        emit({
          node: 'fact_check',
          kind: 'verdict',
          revision: s.revision,
          verdict: verdicts.at(-1),
        })
      }

      const bad = verdicts.filter((v) => !v.supported)
      emit({
        node: 'fact_check',
        kind: 'summary',
        revision: s.revision,
        checked: verdicts.length,
        unsupported: bad.length,
      })
      return { verdicts, feedback: bad, revision: s.revision + 1 }
    })

  // ---- edges: read -> summarize -> fact_check -> (loop back | end) ---------
  const b = g as any
  b.addEdge(START, 'read_source')
  b.addEdge('read_source', 'summarize')
  b.addEdge('summarize', 'fact_check')
  b.addConditionalEdges(
    'fact_check',
    (s: State) => {
      const bad = (s.feedback ?? []).length
      const loop = bad > 0 && s.revision < MAX_REVISIONS
      emit({
        node: 'route',
        kind: 'decision',
        revision: s.revision,
        unsupported: bad,
        next: loop ? 'summarize' : 'END',
        why:
          bad === 0
            ? 'every claim passed all three gates'
            : loop
              ? `${bad} unsupported claim(s) -> loop back to summarize`
              : `revision cap ${MAX_REVISIONS} reached; ending with ${bad} claim(s) still unsupported`,
      })
      return loop ? 'summarize' : END
    },
    { summarize: 'summarize', [END]: END }
  )

  return b.compile()
}

export async function run(overclaim: boolean, emit: Emit) {
  emit({ node: 'graph', kind: 'start', model: MODEL, overclaim })
  const final = await buildGraph(emit).invoke({ overclaim }, { recursionLimit: 50 })
  emit({
    node: 'graph',
    kind: 'done',
    revisions: final.revision,
    claims: final.claims,
    verdicts: final.verdicts,
  })
  return final
}
