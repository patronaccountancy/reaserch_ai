'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type Ev = { t: number; node: string; kind: string; [k: string]: any }
type Src = { name: string; words: number; text: string }
type Status = 'setup' | 'paused' | 'done' | 'error'

const NODES = ['read_source', 'summarize', 'fact_check'] as const

export default function Page() {
  const [chosen, setChosen] = useState<Src[]>([])
  const [preview, setPreview] = useState<string | null>(null)

  const [status, setStatus] = useState<Status>('setup')
  const [steps, setSteps] = useState<Ev[]>([])
  const [idx, setIdx] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const autoRef = useRef(false)
  const inflight = useRef(false)
  const wantNext = useRef(false)
  const stalled = useRef(false)
  const threadRef = useRef<string | null>(null)

  /**
   * Runs one graph node and appends its events. It does NOT move the cursor —
   * the presenter's position only changes when they press Next, so the next
   * node can be computed in the background while they are still talking.
   */
  const advance = useCallback(
    async (fresh: boolean) => {
      if (inflight.current) return
      inflight.current = true
      setBusy(fresh ? 'reading sources…' : 'thinking…')
      try {
        const res = await fetch('/api/step', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            fresh
              ? {
                  // Step 4 of the brief: revision 0 always over-claims once, so
                  // the fact_check -> summarize loop-back is shown live.
                  overclaim: true,
                  selected: [],
                  uploads: chosen.map((u) => ({ name: u.name, text: u.text })),
                }
              : { threadId: threadRef.current }
          ),
        })
        const d = await res.json()
        threadRef.current = d.threadId
        setStatus(d.status)
        if (d.message) setError(d.message)
        // A node that emits nothing would make the prefetch loop spin forever.
        stalled.current = !d.events?.length
        if (d.events?.length) {
          setSteps((p) => [...p, ...d.events])
          if (fresh) setIdx(0)
          else if (wantNext.current) setIdx((i) => i + 1)
        }
        wantNext.current = false
        return d
      } finally {
        inflight.current = false
        setBusy(null)
      }
    },
    [chosen]
  )

  const atEnd = idx >= steps.length - 1
  const canAdvance = !atEnd || status === 'paused'

  // Keep exactly one node ahead: the moment the presenter reaches the last
  // event we have, start computing the next one without waiting for a press.
  useEffect(() => {
    if (status !== 'paused' || !atEnd || autoRef.current) return
    if (inflight.current || stalled.current || !threadRef.current) return
    void advance(false)
  }, [status, atEnd, steps.length, idx, advance])

  const next = useCallback(() => {
    if (!atEnd) return setIdx((i) => i + 1)
    // Already at the newest event: queue the jump for when the node lands.
    if (status === 'paused') wantNext.current = true
  }, [atEnd, status])

  const prev = () => setIdx((i) => Math.max(0, i - 1))

  async function runToEnd() {
    if (autoRef.current) return (autoRef.current = false)
    autoRef.current = true
    while (autoRef.current) {
      const d = await advance(false)
      if (!d || d.status !== 'paused') break
    }
    autoRef.current = false
    setIdx(() => Math.max(0, steps.length - 1))
  }

  function restart() {
    autoRef.current = false
    inflight.current = false
    wantNext.current = false
    stalled.current = false
    threadRef.current = null
    setStatus('setup')
    setSteps([])
    setIdx(0)
    setError(null)
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (status === 'setup' || (e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next() }
      if (e.key === 'ArrowLeft') { e.preventDefault(); prev() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [next, status])

  // ---------------------------------------------------------------- setup ---
  if (status === 'setup')
    return (
      <main className="mx-auto max-w-4xl px-6 py-16">
        <h1 className="text-4xl font-semibold tracking-tight text-white">
          Multi-Step Research Summarizer Graph
        </h1>

        <div className="mt-10 space-y-2">
          {chosen.map((u) => (
            <div key={u.name} className="rounded-lg border border-neutral-600 bg-[--color-panel]">
              <div className="flex items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm text-neutral-200">{u.name}</p>
                  <p className="text-xs text-neutral-500">{u.words} words</p>
                </div>
                <button
                  onClick={() => setPreview(preview === u.name ? null : u.name)}
                  className="shrink-0 rounded border border-[--color-line] px-3 py-1 text-xs text-neutral-400 hover:text-white"
                >
                  {preview === u.name ? 'hide' : 'preview'}
                </button>
                <button
                  onClick={() => setChosen((p) => p.filter((x) => x.name !== u.name))}
                  className="shrink-0 rounded border border-[--color-line] px-3 py-1 text-xs text-neutral-500 hover:border-red-800 hover:text-red-300"
                >
                  remove
                </button>
              </div>
              {preview === u.name && (
                <pre className="max-h-72 overflow-auto border-t border-[--color-line] p-4 text-xs leading-relaxed text-neutral-400">
                  {u.text}
                </pre>
              )}
            </div>
          ))}
        </div>

        <label className="mt-4 flex cursor-pointer items-center justify-center gap-3 rounded-lg border border-dashed border-[--color-line] p-6 text-sm text-neutral-400 transition hover:border-neutral-600 hover:text-neutral-200">
          <input
            type="file"
            accept=".txt,.md,text/plain,text/markdown"
            multiple
            className="hidden"
            onChange={async (e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              const read = await Promise.all(
                files.map(async (f) => {
                  const text = await f.text()
                  return { name: f.name, words: text.trim().split(/\s+/).length, text }
                })
              )
              setChosen((prev) => [
                ...prev.filter((p) => !read.some((r) => r.name === p.name)),
                ...read,
              ])
            }}
          />
          {chosen.length ? 'Choose another file' : 'Choose a .txt file'}
        </label>

        <button
          onClick={() => advance(true)}
          disabled={!chosen.length || !!busy}
          className="mt-8 rounded-md bg-white px-6 py-3 font-medium text-black transition hover:bg-neutral-200 disabled:opacity-40"
        >
          {busy ? 'starting…' : 'Start run'}
        </button>
        {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      </main>
    )

  // ------------------------------------------------------------------ run ---
  const ev = steps[idx]
  const loops = steps.filter((e) => e.kind === 'decision' && e.next === 'summarize').length
  const revision =
    [...steps.slice(0, idx + 1)].reverse().find((e) => e.revision !== undefined)?.revision ?? 0

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 pb-28 pt-8">
      <Rail node={ev?.node} loops={loops} revision={revision} busy={busy} />

      <div className="mt-8 flex-1">
        <p className="text-xs font-semibold uppercase tracking-widest text-neutral-600">
          step {idx + 1} of {steps.length}
          {busy && <span className="ml-2 animate-pulse text-emerald-500">{busy}</span>}
        </p>
        {ev && <Stage e={ev} />}
        {error && (
          <p className="mt-6 rounded-md border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">
            {error}
          </p>
        )}
      </div>

      <Controls
        idx={idx} total={steps.length} busy={busy} status={status}
        canAdvance={canAdvance} onPrev={prev} onNext={next}
        onAuto={runToEnd} onRestart={restart} auto={autoRef.current}
      />
    </main>
  )
}

/* ---------------------------------------------------------------- chrome --- */

function Rail({
  node, loops, revision, busy,
}: { node?: string; loops: number; revision: number; busy: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[--color-line] bg-[--color-panel] px-4 py-3 text-sm">
      {NODES.map((n, i) => (
        <span key={n} className="flex items-center gap-2">
          {i > 0 && <span className="text-neutral-700">→</span>}
          <span
            className={`rounded-md border px-3 py-1.5 font-mono text-xs transition ${
              node === n
                ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
                : 'border-[--color-line] text-neutral-500'
            }`}
          >
            {n}
          </span>
        </span>
      ))}
      <span className="text-neutral-700">→</span>
      <span className="rounded-md border border-[--color-line] px-3 py-1.5 font-mono text-xs text-neutral-600">
        END
      </span>
      <span className="ml-auto flex items-center gap-3 text-xs">
        {busy && <span className="animate-pulse text-emerald-400">{busy}</span>}
        <span className="text-neutral-500">revision {revision}</span>
        {loops ? (
          <span className="rounded-full border border-amber-600 bg-amber-500/10 px-3 py-1 text-amber-300">
            {loops} loop-back{loops === 1 ? '' : 's'}
          </span>
        ) : (
          <span className="rounded-full border border-[--color-line] px-3 py-1 text-neutral-500">
            0 loop-backs
          </span>
        )}
      </span>
    </div>
  )
}

function Controls(p: {
  idx: number; total: number; busy: string | null; status: Status
  canAdvance: boolean; auto: boolean
  onPrev(): void; onNext(): void; onAuto(): void; onRestart(): void
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 border-t border-[--color-line] bg-[--color-ink]/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-4">
        <button
          onClick={p.onPrev}
          disabled={p.idx === 0}
          className="rounded-md border border-[--color-line] px-4 py-2 text-sm text-neutral-300 hover:border-neutral-600 disabled:opacity-30"
        >
          Back
        </button>
        <button
          onClick={p.onNext}
          disabled={!p.canAdvance}
          className="rounded-md bg-white px-6 py-2 text-sm font-medium text-black hover:bg-neutral-200 disabled:opacity-30"
        >
          {p.status === 'done' && p.idx >= p.total - 1 ? 'Finished' : 'Next step'}
        </button>
        <button
          onClick={p.onAuto}
          disabled={p.status === 'done'}
          className="rounded-md border border-[--color-line] px-4 py-2 text-sm text-neutral-400 hover:border-neutral-600 disabled:opacity-30"
        >
          {p.auto ? 'Stop' : 'Run to end'}
        </button>
        <span className="ml-auto text-xs text-neutral-600">
          {p.idx + 1}/{p.total}
        </span>
        <button onClick={p.onRestart} className="text-xs text-neutral-500 hover:text-white">
          restart
        </button>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- stage --- */

function Head({ tag, title }: { tag: string; title: string }) {
  return (
    <header className="mt-2">
      <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">{tag}</p>
      <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">{title}</h2>
    </header>
  )
}

function Stage({ e }: { e: Ev }) {
  if (e.kind === 'start' && e.node === 'graph')
    return <Head tag="graph · start" title={`The run begins · ${e.model}`} />

  if (e.kind === 'loaded')
    return (
      <>
        <Head
          tag="node · read_source"
          title={`${e.files.length} source${e.files.length === 1 ? '' : 's'} loaded · ${e.sentences} sentences`}
        />
        <ul className="mt-6 space-y-2">
          {e.files.map((f: any) => (
            <li key={f.name} className="rounded-md border border-[--color-line] bg-[--color-panel] px-4 py-3">
              <span className="font-mono text-sm text-neutral-200">{f.name}</span>
              <span className="ml-3 text-xs text-neutral-500">{f.words} words</span>
            </li>
          ))}
        </ul>
        {e.truncated?.length > 0 && (
          <p className="mt-4 rounded-md border border-amber-800 bg-amber-500/10 p-3 text-xs text-amber-200">
            trimmed to fit the model context: {e.truncated.join(', ')}
          </p>
        )}
      </>
    )

  if (e.kind === 'start' && e.node === 'summarize')
    return (
      <>
        <Head
          tag={`node · summarize · revision ${e.revision}`}
          title={
            e.repairing?.length
              ? `Re-prompting with ${e.repairing.length} rejection${e.repairing.length === 1 ? '' : 's'}`
              : 'Prompting the summariser'
          }
        />
        {!!e.repairing?.length && (
          <ul className="mt-6 space-y-3">
            {e.repairing.map((r: any, i: number) => (
              <li key={i} className="rounded-md border border-red-900/70 bg-red-950/20 p-4">
                <p className="text-sm text-neutral-200">{r.claim}</p>
                <p className="mt-2 text-xs text-red-300">
                  <span className="font-mono">{r.gate}</span> gate — {r.reason}
                </p>
              </li>
            ))}
          </ul>
        )}
      </>
    )

  if (e.kind === 'claims')
    return (
      <>
        <Head
          tag={`node · summarize · revision ${e.revision}`}
          title={`${e.claims.length} claims produced`}
        />
        <ol className="mt-6 space-y-3">
          {e.claims.map((c: string, i: number) => (
            <li key={i} className="flex gap-4 rounded-md border border-[--color-line] bg-[--color-panel] p-4">
              <span className="font-mono text-sm text-neutral-600">{i + 1}</span>
              <p className="text-sm leading-relaxed text-neutral-200">{c}</p>
            </li>
          ))}
        </ol>
      </>
    )

  if (e.kind === 'verdict') return <VerdictStage e={e} />

  if (e.kind === 'pass_done')
    return (
      <Head
        tag={`node · fact_check · revision ${e.revision}`}
        title={`${e.checked} claims checked · ${e.unsupported} unsupported`}
      />
    )

  if (e.kind === 'decision')
    return (
      <>
        <Head
          tag="conditional edge"
          title={e.next === 'summarize' ? 'Loop back to summarize' : 'END'}
        />
        <div
          className={`mt-6 rounded-lg border p-6 font-mono text-sm ${
            e.next === 'summarize'
              ? 'border-amber-600 bg-amber-500/10 text-amber-200'
              : 'border-emerald-700 bg-emerald-500/10 text-emerald-200'
          }`}
        >
          fact_check → {e.next}
          <span className="ml-4 opacity-70">({e.unsupported} unsupported this pass)</span>
        </div>
      </>
    )

  if (e.kind === 'done')
    return (
      <>
        <Head
          tag="graph · END"
          title={`Final summary after ${e.revisions} pass${e.revisions === 1 ? '' : 'es'}`}
        />
        <ul className="mt-6 space-y-3">
          {(e.verdicts ?? []).map((v: any, i: number) => (
            <li
              key={i}
              className={`rounded-md border p-4 ${
                v.supported ? 'border-[--color-line] bg-[--color-panel]' : 'border-red-900/70 bg-red-950/20'
              }`}
            >
              <p className="text-sm leading-relaxed text-neutral-100">
                <span className={v.supported ? 'text-emerald-400' : 'text-red-400'}>
                  {v.supported ? '✓ ' : '✗ '}
                </span>
                {v.claim}
              </p>
              {v.evidence && (
                <p className="mt-3 border-l-2 border-neutral-700 pl-3 text-xs italic text-neutral-400">
                  {v.evidence}
                  <span className="not-italic text-neutral-600"> — {v.evidenceSource}</span>
                </p>
              )}
            </li>
          ))}
        </ul>
      </>
    )

  return <Head tag={e.node} title={e.kind} />
}

/* --------------------------------------------------------------- verdict --- */

function VerdictStage({ e }: { e: Ev }) {
  const v = e.verdict
  const d = v.detail

  return (
    <>
      <Head
        tag={`node · fact_check · claim ${e.position} of ${e.total}`}
        title={v.supported ? 'Supported' : `Rejected at the ${v.gate} gate`}
      />

      <blockquote className="mt-6 border-l-2 border-neutral-600 pl-4 text-lg leading-relaxed text-neutral-100">
        {v.claim}
      </blockquote>

      <div className="mt-8 space-y-4">
        <Gate n={1} name="numeric" kind="deterministic" state={d.numeric.pass ? 'pass' : 'fail'}>
          {d.numeric.claimNumbers.length === 0 ? (
            <p className="text-sm text-neutral-500">no numbers asserted</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {d.numeric.claimNumbers.map((n: string, i: number) => {
                const bad = d.numeric.missing.includes(n)
                return (
                  <span
                    key={i}
                    className={`rounded px-2.5 py-1 font-mono text-sm ${
                      bad
                        ? 'bg-red-500/15 text-red-300 line-through'
                        : 'bg-emerald-500/10 text-emerald-300'
                    }`}
                  >
                    {n} {bad ? '✗' : '✓'}
                  </span>
                )
              })}
            </div>
          )}
        </Gate>

        <Gate
          n={2}
          name="lexical"
          kind="deterministic"
          state={d.lexical.pass === null ? 'skip' : d.lexical.pass ? 'pass' : 'fail'}
        >
          <p className="mb-4 text-sm">
            <span className="text-neutral-400">coverage </span>
            <span
              className={`font-mono ${d.lexical.pass === false ? 'text-red-300' : 'text-emerald-300'}`}
            >
              {d.lexical.best}
            </span>
            <span className="text-neutral-500"> / {d.lexical.floor}</span>
            {d.lexical.uncovered?.length > 0 && (
              <span className="ml-3 text-neutral-500">
                unaccounted{' '}
                {d.lexical.uncovered.slice(0, 6).map((w: string) => (
                  <span key={w} className="mr-1 rounded bg-red-500/15 px-1.5 py-0.5 font-mono text-xs text-red-300">
                    {w}
                  </span>
                ))}
              </span>
            )}
          </p>
          <div className="space-y-2">
            {d.lexical.candidates.map((c: any, i: number) => (
              <div key={i} className="rounded border border-[--color-line] p-3">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-neutral-500">{i + 1}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded bg-neutral-800">
                    <div
                      className="h-full bg-neutral-500"
                      style={{ width: `${Math.min(100, c.score * 100)}%` }}
                    />
                  </div>
                  <span className="w-16 shrink-0 text-right font-mono text-xs text-neutral-400">
                    {c.score.toFixed(2)}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-neutral-400">
                  {c.text}
                  <span className="text-neutral-600"> — {c.source}</span>
                </p>
              </div>
            ))}
          </div>
        </Gate>

        <Gate
          n={3}
          name="entailment"
          kind="qwen2.5:3b"
          state={!d.entailment ? 'skip' : v.supported ? 'pass' : 'fail'}
        >
          {!d.entailment ? (
            <p className="text-sm text-neutral-500">not run</p>
          ) : (
            <>
              <pre className="overflow-x-auto rounded bg-black/40 p-3 font-mono text-xs text-neutral-300">
{JSON.stringify(
  { supported: d.entailment.supported, sentence: d.entailment.sentence, reason: d.entailment.reason },
  null,
  2
)}
              </pre>
              {d.entailment.cited && (
                <p className="mt-3 border-l-2 border-neutral-600 pl-3 text-sm italic text-neutral-300">
                  {d.entailment.cited.text}
                  <span className="not-italic text-neutral-600"> — {d.entailment.cited.source}</span>
                </p>
              )}
            </>
          )}
        </Gate>
      </div>

      <p
        className={`mt-6 rounded-md border p-4 text-sm ${
          v.supported
            ? 'border-emerald-800 bg-emerald-500/5 text-emerald-200'
            : 'border-red-900 bg-red-950/20 text-red-200'
        }`}
      >
        {v.reason}
      </p>
    </>
  )
}

function Gate({
  n, name, kind, state, children,
}: {
  n: number; name: string; kind: string
  state: 'pass' | 'fail' | 'skip'; children: React.ReactNode
}) {
  const tone =
    state === 'pass' ? 'border-emerald-800' : state === 'fail' ? 'border-red-900' : 'border-[--color-line]'
  const badge =
    state === 'pass'
      ? 'bg-emerald-500/15 text-emerald-300'
      : state === 'fail'
        ? 'bg-red-500/15 text-red-300'
        : 'bg-neutral-800 text-neutral-500'

  return (
    <section className={`rounded-lg border bg-[--color-panel] ${tone} ${state === 'skip' ? 'opacity-60' : ''}`}>
      <header className="flex flex-wrap items-center gap-3 border-b border-[--color-line] px-4 py-3">
        <span className="font-mono text-sm text-neutral-200">
          gate {n} · {name}
        </span>
        <span className="text-xs text-neutral-500">{kind}</span>
        <span className={`ml-auto rounded px-2.5 py-1 text-xs font-medium uppercase ${badge}`}>
          {state === 'skip' ? 'not run' : state}
        </span>
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
  )
}
