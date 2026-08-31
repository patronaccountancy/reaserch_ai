'use client'

import { useState } from 'react'

const PROMPTS = [
  'Perovskite tandem cells now reach 40 percent efficiency.',
  'Cell B-14 reached 27.4 percent efficiency.',
  'Perovskite modules are ready for commercial rooftop deployment.',
]

/**
 * The same three gates fact_check uses, driven by whatever the room shouts out.
 * Fastest way to answer "how does it decide?" — let someone try to sneak one past it.
 */
export function Probe({
  uploads = [],
}: {
  uploads?: { name: string; text: string }[]
}) {
  const [claim, setClaim] = useState('')
  const [v, setV] = useState<any>(null)
  const [busy, setBusy] = useState(false)

  async function ask(text = claim) {
    if (!text.trim() || busy) return
    setBusy(true)
    setV(null)
    try {
      const res = await fetch('/api/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          claim: text,
          selected: [],
          uploads: uploads.map((u) => ({ name: u.name, text: u.text })),
        }),
      })
      setV(await res.json())
    } catch {
      setV({ error: 'Request failed — is Ollama running?' })
    } finally {
      setBusy(false)
    }
  }

  const gates = v?.detail
    ? ([
        [
          '1 · numeric',
          v.detail.numeric.pass,
          v.detail.numeric.missing.length
            ? `${v.detail.numeric.missing.join(', ')} not in sources`
            : `${v.detail.numeric.claimNumbers.length} figure(s) verified`,
        ],
        [
          '2 · lexical',
          v.detail.lexical.pass,
          `best overlap ${v.detail.lexical.best} · floor ${v.detail.lexical.floor}`,
        ],
        [
          '3 · entailment',
          v.detail.entailment ? v.detail.entailment.supported : null,
          v.detail.entailment ? v.detail.entailment.reason : 'not run',
        ],
      ] as [string, boolean | null, string][])
    : []

  return (
    <section className="mt-16 border-t border-[--color-line] pt-10">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
        Try to sneak one past it
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-neutral-500">
        Type any sentence. It runs through the identical three gates{' '}
        <code className="text-neutral-400">fact_check</code> uses inside the graph, with no
        summariser involved. Hand this to the room.
      </p>

      <div className="mt-4 flex gap-2">
        <input
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          placeholder="e.g. Perovskite cells last 25 years outdoors."
          className="flex-1 rounded-md border border-[--color-line] bg-[--color-panel] px-4 py-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-500"
        />
        <button
          onClick={() => ask()}
          disabled={busy || !claim.trim()}
          className="rounded-md border border-neutral-600 px-5 text-sm text-neutral-200 transition hover:bg-neutral-800 disabled:opacity-30"
        >
          {busy ? 'checking…' : 'Check'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {PROMPTS.map((p) => (
          <button
            key={p}
            onClick={() => {
              setClaim(p)
              void ask(p)
            }}
            className="rounded-full border border-[--color-line] px-3 py-1 text-xs text-neutral-400 transition hover:border-neutral-600 hover:text-neutral-200"
          >
            {p}
          </button>
        ))}
      </div>

      {v?.error && <p className="mt-4 text-sm text-red-400">{v.error}</p>}

      {v?.detail && (
        <div className="mt-6">
          <p
            className={`rounded-md border p-4 text-sm ${
              v.supported
                ? 'border-emerald-800 bg-emerald-500/5 text-emerald-100'
                : 'border-red-900 bg-red-950/20 text-red-100'
            }`}
          >
            <span className="font-medium">
              {v.supported ? '✓ Supported' : `✗ Rejected at the ${v.gate} gate`}
            </span>{' '}
            — {v.reason}
          </p>

          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {gates.map(([label, pass, note]) => (
              <div
                key={label}
                className={`rounded-md border p-3 ${
                  pass === null
                    ? 'border-[--color-line] opacity-60'
                    : pass
                      ? 'border-emerald-800'
                      : 'border-red-900'
                }`}
              >
                <p className="font-mono text-xs text-neutral-300">{label}</p>
                <p className="mt-1 text-xs text-neutral-500">{note}</p>
              </div>
            ))}
          </div>

          {v.evidence && (
            <p className="mt-4 border-l-2 border-neutral-600 pl-3 text-xs italic text-neutral-400">
              {v.evidence}
              <span className="not-italic text-neutral-600"> — {v.evidenceSource}</span>
            </p>
          )}
        </div>
      )}
    </section>
  )
}
