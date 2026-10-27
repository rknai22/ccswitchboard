import { expect, test } from 'bun:test'
import { LineDecoder, encode } from '../../plugin/protocol.ts'
import { ensureTopic, fakeShim, startServer } from './helpers.ts'

test('encode/LineDecoder round-trip ping and pong', () => {
  const dec = new LineDecoder()
  const out = dec.push(encode({ t: 'ping', nonce: 'n1' }) + encode({ t: 'pong', nonce: 'n1' }))
  expect(out).toEqual([{ t: 'ping', nonce: 'n1' }, { t: 'pong', nonce: 'n1' }])
})

test('a keyed hello is welcomed into its topic', async () => {
  const s = await startServer()
  try {
    const key = ensureTopic(s.store)
    const shim = await fakeShim(s.addr, { key, instance: 'a', caps: ['ping', 'redelivery'] })
    const w = await shim.next('welcome')
    expect(w.topic).toBe('wms')
    shim.close()
  } finally {
    s.close()
  }
})
