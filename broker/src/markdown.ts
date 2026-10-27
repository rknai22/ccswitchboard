// === GRACE START_BLOCK: broker_markdown =======================================
// MODULE_CONTRACT:
//   IN:  a session's reply text in the small markdown dialect below.
//   OUT: Telegram HTML (parse_mode HTML) split into chunks that each fit one
//        message; mdChunks() keeps code fences whole where it can.
//   INV: every character outside our tags is HTML-escaped; a chunk Telegram
//        still rejects is resent as plain text by the caller.
//   INV: underscores are never markup — file and variable names stay intact.
//
// Dialect: **bold**, *italic*, ~~strike~~, `code`, ```lang fences```,
// [text](http… url), "# heading" → bold line, "- item"/"* item" → "• item",
// "> quote" → blockquote, ">> quote" → collapsed (expandable) blockquote.

import { MAX_TEXT_CHUNK } from '../../plugin/protocol.ts'

/** Above this many characters the full text goes as a file, the start as a message. */
export const AS_FILE_CHARS = 8000
/** Markdown budget per chunk: HTML tags make it longer. */
const CHUNK_MD = 3500

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inline(s: string): string {
  // Code spans first, kept out of every other rule.
  const codes: string[] = []
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`)
  const links: string[] = []
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text: string, url: string) =>
    `\u0001${links.push(`<a href="${esc(url).replace(/"/g, '&quot;')}">${esc(text)}</a>`) - 1}\u0001`)
  s = esc(s)
  s = s.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '<b>$1</b>')
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, '$1<i>$2</i>')
  s = s.replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<s>$1</s>')
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => links[Number(i)]!)
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)]!)}</code>`)
}

/** One markdown chunk → Telegram HTML. */
export function mdToHtml(md: string): string {
  const out: string[] = []
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!)
      const lang = fence[1] ? ` class="language-${fence[1]}"` : ''
      out.push(`<pre><code${lang}>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    const quote = /^(>>?) ?(.*)$/.exec(line)
    if (quote) {
      const expandable = quote[1] === '>>'
      const body = [quote[2]!]
      while (i + 1 < lines.length) {
        const q = /^(>>?) ?(.*)$/.exec(lines[i + 1]!)
        if (!q || (q[1] === '>>') !== expandable) break
        body.push(q[2]!)
        i++
      }
      out.push(`<blockquote${expandable ? ' expandable' : ''}>${body.map(inline).join('\n')}</blockquote>`)
      continue
    }
    const head = /^#{1,6}\s+(.*)$/.exec(line)
    if (head) {
      out.push(`<b>${inline(head[1]!)}</b>`)
      continue
    }
    const item = /^(\s*)[-*]\s+(.*)$/.exec(line)
    if (item) {
      out.push(`${item[1]}• ${inline(item[2]!)}`)
      continue
    }
    out.push(inline(line))
  }
  return out.join('\n')
}

/** Split markdown at blank lines (else line ends) outside code fences. */
export function mdChunks(md: string, limit = CHUNK_MD): string[] {
  const blocks: string[] = []
  let cur: string[] = []
  let inFence = false
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence
    cur.push(line)
    if (!inFence && line.trim() === '') {
      blocks.push(cur.join('\n'))
      cur = []
    }
  }
  if (cur.length) blocks.push(cur.join('\n'))
  const out: string[] = []
  let acc = ''
  const flush = () => {
    if (acc.trim()) out.push(acc.replace(/\n+$/, ''))
    acc = ''
  }
  for (const b of blocks) {
    if (acc && acc.length + b.length + 1 > limit) flush()
    if (b.length <= limit) {
      acc += (acc ? '\n' : '') + b
      continue
    }
    // A single oversized block: cut at line ends.
    for (const line of b.split('\n')) {
      if (acc && acc.length + line.length + 1 > limit) flush()
      acc += (acc ? '\n' : '') + line.slice(0, MAX_TEXT_CHUNK)
    }
  }
  flush()
  return out
}
// === GRACE END_BLOCK: broker_markdown =========================================
