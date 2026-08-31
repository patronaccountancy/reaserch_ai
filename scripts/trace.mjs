// Runs the graph against a running dev server and prints the annotated trace.
//   npm run dev          (in one terminal)
//   npm run trace        (in another)  -> stdout + TRACE.md
import { writeFileSync } from 'node:fs'

const URL = process.env.APP_URL ?? 'http://localhost:3000'
const overclaim = !process.argv.includes('--no-sabotage')

const res = await fetch(`${URL}/api/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ overclaim }),
}).catch(() => null)

if (!res?.ok) {
  console.error(`cannot reach ${URL}/api/run — start the app with \`npm run dev\` first`)
  process.exit(1)
}

const out = []
const say = (s) => { console.log(s); out.push(s) }

let t0 = 0
const reader = res.body.getReader()
const dec = new TextDecoder()
let buf = ''
for (;;) {
  const { value, done } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  const lines = buf.split('\n')
  buf = lines.pop()
  for (const l of lines) {
    if (!l.trim()) continue
    const e = JSON.parse(l)
    t0 ||= e.t
    const at = `+${((e.t - t0) / 1000).toFixed(1)}s`.padStart(7)
    const at2 = `${at}  ${e.node.padEnd(12)}`

    if (e.kind === 'start' && e.node === 'graph')
      say(`\n${at2} START  model=${e.model}  sabotage=${e.overclaim}`)
    else if (e.kind === 'loaded')
      say(`${at2} loaded ${e.files.length} sources (${e.files.map((f) => f.name).join(', ')}), ${e.sentences} sentences indexed`)
    else if (e.kind === 'start' && e.node === 'summarize')
      say(`\n${at2} revision ${e.revision}${e.sabotaged ? '  << prompt deliberately told to over-claim once' : ''}${e.repairing ? `  << repairing ${e.repairing} rejected claim(s)` : ''}`)
    else if (e.kind === 'claims')
      say(e.claims.map((c, i) => `${' '.repeat(21)}${i + 1}. ${c}`).join('\n'))
    else if (e.kind === 'verdict') {
      const v = e.verdict
      say(`${at2} ${v.supported ? 'PASS' : 'FAIL'} [${v.gate}] ${v.claim}`)
      say(`${' '.repeat(21)}${v.supported ? '' : '^ '}${v.reason}`)
      if (v.evidence) say(`${' '.repeat(21)}evidence (${v.evidenceSource}): "${v.evidence}"`)
    } else if (e.kind === 'summary')
      say(`${at2} ${e.checked} claims checked, ${e.unsupported} unsupported`)
    else if (e.kind === 'decision')
      say(`${at2} ROUTE -> ${e.next}   (${e.why})`)
    else if (e.kind === 'done') {
      say(`\n${at2} DONE after ${e.revisions} pass(es)`)
      say('\nFINAL SUMMARY')
      for (const v of e.verdicts) say(`  ${v.supported ? '+' : '-'} ${v.claim}`)
    } else if (e.kind === 'error') say(`${at2} ERROR ${e.message}`)
  }
}

writeFileSync('TRACE.md', '```\n' + out.join('\n') + '\n```\n')
console.log('\nwrote TRACE.md')
