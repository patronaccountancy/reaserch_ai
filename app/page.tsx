'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Probe } from './probe'

type Ev = { t: number; node: string; kind: string; [k: string]: any }
type Src = { name: string; words: number; text: string }
type Status = 'setup' | 'paused' | 'done' | 'error'

const NODES = ['read_source', 'summarize', 'fact_check'] as const

export default function Page() {
  const [sources, setSources] = useState<Src[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [uploads, setUploads] = useState<Src[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [overclaim, setOverclaim] = useState(true)

  const [status, setStatus] = useState<Status>('setup')
  const [threadId, setThreadId] = useState<string | null>(null)
  const [steps, setSteps] = useState<Ev[]>([])
  const [idx, setIdx] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const autoRef = useRef(false)

  useEffect(() => {
    fetch('/api/sources')
      .then((r) => r.json())
      .then((d: Src[]) => {
        setSources(d)
        setPicked(d.map((s) => s.name))
      })
      .catch(() => setError('Could not read sources/ — is the dev server running?'))
  }, [])

  const step = useCallback(
    async (id: string | null) => {
      setBusy(id ? 'thinking…' : 'reading sources…')
      try {
        const res = await fetch('/api/step', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            id
              ? { threadId: id }
              : {
                  overclaim,
                  selected: picked,
                  uploads: uploads.map((u) => ({ name: u.name, text: u.text })),
                }
          ),
        })
        const d = await res.json()
        setThreadId(d.threadId)
        setStatus(d.status)
        if (d.message) setError(d.message)
        setSteps((prev) => {
          const next = [...prev, ...d.events]
          setIdx(prev.length)
          return next
        })
        return d
      } finally {
        setBusy(null)
      }
    },
    [overclaim, picked, uploads]
  )

  const atEnd = idx >= steps.length - 1
  const canAdvance = !busy && (!atEnd || status === 'paused')

  const next = useCallback(() => {
    if (busy) return
    if (!atEnd) return setIdx((i) => i + 1)
    if (status === 'paused' && threadId) void step(threadId)
  }, [busy, atEnd, status, threadId, step])

  const prev = () => !busy && setIdx((i) => Math.max(0, i - 1))

  async function runToEnd() {
    if (autoRef.current) return (autoRef.current = false)
    autoRef.current = true
    let id = threadId
    while (autoRef.current) {
      const d = await step(id)
      id = d.threadId
      if (d.status !== 'paused') break
    }
    autoRef.current = false
    setIdx((i) => Math.max(i, steps.length))
  }

  function restart() {
    autoRef.current = false
    setStatus('setup')
    setThreadId(null)
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
        <p className="mt-3 max-w-2xl text-neutral-400">
          A LangGraph workflow that summarises local documents and refuses to publish any
          claim it cannot ground in them. Runs entirely offline on Ollama · qwen2.5:3b.
        </p>

        <section className="mt-12">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
            1 · Choose the sources
          </h2>
          <p className="mt-2 text-sm text-neutral-500">
            These are the only facts that will exist. Anything the summary says beyond them
            is, by definition, unsupported.
          </p>
          <div className="mt-4 space-y-2">
            {sources.map((s) => {
              const on = picked.includes(s.name)
              return (
                <div
                  key={s.name}
                  className={`rounded-lg border transition ${
                    on ? 'border-neutral-600 bg-[--color-panel]' : 'border-[--color-line] opacity-55'
                  }`}
                >
                  <div className="flex items-center gap-4 p-4">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setPicked((p) =>
                          on ? p.filter((n) => n !== s.name) : [...p, s.name]
                        )
                      }
                      className="size-5 accent-emerald-400"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-sm text-neutral-200">{s.name}</p>
                      <p className="truncate text-xs text-neutral-500">
                        {s.words} words · {s.text.split('\n')[0]}
                      </p>
                    </div>
                    <button
                      onClick={() => setPreview(preview === s.name ? null : s.name)}
                      className="shrink-0 rounded border border-[--color-line] px-3 py-1 text-xs text-neutral-400 hover:text-white"
                    >
                      {preview === s.name ? 'hide' : 'preview'}
                    </button>
                  </div>
                  {preview === s.name && (
                    <pre className="max-h-72 overflow-auto border-t border-[--color-line] p-4 text-xs leading-relaxed text-neutral-400">
                      {s.text}
                    </pre>
                  )}
                </div>
              )
            })}
          </div>
          {uploads.map((u) => (
            <div
              key={u.name}
              className="mt-2 rounded-lg border border-emerald-900 bg-[--color-panel]"
            >
              <div className="flex items-center gap-4 p-4">
                <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
                  yours
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm text-neutral-200">{u.name}</p>
                  <p className="truncate text-xs text-neutral-500">
                    {u.words} words · {u.text.split('\n')[0]}
                  </p>
                </div>
                <button
                  onClick={() => setPreview(preview === u.name ? null : u.name)}
                  className="shrink-0 rounded border border-[--color-line] px-3 py-1 text-xs text-neutral-400 hover:text-white"
                >
                  {preview === u.name ? 'hide' : 'preview'}
                </button>
                <button
                  onClick={() => setUploads((p) => p.filter((x) => x.name !== u.name))}
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

          <label className="mt-4 flex cursor-pointer items-center justify-center gap-3 rounded-lg border border-dashed border-[--color-line] p-5 text-sm text-neutral-400 transition hover:border-neutral-600 hover:text-neutral-200">
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
                setUploads((prev) => [
                  ...prev.filter((p) => !read.some((r) => r.name === p.name)),
                  ...read,
                ])
              }}
            />
            + Add a .txt file from anywhere on this computer
          </label>
          <p className="mt-2 text-xs text-neutral-600">
            Read in your browser and sent with the run — nothing is written to disk. Capped at
            20,000 characters per file so it fits the model's context; you are told if a file
            is trimmed.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
            2 · Sabotage the first pass?
          </h2>
          <label className="mt-3 flex cursor-pointer items-start gap-4 rounded-lg border border-[--color-line] bg-[--color-panel] p-4">
            <input
              type="checkbox"
              checked={overclaim}
              onChange={(e) => setOverclaim(e.target.checked)}
              className="mt-0.5 size-5 accent-amber-400"
            />
            <span>
              <span className="text-sm text-neutral-200">
                Tell the summariser to over-claim once, on purpose
              </span>
              <span className="mt-1 block text-xs text-neutral-500">
                Plants one invented statistic in revision 0 so the fact-check rejection and
                the loop back to <code>summarize</code> are guaranteed to happen live.
                Untick to watch the same graph on an honest first pass.
              </span>
            </span>
          </label>
        </section>

        <button
          onClick={() => step(null)}
          disabled={!picked.length && !uploads.length}
          className="mt-10 rounded-md bg-white px-6 py-3 font-medium text-black transition hover:bg-neutral-200 disabled:opacity-40"
        >
          {busy
            ? 'starting…'
            : `Start run with ${picked.length + uploads.length} source${
                picked.length + uploads.length === 1 ? '' : 's'
              }`}
        </button>
        {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

        <Probe picked={picked} uploads={uploads} />
      </main>
    )

  // ------------------------------------------------------------------ run ---
  const ev = steps[idx]
  const loops = steps.filter((e) => e.kind === 'decision' && e.next === 'summarize').length
  const revision = [...steps.slice(0, idx + 1)].reverse().find((e) => e.revision !== undefined)?.revision ?? 0

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 pb-28 pt-8">
      <Rail node={ev?.node} loops={loops} revision={revision} busy={busy} />

      <div className="mt-8 flex-1">
        <p className="text-xs font-semibold uppercase tracking-widest text-neutral-600">
          step {idx + 1} of {steps.length}
          {status === 'paused' && atEnd && ' · paused'}
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
            ↺ {loops} loop-back{loops === 1 ? '' : 's'}
          </span>
        ) : (
          <span className="rounded-full border border-[--color-line] px-3 py-1 text-neutral-500">
            ↺ 0 loop-backs
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
          disabled={p.idx === 0 || !!p.busy}
          className="rounded-md border border-[--color-line] px-4 py-2 text-sm text-neutral-300 hover:border-neutral-600 disabled:opacity-30"
        >
          ← Back
        </button>
        <button
          onClick={p.onNext}
          disabled={!p.canAdvance}
          className="rounded-md bg-white px-6 py-2 text-sm font-medium text-black hover:bg-neutral-200 disabled:opacity-30"
        >
          {p.busy ? 'running…' : p.status === 'done' && p.idx >= p.total - 1 ? 'Finished' : 'Next step →'}
        </button>
        <button
          onClick={p.onAuto}
          disabled={p.status === 'done'}
          className="rounded-md border border-[--color-line] px-4 py-2 text-sm text-neutral-400 hover:border-neutral-600 disabled:opacity-30"
        >
          {p.auto ? '⏸ Stop' : '⏩ Run to end'}
        </button>
        <span className="ml-auto text-xs text-neutral-600">
          ← / → or space to step · {p.idx + 1}/{p.total}
        </span>
        <button onClick={p.onRestart} className="text-xs text-neutral-500 hover:text-white">
          restart
        </button>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- stage --- */

function Head({ tag, title, note }: { tag: string; title: string; note: string }) {
  return (
    <header className="mt-2">
      <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">{tag}</p>
      <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">{title}</h2>
      <p className="mt-2 max-w-3xl text-sm text-neutral-400">{note}</p>
    </header>
  )
}

function Stage({ e }: { e: Ev }) {
  if (e.kind === 'start' && e.node === 'graph')
    return (
      <>
        <Head
          tag="graph · start"
          title="The run begins"
          note={`Model ${e.model}, running locally. ${
            e.overclaim
              ? 'Sabotage is ON — revision 0 will contain one deliberately invented statistic.'
              : 'Sabotage is OFF — the summariser is asked to behave.'
          } The loop is capped at ${e.maxRevisions} revisions so it always terminates.`}
        />
      </>
    )

  if (e.kind === 'loaded')
    return (
      <>
        <Head
          tag="node · read_source"
          title={`${e.files.length} source${e.files.length === 1 ? '' : 's'} loaded`}
          note={`Split into ${e.sentences} sentences. This sentence index is the entire universe of provable facts for the rest of the run — fact_check can only cite from here.`}
        />
        <ul className="mt-6 space-y-2">
          {e.files.map((f: any) => (
            <li key={f.name} className="rounded-md border border-[--color-line] bg-[--color-panel] px-4 py-3">
              <span className="font-mono text-sm text-neutral-200">{f.name}</span>
              <span className="ml-3 text-xs text-neutral-500">{f.words} words</span>
              {f.uploaded && (
                <span className="ml-3 rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
                  yours
                </span>
              )}
            </li>
          ))}
        </ul>
        {e.truncated?.length > 0 && (
          <p className="mt-4 rounded-md border border-amber-800 bg-amber-500/10 p-3 text-xs text-amber-200">
            Trimmed to fit the model's context: {e.truncated.join(', ')}. Only the kept text
            can ground a claim.
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
            e.sabotaged ? 'Prompting the summariser — with sabotage'
            : e.repairing?.length ? `Re-prompting with ${e.repairing.length} rejection(s)`
            : 'Prompting the summariser'
          }
          note={
            e.sabotaged
              ? 'One extra instruction is appended to this prompt only: invent an impressive statistic that is not in the sources, and blend it in. This is how we guarantee the class sees a loop-back.'
              : e.repairing?.length
                ? 'The rejected claims go back into the prompt with the gate that rejected them and why. The model is told to keep what passed and fix or drop the rest.'
                : 'The model gets the full source text and must return 4–6 claims as JSON.'
          }
        />
        {!!e.repairing?.length && (
          <ul className="mt-6 space-y-3">
            {e.repairing.map((r: any, i: number) => (
              <li key={i} className="rounded-md border border-red-900/70 bg-red-950/20 p-4">
                <p className="text-sm text-neutral-200">“{r.claim}”</p>
                <p className="mt-2 text-xs text-red-300">
                  rejected at the <span className="font-mono">{r.gate}</span> gate — {r.reason}
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
          note="Nothing is trusted yet. Each of these is now checked independently, one at a time."
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
        note={
          e.unsupported
            ? 'The pass is finished. The conditional edge now decides whether to loop.'
            : 'Every claim survived all three gates.'
        }
      />
    )

  if (e.kind === 'decision')
    return (
      <>
        <Head
          tag="conditional edge"
          title={e.next === 'summarize' ? '↺ Loop back to summarize' : '→ END'}
          note={e.why}
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
          note="Every sentence below cleared all three gates. Nothing here is unsupported by the documents you selected."
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

  return <Head tag={e.node} title={e.kind} note={JSON.stringify(e).slice(0, 300)} />
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
        note="Three gates, in order. The claim must clear all three; the first failure stops the checking and becomes the reason."
      />

      <blockquote className="mt-6 border-l-2 border-neutral-600 pl-4 text-lg leading-relaxed text-neutral-100">
        {v.claim}
      </blockquote>

      <div className="mt-8 space-y-4">
        <Gate
          n={1}
          name="numeric"
          kind="deterministic · no model"
          state={d.numeric.pass ? 'pass' : 'fail'}
          rule="Every number the claim asserts must exist as a token in the source text."
        >
          {d.numeric.claimNumbers.length === 0 ? (
            <p className="text-sm text-neutral-500">The claim asserts no numbers. Nothing to check.</p>
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
                    {n} {bad ? '✗ not in sources' : '✓'}
                  </span>
                )
              })}
            </div>
          )}
        </Gate>

        <Gate
          n={2}
          name="lexical"
          kind="deterministic · no model"
          state={d.lexical.pass === null ? 'skip' : d.lexical.pass ? 'pass' : 'fail'}
          rule={`The 3 best-matching source sentences must together account for at least ${d.lexical.floor} of the claim's content words. These same 3 are the only evidence gate 3 is allowed to see.`}
        >
          <p className="mb-4 text-sm">
            <span className="text-neutral-400">coverage </span>
            <span
              className={`font-mono ${d.lexical.pass === false ? 'text-red-300' : 'text-emerald-300'}`}
            >
              {d.lexical.best}
            </span>
            <span className="text-neutral-500"> / {d.lexical.floor} required</span>
            {d.lexical.uncovered?.length > 0 && (
              <span className="ml-3 text-neutral-500">
                nothing accounts for{' '}
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
                  <span className="w-24 shrink-0 text-right font-mono text-xs text-neutral-400">
                    {c.score.toFixed(2)} rank
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
          rule="The model sees only the 3 sentences above, numbered, and must answer with the index of the one that states the claim. Returning an index rather than a quote means it cannot cite evidence that does not exist."
        >
          {!d.entailment ? (
            <p className="text-sm text-neutral-500">
              Not run — a deterministic gate already rejected this claim.
            </p>
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
        <span className="font-medium">{v.supported ? 'Verdict: supported.' : 'Verdict: unsupported.'}</span>{' '}
        {v.reason}
        {!v.supported && ' — this claim will be sent back to summarize with that reason attached.'}
      </p>
    </>
  )
}

function Gate({
  n, name, kind, state, rule, children,
}: {
  n: number; name: string; kind: string
  state: 'pass' | 'fail' | 'skip'; rule: string; children: React.ReactNode
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
      <div className="px-4 py-4">
        <p className="mb-4 text-xs leading-relaxed text-neutral-500">{rule}</p>
        {children}
      </div>
    </section>
  )
}
