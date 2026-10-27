# Stage 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a topic cannot be taken over by a stray shim, does not lose a message when Claude crashes, shows 👀 only when the shim accepted, heals a dead shim by itself, and opens its terminal in its own Orca project.

**Architecture:** additive protocol messages (`ping`/`pong`, `hello.instance`/`hello.caps`, `event.redelivered`) keep v1 compatible; the broker decides takeovers per topic in order, remembers which shim instance got each event, and redelivers to a new instance; the sessions watchdog runs a Python heal helper on the session host instead of the external `ccsb-mcp-heal.py`.

**Tech Stack:** Bun 1.4.4, TypeScript, bun:sqlite, grammY, `@modelcontextprotocol/sdk` 1.32.2, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-28-stage0-foundation-design.md`

## Global Constraints

- `PROTOCOL_VERSION` stays `1`; every new field/message is optional and ignored by old peers.
- Ping wait: 10 000 ms. Redelivery window: 30 min before the previous instance went away.
- Heal: 2 consecutive misses, Claude older than 120 s, at most once per 300 s per topic, after 3 failed heals in a row only the owner's button restarts. A terminal with a live Claude is never closed without the button.
- Logs carry ids and lengths only — never topic keys, message text or screen contents.
- Code style: GRACE blocks with MODULE_CONTRACT comments, as the existing files.

## Review Focus

- Shim busy sending a large file when a second hello arrives → pong still within 10 s (pong is written from the socket handler, not the delivery chain). Test in Task 2.
- Broker restarted between ack and the new shim's hello → redelivery still happens (instance and delivered_at are in sqlite, not memory). Test in Task 4.
- Old shim (no `caps`) reconnects after the broker upgrade → no `redelivered` events sent to it. Test in Task 4.
- Owner presses an old Restart button after the terminal was already replaced → nothing is closed (handle check). Test in Task 6.
- A forwarded (local, negative update_id) event acked → no reaction attempt on a bot message the owner didn't write. Test in Task 5.

---

### Task 1: Protocol additions and test harness

**Files:**
- Modify: `plugin/protocol.ts`
- Create: `broker/test/helpers.ts`, `broker/test/protocol.test.ts`
- Modify: `broker/package.json` (script `"test": "bun test"`)

**Interfaces — Produces:**
- `Hello = { t:'hello'; v; key?; instance?: string; caps?: Capability[] }`, `type Capability = 'ping' | 'redelivery'`
- `Ping = { t:'ping'; nonce: string }` (broker → shim), `Pong = { t:'pong'; nonce: string }` (shim → broker)
- `InboundEvent.redelivered?: true`
- `ShimToBroker` adds `Pong`; `BrokerToShim` adds `Ping`
- helpers: `tempStore(): Store`, `startServer(deps?): Promise<{server, addr, store, close()}>`, `fakeShim(addr, hello): Promise<FakeShim>` where `FakeShim = { msgs: any[]; send(m): void; next(t: string, ms?): Promise<any>; close(): void; closed: Promise<void>; answerPings: boolean }`

- [ ] Step 1: test `encode/LineDecoder round-trip ping and pong` → passes after types added (compile check).
- [ ] Step 2: add types; `bun test` in `broker/` passes.
- [ ] Step 3: commit `test: bun test harness; protocol: ping/pong, instance, caps, redelivered`.

### Task 2: Live connection is not replaced

**Files:** Modify `broker/src/server.ts`; Test `broker/test/takeover.test.ts`

**Interfaces — Consumes:** Task 1 types. **Produces:** `ServerDeps.onTakeoverRefused?(topic: string): void`; `Conn.caps: Set<Capability>`, `Conn.instance?: string`; exported `timingServer = { pingWaitMs: 10_000 }` (tests lower it).

- [ ] Step 1: tests
  - `second hello while first answers ping → second gets reject /held by a live session/, first still bound`
  - `second hello while first ignores ping → first gets unbound, second welcome`
  - `first without caps → replaced without ping (old behaviour)`
  - `two hellos at once for one topic → decided in order, exactly one bound`
  - `pong with a wrong nonce does not count`
  - `old socket closes during the wait → new one is welcomed`
- [ ] Step 2: run, expect failures.
- [ ] Step 3: implement: `hello()` becomes async through a per-topic promise chain; if `old` has cap `ping`, send `{t:'ping', nonce: randomUUID()}` and wait for a matching pong on that Conn (resolve on pong/close, timeout `pingWaitMs`). Pong handling in `message()`. On refusal: `reject(c, 'topic ' + name + ' is held by a live session')`, `deps.onTakeoverRefused?.(name)`.
- [ ] Step 4: tests pass; commit `fix(broker): a live shim keeps its topic — ping before replacing`.

### Task 3: Shim — instance, caps, pong, redelivered

**Files:** Modify `plugin/server.ts`; Test `broker/test/shim.test.ts` (spawns `bun plugin/server.ts` with `CCSB_KEY`, `CCSB_BROKER` → fake broker TCP server; drives it with MCP `Client` + `StdioClientTransport` from the plugin's SDK).

**Interfaces — Consumes:** Task 1. **Produces:** notification meta `redelivered: "true"` when `ev.redelivered`.

- [ ] Step 1: tests
  - `hello carries instance (uuid) and caps ['ping','redelivery']`
  - `ping → pong with the same nonce while a delivery is pending`
  - `redelivered event → channel notification meta.redelivered === 'true' and ack sent`
  - `same update_id twice → one notification, two acks`
  - `reply_to.text is not required here` (no-op; U6 is a later block)
- [ ] Step 2: run, expect failures.
- [ ] Step 3: implement: `const INSTANCE = randomUUID()` at start; hello adds `instance`, `caps`; `case 'ping'`: `s.write(encode({t:'pong', nonce}))` directly; meta adds `redelivered`. Instructions string: add the sentence «If the tag has redelivered="true", the session restarted after this message was handed over: look for it in your conversation first; if you already answered, do not repeat; if unsure about an action with consequences, ask the owner.»
- [ ] Step 4: tests pass; commit `feat(shim): instance id, ping/pong, redelivered meta`.

### Task 4: Redelivery to a new shim instance

**Files:** Modify `broker/src/store.ts`, `broker/src/server.ts`; Test `broker/test/redelivery.test.ts`

**Interfaces — Produces (store):**
- migration: `updates` gets `instance TEXT`, `delivered_at INTEGER` (ALTER TABLE ADD COLUMN when missing)
- `markDelivered(topic, updateId, instance?: string): boolean` sets both columns
- `redeliverable(topic: string, prevInstance: string, since: number): StoredEvent[]` — delivered=1, instance=prev, delivered_at ≥ since, by seq
- kv `topic:<name>:instance` (last bound instance), `topic:<name>:instance_gone_at` (ms; set on close/replace of that instance's connection)

- [ ] Step 1: tests
  - `ack from instance A, A disconnects, B connects → B gets the event with redelivered:true after its undelivered backlog`
  - `A reconnects with the same instance → no redelivery`
  - `event delivered 31 min before A went away → not redelivered`
  - `B without caps 'redelivery' → no redelivery`
  - `broker restart (new Store on the same dir, new server) between A's ack and B's hello → B still gets it`
- [ ] Step 2: run, expect failures.
- [ ] Step 3: implement in `hello()` after welcome: backlog as now; then if `c.caps.has('redelivery')` and `prev && prev !== c.instance`, send `redeliverable(topic, prev, (goneAt || now) - 30*60_000)` with `redelivered: true`; then store the new instance. On socket close of a bound topic Conn: set `instance_gone_at = now`. Ack passes `c.instance`.
- [ ] Step 4: tests pass; commit `fix(broker): a new shim instance gets the last 30 min again, marked redelivered`.

### Task 5: 👀 on ack

**Files:** Modify `broker/src/server.ts` (`ServerDeps.onAck?(topic: string, updateId: number): void`), `broker/src/broker.ts` (move reaction from `handleUpdate` to `onAck`); Test `broker/test/ack-reaction.test.ts`

- [ ] Step 1: tests (Broker's reaction function extracted as `reactionTarget(ev: StoredEvent, owner): {chat_id, message_id} | null`)
  - `group event → chat_id = owner chat, message_id as is`
  - `DM event (negative message_id) → chat_id = owner_id, message_id negated back`
  - `local event (update_id < 0) → null`
  - `server calls onAck only when markDelivered returned true`
- [ ] Step 2–3: implement; `handleUpdate` keeps only `typing`; `onAck` loads the event (`store.event(topic, updateId)` new getter) and calls `setMessageReaction` through `tg.enqueue`.
- [ ] Step 4: tests pass; commit `feat(broker): 👀 means the shim accepted the message`.

### Task 6: Heal in the watchdog, Restart button, Orca project id

**Files:** Modify `broker/src/sessions.ts`, `broker/src/strings.ts`; Create `broker/src/heal.ts` (HEAL_PY + decision); Test `broker/test/heal.test.ts`, `broker/test/orca-id.test.ts`

**Interfaces — Produces:**
- `healDecision(s: { strikes: number; lastAt: number; fails: number; claudeAgeS: number; now: number }): 'wait' | 'heal' | 'ask_owner'`
- `repoIdFor(repoListJson: unknown, path: string): string | undefined`
- `census()` also returns `othersHandles: string[]`
- callback data `ccsb:restart:<topic>:<handle>`; strings `heal_failed_ask` (en/ru) with the button `restart_button`
- config flag `heal: boolean` (default false; turned on at rollout when the heal timer goes off)

- [ ] Step 1: tests
  - `healDecision`: strikes<2 → wait; claude younger than 120 s → wait; last heal <300 s ago → wait; fails≥3 → ask_owner once per 15 min; else heal
  - `repoIdFor` finds by normalized path, undefined when absent
  - `restart callback from a non-owner → ignored`; `handle no longer in census → nothing closed, answer "already replaced"`
- [ ] Step 2: run, expect failures.
- [ ] Step 3: implement:
  - HEAL_PY on the session host via `runOnSessionHost(['python3','-c',HEAL_PY, ORCA, handle])`: same steps as `ccsb-mcp-heal.py` (`idle()`, `/mcp`, find `ccswitchboard`, `Reconnect`), but it re-reads the screen before each keystroke and aborts with `{"ok":false,"why":"changed"}` if the screen stopped being the expected menu; prints JSON `{ok, why}`; never prints screen text.
  - In `ensureNow`'s alive branch: if `config.heal` and `kp.claude.length === 1` and exactly one candidate terminal (`cen.ours` or, if none, `othersHandles`), count strikes in kv `topic:<name>:heal`, consult `healDecision`, run HEAL_PY, then wait up to 20 s for `isConnected(name)`; success resets counters.
  - `ask_owner`: `notifyGeneral` with inline button `restart_button` → callback `ccsb:restart:<name>:<handle>`; handler (sessions module `onUpdate`, `callback_query`, `from.id === owner_id`): if handle is still in `cen.ours`, set `force_relaunch=1`, clear `launch_at`, `ensure(name)`; answer the callback.
  - Launch uses `--worktree id:<repoId>::<cwd>` when `repoIdFor` finds it, else `path:<cwd>` + log `repo_id_missing`.
- [ ] Step 4: tests pass; commit `feat(broker): heal a dead shim in the watchdog; owner-only restart button; terminal in its own Orca project`.

### Task 7: Why the shim dies (research)

**Files:** Create `docs/notes/2026-10-28-shim-bun-panic.md`

- [ ] Step 1: collect the known log lines; check Bun releases after 1.4.4 and the Bun tracker for `abort()` panics with stdio servers; try the shim under `node --experimental-strip-types` with the Task 3 test.
- [ ] Step 2: write findings + recommendation (stay / pin newer Bun / Node); commit `docs: shim crash notes`.

### Task 8: Docs, templates, rollout notes

**Files:** Modify `README.md` (protocol, delivery semantics, heal, Restart button, known limits), `templates/CLAUDE.topic.md` and General template (redelivered rule), `broker/config.example.json` (`heal`).

- [ ] Step 1: edit; full `bun test` green.
- [ ] Step 2: commit `docs: stage 0 — delivery, takeover, heal`.
