import { run } from '@/lib/graph'

export const runtime = 'nodejs'
export const maxDuration = 300

/** Streams the graph trace as newline-delimited JSON, one event per line. */
export async function POST(req: Request) {
  const { overclaim = true, selected = [], uploads = [] } =
    await req.json().catch(() => ({}))
  const enc = new TextEncoder()

  const stream = new ReadableStream({
    async start(c) {
      const send = (e: Record<string, unknown>) =>
        c.enqueue(enc.encode(JSON.stringify({ t: Date.now(), ...e }) + '\n'))
      try {
        await run(!!overclaim, send, selected, uploads)
      } catch (err) {
        send({ node: 'graph', kind: 'error', message: (err as Error).message })
      }
      c.close()
    },
  })

  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
  })
}
