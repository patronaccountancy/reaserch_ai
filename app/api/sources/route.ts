import { loadSources } from '@/lib/graph'

export const runtime = 'nodejs'

export async function GET() {
  const docs = await loadSources()
  return Response.json(
    docs.map((d) => ({
      name: d.name,
      words: d.text.trim().split(/\s+/).length,
      text: d.text,
    }))
  )
}
