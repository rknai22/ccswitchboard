// === GRACE START_BLOCK: broker_voice ==========================================
// MODULE_CONTRACT:
//   IN:  an owner voice message / audio / video note (bytes from Telegram,
//        ≤ 20 MB); the OpenAI key in config.openai_key_file (read on each use,
//        so putting the file in place needs no restart).
//   OUT: transcribe() → the text, or an error string; the core puts
//        "🎤 <text>" in front of the event before the session gets it.
//   INV: the key is never logged and never leaves the broker except in the
//        Authorization header to api.openai.com; no transcript text is logged.
//   INV: no key file = no transcription: the event goes as before (the session
//        can still download the audio).

import { existsSync, readFileSync } from 'fs'
import type { Attachment, FilePayload } from '../../plugin/protocol.ts'
import type { Config } from './config.ts'

export const VOICE_KINDS: Attachment['kind'][] = ['voice', 'audio', 'video_note']
const TIMEOUT_MS = 90_000

export function openaiKey(cfg: Config): string | null {
  const p = cfg.openai_key_file
  if (!p || !existsSync(p)) return null
  try {
    const k = readFileSync(p, 'utf8').trim()
    return k.startsWith('sk-') ? k : null
  } catch {
    return null
  }
}

export type Transcript = { ok: true; text: string } | { ok: false; error: string }

export async function transcribe(
  cfg: Config,
  file: FilePayload,
  mime: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<Transcript> {
  const key = openaiKey(cfg)
  if (!key) return { ok: false, error: 'no_key' }
  const form = new FormData()
  const ext = file.name.includes('.') ? file.name.split('.').pop() : 'ogg'
  form.append('file', new Blob([Buffer.from(file.data_b64, 'base64')], { type: mime ?? 'audio/ogg' }), `voice.${ext}`)
  form.append('model', cfg.openai_model || 'whisper-1')
  form.append('response_format', 'json')
  let res: Response
  try {
    res = await fetcher(`${cfg.openai_api || 'https://api.openai.com'}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    const name = (e as Error)?.name
    return { ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' }
  }
  if (!res.ok) return { ok: false, error: `http_${res.status}` }
  try {
    const j = (await res.json()) as { text?: unknown }
    const text = typeof j.text === 'string' ? j.text.trim() : ''
    return text ? { ok: true, text } : { ok: false, error: 'empty' }
  } catch {
    return { ok: false, error: 'bad_response' }
  }
}
// === GRACE END_BLOCK: broker_voice ============================================
