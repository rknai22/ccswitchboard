import { expect, test } from 'bun:test'
import { mdChunks, mdToHtml, mdToRich, wantsRich } from '../src/markdown.ts'

test('bold, italic, strike, code, link', () => {
  expect(mdToHtml('**b** *i* ~~s~~ `c` [t](https://x.y/a?b=1&c=2)')).toBe(
    '<b>b</b> <i>i</i> <s>s</s> <code>c</code> <a href="https://x.y/a?b=1&amp;c=2">t</a>',
  )
})

test('HTML special chars are escaped, also inside code', () => {
  expect(mdToHtml('a < b & c > d `<x>`')).toBe('a &lt; b &amp; c &gt; d <code>&lt;x&gt;</code>')
})

test('underscores are not markup', () => {
  expect(mdToHtml('file_name_v2.ts and __init__')).toBe('file_name_v2.ts and __init__')
})

test('a lone asterisk and arithmetic stay as they are', () => {
  expect(mdToHtml('5 * 3 = 15, a* b')).toBe('5 * 3 = 15, a* b')
})

test('no markup inside code spans and fences', () => {
  expect(mdToHtml('`**not bold**`')).toBe('<code>**not bold**</code>')
  expect(mdToHtml('```ts\nconst a = 1 < 2 // **x**\n```')).toBe(
    '<pre><code class="language-ts">const a = 1 &lt; 2 // **x**</code></pre>',
  )
})

test('heading, bullets, quote, collapsed quote', () => {
  expect(mdToHtml('# Title\n- one\n* two')).toBe('<b>Title</b>\n• one\n• two')
  expect(mdToHtml('> a\n> b\ntext')).toBe('<blockquote>a\nb</blockquote>\ntext')
  expect(mdToHtml('>> long\n>> details')).toBe('<blockquote expandable>long\ndetails</blockquote>')
})

test('chunks split at blank lines and keep fences whole', () => {
  const para = 'x'.repeat(2000)
  const fence = '```\n' + 'y\n\n'.repeat(1000) + '```'
  const parts = mdChunks(`${para}\n\n${para}\n\n${fence}`)
  expect(parts.length).toBe(3)
  expect(parts[2]!.startsWith('```')).toBe(true)
  expect(parts[2]!.endsWith('```')).toBe(true)
})

test('a line longer than a chunk is split, nothing lost', () => {
  const line = 'a'.repeat(5000)
  const parts = mdChunks(line)
  expect(parts.join('')).toBe(line)
  expect(Math.max(...parts.map(p => p.length))).toBeLessThanOrEqual(3500)
})

test('a fence cut in two is closed and reopened, code stays code', () => {
  const md = '```ts\n' + Array.from({ length: 600 }, (_, i) => `const x${i} = "**${i}**"`).join('\n') + '\n```\nafter **bold**'
  const parts = mdChunks(md)
  expect(parts.length).toBeGreaterThan(1)
  for (const p of parts.slice(0, -1)) expect(p.trimEnd().endsWith('```')).toBe(true)
  expect(parts[1]!.startsWith('```ts')).toBe(true)
  for (const h of parts.map(mdToHtml)) {
    for (const pre of h.match(/<pre>[\s\S]*?<\/pre>/g) ?? []) expect(pre).not.toContain('<b>')
    expect(h.startsWith('<pre>')).toBe(true)
  }
  expect(mdToHtml(parts.at(-1)!)).toContain('after <b>bold</b>')
})

test('placeholder characters in the input are harmless', () => {
  expect(() => mdToHtml('x\u00000\u0000 y\u00011\u0001')).not.toThrow()
  expect(mdToHtml('x\u00000\u0000')).toBe('x0')
})

test('a code span inside a link URL does not land in href', () => {
  expect(mdToHtml('[a](http://x/`" onx="y`)')).not.toContain('<a ')
})

test('wantsRich: a table or a heading outside code', () => {
  expect(wantsRich('| a | b |\n|---|:-:|\n| 1 | 2 |')).toBe(true)
  expect(wantsRich('intro\n## Plan\ntext')).toBe(true)
  expect(wantsRich('plain **bold** and - list')).toBe(false)
  expect(wantsRich('a | b | c')).toBe(false)
  expect(wantsRich('| a | b |\n| - | - |')).toBe(true)
  expect(wantsRich('|x|\n|-- text|')).toBe(false)
  expect(wantsRich('```\n# comment\n| a | b |\n|---|---|\n```')).toBe(false)
  expect(wantsRich('#hashtag')).toBe(false)
})

test('mdToRich: escapes what rich markdown would read as markup, not code', () => {
  expect(mdToRich('$5 and $10, __init__ and file_name, a == b, a || b, List<int>'))
    .toBe('\\$5 and \\$10, \\_\\_init\\_\\_ and file\\_name, a \\=\\= b, a \\|\\| b, List\\<int>')
  expect(mdToRich('`$x_y` and $z')).toBe('`$x_y` and \\$z')
  expect(mdToRich('```sh\nfoo || bar_$x\n```')).toBe('```sh\nfoo || bar_$x\n```')
})

test('mdToRich: tables keep their pipes, our own markup passes as is', () => {
  expect(mdToRich('| a_b | c |\n|---|---|\n| 1 || 2 |')).toBe('| a\\_b | c |\n|---|---|\n| 1 || 2 |')
  expect(mdToRich('# T\n**b** *i* ~~s~~ [l](https://x.y)\n- item\n> q')).toBe('# T\n**b** *i* ~~s~~ [l](https://x.y)\n- item\n> q')
})

test('mdToRich: ">>" collapsed quote → details; a one-liner → a plain quote', () => {
  expect(mdToRich('>> Spec\n>> line 1\n>> line 2')).toBe('<details><summary>Spec</summary>\n\nline 1\nline 2\n\n</details>')
  expect(mdToRich('>> only')).toBe('>only')
})
