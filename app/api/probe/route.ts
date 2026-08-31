import { loadSources, checkClaim } from '@/lib/graph'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * Runs one arbitrary sentence through the exact same three gates fact_check
 * uses — no graph, no summariser. Lets an audience invent a claim on the spot
 * and watch it be accepted or rejected against the documents.
 */
export async function POST(req: Request) {
  const { claim, selected = [] } = await req.json().catch(() => ({ claim: '' }))
  if (!claim?.trim()) return Response.json({ error: 'empty claim' }, { status: 400 })

  const all = await loadSources()
  const docs = selected.length ? all.filter((d) => selected.includes(d.name)) : all

  try {
    return Response.json(await checkClaim(String(claim).trim(), docs.length ? docs : all, 0))
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 })
  }
}
