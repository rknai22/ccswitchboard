// === GRACE START_BLOCK: broker_markdown =======================================
// MODULE_CONTRACT:
//   IN:  a session's reply text in the small markdown dialect below.
//   OUT: Telegram HTML (parse_mode HTML) split into chunks that each fit one
//        message; mdChunks() keeps code fences whole where it can.
//        wantsRich()/mdToRich(): text with a table or a heading goes as one
//        rich message (sendRichMessage, Bot API 10.1) in Telegram's own
//        markdown; mdToRich escapes what that dialect would read as markup
//        and ours does not ($ formulas, underscores, ==, ||, HTML tags).
//   INV: every character outside our tags is HTML-escaped; a chunk Telegram
//        still rejects is resent as plain text by the caller.
//   INV: underscores are never markup — file and variable names stay intact.
//
// Dialect: **bold**, *italic*, ~~strike~~, `code`, ```lang fences```,
// [text](http… url), "# heading" → bold line, "- item"/"* item" → "• item",
// "> quote" → blockquote, ">> quote" → collapsed (expandable) blockquote.

/** Above this many characters the full text goes as a file, the start as a message. */
export const AS_FILE_CHARS = 8000
/** Markdown budget per chunk: HTML tags make it longer. */
const CHUNK_MD = 3500

const FENCE = /^```\s*([\w+-]*)\s*$/
const FENCE_END = /^```\s*$/

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inline(s: string): string {
  // Code spans first, kept out of every other rule (and out of URLs).
  const codes: string[] = []
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`)
  const links: string[] = []
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)\u0000]+)\)/g, (_, text: string, url: string) =>
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
  // Our placeholders must not come from the text itself.
  const lines = md.replace(/[\u0000\u0001]/g, '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE_END.test(lines[i]!)) body.push(lines[i++]!)
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

/** Split markdown into chunks of at most `limit` characters: at blank lines
 *  outside code fences where possible, else at line ends, else inside a long
 *  line. A fence cut in two is closed at the end of one chunk and reopened
 *  (same language) at the start of the next, so code stays code. */
export function mdChunks(md: string, limit = CHUNK_MD): string[] {
  const out: string[] = []
  let acc: string[] = []
  let size = 0
  let fence: string | null = null // the opening line while inside a fence
  const flush = () => {
    if (fence !== null) acc.push('```')
    const text = acc.join('\n').replace(/\n+$/, '')
    if (text.trim()) out.push(text)
    acc = fence !== null ? [fence] : []
    size = fence !== null ? fence.length + 1 : 0
  }
  const room = () => limit - size - (fence !== null ? 4 : 0)
  const push = (line: string) => {
    acc.push(line)
    size += line.length + 1
  }
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    const opens = fence === null && line.length < 100 && FENCE.test(line)
    const closes = fence !== null && FENCE_END.test(line)
    // At a blank line outside a fence: cut here when the next paragraph would
    // not fit, rather than in its middle.
    if (fence === null && line.trim() === '' && size > 0) {
      let next = 0
      for (let j = i + 1; j < lines.length && lines[j]!.trim() !== ''; j++) next += lines[j]!.length + 1
      if (size + 1 + next > room()) {
        flush()
        continue
      }
    }
    while (line.length + 1 > room()) {
      if (acc.length > (fence !== null ? 1 : 0)) {
        flush()
        continue
      }
      // A single line longer than a chunk: cut it.
      let n = Math.max(1, room() - 1)
      // Never between the two halves of an emoji (a surrogate pair).
      const code = line.charCodeAt(n - 1)
      if (n > 1 && code >= 0xd800 && code <= 0xdbff) n--
      push(line.slice(0, n))
      line = line.slice(n)
      flush()
    }
    push(line)
    if (opens) fence = line
    if (closes) fence = null
  }
  if (fence !== null) fence = null
  flush()
  return out.length ? out : ['']
}
/** Rich messages hold up to 32768 characters (Bot API "Rich Message Limits"). */
export const RICH_MAX_CHARS = 32768

const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const HEADING = /^#{1,6}\s+\S/

/** Every line, flagged when it belongs to a code fence (fence lines included). */
function prose(md: string): { line: string; code: boolean }[] {
  const out: { line: string; code: boolean }[] = []
  let inFence = false
  for (const line of md.split('\n')) {
    if (inFence) {
      out.push({ line, code: true })
      if (FENCE_END.test(line)) inFence = false
    } else if (FENCE.test(line)) {
      out.push({ line, code: true })
      inFence = true
    } else out.push({ line, code: false })
  }
  return out
}

/** A GFM table or a heading outside code: plain Telegram HTML has neither. */
export function wantsRich(md: string): boolean {
  const ls = prose(md)
  return ls.some((l, i) => !l.code && (HEADING.test(l.line)
    || (TABLE_ROW.test(l.line) && i + 1 < ls.length && !ls[i + 1]!.code && TABLE_SEP.test(ls[i + 1]!.line))))
}

function richInline(s: string, inTable: boolean): string {
  const codes: string[] = []
  s = s.replace(/`([^`\n]+)`/g, m => `\u0000${codes.push(m) - 1}\u0000`)
  s = s.replace(/\\(?=[_$<=|])/g, '\\\\')
  s = s.replace(/[_$<]/g, '\\$&').replace(/==/g, '\\=\\=')
  if (!inTable) s = s.replace(/\|\|/g, '\\|\\|')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]!)
}

/** Our dialect → Telegram rich markdown: the same text, with everything the
 *  rich dialect would read as extra markup escaped, and ">>" collapsed quotes
 *  as <details> (rich markdown has no expandable quote). */
export function mdToRich(md: string): string {
  const ls = prose(md.replace(/[\u0000\u0001]/g, ''))
  const out: string[] = []
  for (let i = 0; i < ls.length; i++) {
    const { line, code } = ls[i]!
    if (code) {
      out.push(line)
      continue
    }
    if (/^>> ?/.test(line)) {
      const body = [line.replace(/^>> ?/, '')]
      while (i + 1 < ls.length && !ls[i + 1]!.code && /^>> ?/.test(ls[i + 1]!.line)) body.push(ls[++i]!.line.replace(/^>> ?/, ''))
      const [summary, ...rest] = body.map(b => richInline(b, false))
      out.push(rest.length ? `<details><summary>${summary}</summary>\n\n${rest.join('\n')}\n\n</details>` : `>${summary}`)
      continue
    }
    out.push(richInline(line, TABLE_ROW.test(line)))
  }
  return out.join('\n')
}
// === GRACE END_BLOCK: broker_markdown =========================================
