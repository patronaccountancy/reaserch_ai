import { buildGraph, MAX_REVISIONS, type TraceEvent } from '@/lib/graph'
import { MODEL } from '@/lib/ollama'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * Advances the graph by exactly one node and stops. The graph is compiled with
 * `interruptBefore: ['summarize', 'fact_check']` over a MemorySaver, so a run is
 * resumed by its thread id — no state is kept in this route.
 *
 * POST {}                          -> starts a run, returns its threadId
 * POST { threadId }                -> runs the next node
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const events: TraceEvent[] = []
  const emit = (e: Record<string, unknown>) => events.push({ t: Date.now(), ...e } as TraceEvent)

  const graph = buildGraph(emit, true)
  const fresh = !body.threadId
  const threadId: string = body.threadId ?? crypto.randomUUID()
  const config = { configurable: { thread_id: threadId }, recursionLimit: 200 }

  try {
    if (fresh) {
      emit({
        node: 'graph', kind: 'start', model: MODEL,
        overclaim: !!body.overclaim, selected: body.selected ?? [],
        maxRevisions: MAX_REVISIONS,
      })
      await graph.invoke(
        {
          overclaim: !!body.overclaim,
          selected: body.selected ?? [],
          uploads: body.uploads ?? [],
        },
        config
      )
    } else {
      await graph.invoke(null, config)
    }
  } catch (err) {
    return Response.json({
      threadId, events, status: 'error', next: null,
      message: (err as Error).message,
    })
  }

  const snap = await graph.getState(config)
  const next: string | null = snap.next?.[0] ?? null
  const v = snap.values ?? {}

  if (!next) {
    emit({
      node: 'graph', kind: 'done',
      revisions: v.revision, claims: v.claims, verdicts: v.verdicts,
    })
  }

  return Response.json({
    threadId,
    events,
    status: next ? 'paused' : 'done',
    next,
    state: {
      revision: v.revision ?? 0,
      cursor: v.cursor ?? 0,
      claims: v.claims ?? [],
      verdicts: v.verdicts ?? [],
      files: (v.docs ?? []).map((d: { name: string }) => d.name),
    },
  })
}
