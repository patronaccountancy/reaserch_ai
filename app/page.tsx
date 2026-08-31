'use client'

import { useRef, useState } from 'react'

type Ev = { t: number; node: string; kind: string; [k: string]: any }

const NODES = ['read_source', 'summarize', 'fact_check'] as const

export default function Page() {
  const [events, setEvents] = useState<Ev[]>([])
  const [running, setRunning] = useState(false)
  const [overclaim, setOverclaim] = useState(true)
  const [active, setActive] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const done = events.find((e) => e.kind === 'done')
  const error = events.find((e) => e.kind === 'error')
  const loops = events.filter((e) => e.kind === 'decision' && e.next === 'summarize').length

  async function go() {
    setEvents([])
    setRunning(true)
    setActive(null)
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ overclaim }),
      })
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done: fin } = await reader.read()
        if (fin) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const l of lines) {
          if (!l.trim()) continue
          const ev: Ev = JSON.parse(l)
          setEvents((p) => [...p, ev])
          if ((NODES as readonly string[]).includes(ev.node)) setActive(ev.node)
          queueMicrotask(() =>
            logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
          )
        }
      }
    } finally {
      setRunning(false)
      setActive(null)
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[--color-line] pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Multi-Step Research Summarizer Graph
          </h1>
          <p className="mt-1 text-sm text-neutral-400">
            <code className="text-neutral-300">read_source → summarize → fact_check</code>, looping
            back to <code className="text-neutral-300">summarize</code> whenever a claim is not
            grounded in the local sources. Offline: Ollama + qwen2.5:3b.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-neutral-400">
            <input
              type="checkbox"
              checked={overclaim}
              onChange={(e) => setOverclaim(e.target.checked)}
              disabled={running}
              className="size-4 accent-amber-400"
            />
            sabotage first pass
          </label>
          <button
            onClick={go}
            disabled={running}
            className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-neutral-200 disabled:opacity-40"
          >
            {running ? 'running…' : 'Run graph'}
          </button>
        </div>
      </header>

      <GraphDiagram active={active} loops={loops} />

      {error && (
        <p className="mt-6 rounded-md border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">
          {error.message}
        </p>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-500">
            Annotated trace
          </h2>
          <div
            ref={logRef}
            className="h-[32rem] overflow-y-auto rounded-lg border border-[--color-line] bg-[--color-panel] p-4"
          >
            {events.length === 0 && (
              <p className="text-sm text-neutral-600">Nothing yet. Run the graph.</p>
            )}
            <ol className="space-y-3">
              {events.map((e, i) => (
                <li key={i}>
                  <TraceRow e={e} t0={events[0]?.t ?? e.t} />
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-500">
            Final summary {done ? `· ${done.revisions} pass(es) · ${loops} correction loop(s)` : ''}
          </h2>
          <div className="h-[32rem] overflow-y-auto rounded-lg border border-[--color-line] bg-[--color-panel] p-4">
            {!done && <p className="text-sm text-neutral-600">Produced when the graph ends.</p>}
            <ul className="space-y-3">
              {done?.verdicts?.map((v: any, i: number) => (
                <li key={i}>
                  <VerdictCard v={v} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      <Gates />
    </main>
  )
}

function GraphDiagram({ active, loops }: { active: string | null; loops: number }) {
  return (
    <div className="mt-8 flex flex-wrap items-center gap-3 rounded-lg border border-[--color-line] bg-[--color-panel] p-4 text-sm">
      {NODES.map((n, i) => (
        <span key={n} className="flex items-center gap-3">
          {i > 0 && <span className="text-neutral-600">→</span>}
          <span
            className={`rounded-md border px-3 py-1.5 font-mono transition ${
              active === n
                ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
                : 'border-[--color-line] text-neutral-400'
            }`}
          >
            {n}
          </span>
        </span>
      ))}
      <span className="text-neutral-600">→</span>
      <span className="rounded-md border border-[--color-line] px-3 py-1.5 font-mono text-neutral-500">
        END
      </span>
      <span
        className={`ml-auto rounded-full border px-3 py-1 text-xs ${
          loops
            ? 'border-amber-600 bg-amber-500/10 text-amber-300'
            : 'border-[--color-line] text-neutral-500'
        }`}
      >
        ↺ fact_check → summarize · {loops} loop-back{loops === 1 ? '' : 's'}
      </span>
    </div>
  )
}

function TraceRow({ e, t0 }: { e: Ev; t0: number }) {
  const ms = `+${((e.t - t0) / 1000).toFixed(1)}s`
  const tag = (
    <span className="shrink-0 font-mono text-[11px] text-neutral-600">{ms}</span>
  )
  const head = (label: string, tone = 'text-neutral-300') => (
    <div className="flex items-baseline gap-2">
      {tag}
      <span className={`font-mono text-xs ${tone}`}>{e.node}</span>
      <span className="text-sm text-neutral-400">{label}</span>
    </div>
  )

  if (e.kind === 'loaded')
    return (
      <div>
        {head(`loaded ${e.files.length} sources, ${e.sentences} sentences indexed`)}
        <p className="ml-14 mt-1 text-xs text-neutral-500">
          {e.files.map((f: any) => `${f.name} (${f.words}w)`).join(' · ')}
        </p>
      </div>
    )

  if (e.kind === 'start' && e.node === 'summarize')
    return (
      <div>
        {head(
          e.sabotaged
            ? 'pass 1 — prompt deliberately told to over-claim once'
            : e.repairing
              ? `revision ${e.revision} — repairing ${e.repairing} rejected claim(s)`
              : `revision ${e.revision}`,
          e.sabotaged ? 'text-amber-400' : 'text-neutral-300'
        )}
      </div>
    )

  if (e.kind === 'claims')
    return (
      <div>
        {head(`produced ${e.claims.length} claims`)}
        <ul className="ml-14 mt-1 space-y-1">
          {e.claims.map((c: string, i: number) => (
            <li key={i} className="text-xs text-neutral-500">
              {i + 1}. {c}
            </li>
          ))}
        </ul>
      </div>
    )

  if (e.kind === 'verdict') {
    const v = e.verdict
    return (
      <div>
        {head(
          v.supported ? `✓ supported (${v.gate})` : `✗ rejected at ${v.gate} gate`,
          v.supported ? 'text-emerald-400' : 'text-red-400'
        )}
        <p className="ml-14 mt-1 text-xs text-neutral-400">“{v.claim}”</p>
        <p className="ml-14 text-xs text-neutral-600">{v.reason}</p>
      </div>
    )
  }

  if (e.kind === 'summary')
    return head(`${e.checked} claims checked, ${e.unsupported} unsupported`)

  if (e.kind === 'decision')
    return (
      <div>
        {head(`next → ${e.next}`, e.next === 'summarize' ? 'text-amber-400' : 'text-emerald-400')}
        <p className="ml-14 text-xs text-neutral-500">{e.why}</p>
      </div>
    )

  if (e.kind === 'start' && e.node === 'graph')
    return head(`start · model ${e.model} · sabotage ${e.overclaim ? 'on' : 'off'}`)

  if (e.kind === 'done') return head('done', 'text-emerald-400')
  if (e.kind === 'error') return head(String(e.message), 'text-red-400')
  return head(e.kind)
}

function VerdictCard({ v }: { v: any }) {
  return (
    <div
      className={`rounded-md border p-3 ${
        v.supported ? 'border-[--color-line]' : 'border-red-900/70 bg-red-950/20'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className={v.supported ? 'text-emerald-400' : 'text-red-400'}>
          {v.supported ? '✓' : '✗'}
        </span>
        <p className="text-sm text-neutral-200">{v.claim}</p>
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        <span className="font-mono">{v.gate}</span> gate · overlap {v.overlap} · {v.reason}
      </p>
      {v.evidence && (
        <p className="mt-2 border-l-2 border-neutral-700 pl-3 text-xs italic text-neutral-400">
          {v.evidence}
          <span className="not-italic text-neutral-600"> — {v.evidenceSource}</span>
        </p>
      )}
    </div>
  )
}

function Gates() {
  const rows = [
    ['1 · numeric', 'deterministic', 'Every number in the claim must exist as a token in the sources. An invented “40%” dies here.'],
    ['2 · lexical', 'deterministic', 'Best-matching source sentence must share ≥ 0.34 of the claim’s content words, else nothing grounds it.'],
    ['3 · entailment', 'qwen2.5:3b', 'The model may only cite one of the 3 retrieved sentences by index — it cannot invent a quote.'],
  ]
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-500">
        How fact_check decides
      </h2>
      <div className="overflow-hidden rounded-lg border border-[--color-line]">
        {rows.map(([g, kind, why]) => (
          <div
            key={g}
            className="grid gap-1 border-b border-[--color-line] bg-[--color-panel] p-4 last:border-0 sm:grid-cols-[10rem_7rem_1fr] sm:gap-4"
          >
            <span className="font-mono text-sm text-neutral-300">{g}</span>
            <span className="text-xs text-neutral-500">{kind}</span>
            <span className="text-sm text-neutral-400">{why}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-neutral-600">
        A claim must clear all three. Any failure sends the whole summary back to{' '}
        <code>summarize</code> with the rejection reasons attached, up to 3 revisions.
      </p>
    </section>
  )
}
