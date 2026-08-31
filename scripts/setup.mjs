// One-shot environment setup: makes sure Ollama is installed, serving, and has
// the model pulled. Runs automatically on `npm install` (postinstall) and again
// before `npm run dev` (predev), where it is a fast no-op once satisfied.
//
//   SKIP_SETUP=1   bypass entirely
//   node scripts/setup.mjs --soft   never exit non-zero (used by postinstall)
import { execFileSync, spawn } from 'node:child_process'

const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434'
const MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:3b'
const soft = process.argv.includes('--soft')

const log = (s) => console.log(`[setup] ${s}`)
const die = (s) => {
  console.error(`[setup] ${s}`)
  process.exit(soft ? 0 : 1)
}

if (process.env.SKIP_SETUP) {
  log('SKIP_SETUP set — skipping')
  process.exit(0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function tags() {
  try {
    const res = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return null
    return (await res.json()).models?.map((m) => m.name) ?? []
  } catch {
    return null
  }
}

function has(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function sh(cmd, args) {
  log(`$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit' })
}

function installOllama() {
  log('Ollama not found — installing…')
  if (process.platform === 'win32') {
    if (!has('winget')) throw new Error('winget unavailable')
    sh('winget', [
      'install', '-e', '--id', 'Ollama.Ollama',
      '--accept-source-agreements', '--accept-package-agreements',
    ])
  } else if (process.platform === 'darwin') {
    if (!has('brew')) throw new Error('Homebrew unavailable')
    sh('brew', ['install', 'ollama'])
  } else {
    sh('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'])
  }
}

/** `ollama` lands outside the current PATH on Windows right after install. */
function ollamaBin() {
  if (has('ollama')) return 'ollama'
  if (process.platform === 'win32') {
    const p = `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe`
    process.env.PATH = `${process.env.PATH};${process.env.LOCALAPPDATA}\\Programs\\Ollama`
    return p
  }
  return '/usr/local/bin/ollama'
}

async function main() {
  // 1. server up?
  let models = await tags()

  if (models === null) {
    if (!has('ollama')) {
      try {
        installOllama()
      } catch (e) {
        return die(
          `could not install Ollama automatically (${e.message}). ` +
            'Install it from https://ollama.com/download, then re-run `npm run dev`.'
        )
      }
    }
    log('starting `ollama serve` in the background…')
    const child = spawn(ollamaBin(), ['serve'], { detached: true, stdio: 'ignore' })
    child.unref()

    for (let i = 0; i < 40 && models === null; i++) {
      await sleep(1000)
      models = await tags()
    }
    if (models === null)
      return die(`Ollama did not come up on ${HOST}. Run \`ollama serve\` manually.`)
  }
  log(`Ollama is serving on ${HOST}`)

  // 2. model present?
  if (models.includes(MODEL)) {
    log(`model ${MODEL} already present`)
  } else {
    log(`pulling ${MODEL} (~2 GB, one time)…`)
    try {
      sh(ollamaBin(), ['pull', MODEL])
    } catch {
      return die(`\`ollama pull ${MODEL}\` failed. Run it manually and retry.`)
    }
  }

  log('ready.')
}

main().catch((e) => die(e.message))
