// Self-check for the two deterministic fact-check gates. No LLM, no server.
//   node --experimental-strip-types scripts/check.ts
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  numberGate,
  retrieve,
  lexicalGate,
  sentences,
  numbers,
  OVERLAP_FLOOR,
} from '../lib/checks.ts'

const dir = path.join(process.cwd(), 'sources')
const docs = readdirSync(dir)
  .filter((f) => f.endsWith('.txt'))
  .map((name) => ({ name, text: readFileSync(path.join(dir, name), 'utf8') }))
const corpus = docs.map((d) => d.text).join('\n\n')
const sents = sentences(docs)

// --- number extraction ------------------------------------------------------
assert.deepEqual(numbers('27.4 percent after 1,000 hours'), ['27.4', '1000'])
assert.deepEqual(numbers('no digits here'), [])

// --- GATE 1: numeric --------------------------------------------------------
assert.equal(numberGate('Cell B-14 reached 27.4 percent efficiency.', corpus).pass, true)
const over = numberGate('Perovskite tandems now reach 40 percent efficiency.', corpus)
assert.equal(over.pass, false, 'invented figure must be rejected')
assert.deepEqual(over.missing, ['40'])
// the classic rounding over-claim: 82% retention reported as 95%
assert.equal(numberGate('Cells retained 95 percent of efficiency.', corpus).pass, false)

// --- GATE 2: lexical --------------------------------------------------------
const grounded = retrieve('The tandem string produced 9 percent more energy per installed watt-peak.', sents)
assert.equal(lexicalGate(grounded).pass, true)
assert.match(grounded[0].source, /field-trial/)

const offTopic = retrieve('Lithium-ion battery cathodes use nickel manganese cobalt chemistry.', sents)
assert.equal(lexicalGate(offTopic).pass, false, 'off-topic claim must fail the overlap floor')
assert.ok(lexicalGate(offTopic).best < OVERLAP_FLOOR)

// --- retrieval is ordered and bounded ---------------------------------------
assert.equal(grounded.length, 3)
assert.ok(grounded[0].score >= grounded[1].score)

console.log(`ok — ${sents.length} sentences indexed from ${docs.length} sources, all gate checks pass`)
