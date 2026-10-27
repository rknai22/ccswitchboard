import { expect, test } from 'bun:test'
import { mdChunks, mdToHtml } from '../src/markdown.ts'

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
