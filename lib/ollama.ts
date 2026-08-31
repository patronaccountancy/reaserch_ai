const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434'
export const MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:3b'

type Msg = { role: 'system' | 'user'; content: string }

export async function chat(messages: Msg[], opts: { json?: boolean } = {}) {
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      format: opts.json ? 'json' : undefined,
      options: { temperature: 0 },
    }),
  })
  if (!res.ok) {
    throw new Error(
      `Ollama ${res.status}: ${await res.text()} — is \`ollama serve\` running and \`${MODEL}\` pulled?`
    )
  }
  const data = await res.json()
  return String(data.message?.content ?? '')
}

/** Models sometimes wrap JSON in prose or fences. Take the first object/array. */
export function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    const m = raw.match(/[[{][\s\S]*[\]}]/)
    if (m) { try { return JSON.parse(m[0]) as T } catch {} }
    return fallback
  }
}
