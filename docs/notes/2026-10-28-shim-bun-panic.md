# Shim crash: Bun "panic(main thread): abort() called" (2026-10-26)

## What the logs show

From `~/.cache/claude-cli-nodejs/-home-dev1-projects-general/mcp-logs-plugin-ccswitchboard-ccswitchboard/2026-10-26T21-13-32-686Z.jsonl`.

- 21:13:31 UTC: `claude --resume` started (pid 110159).
- 21:13:32.905: "version negotiation probe closed the stdio server (rmcp-class pre-init hard close); respawning pinned legacy".
- Both the probe process and the respawned process died **8 ms after start**. Both crashed with `panic(main thread): abort() called`.
- 21:13:33.013: "Connection failed (CONNECTION_CLOSED)". No retries; the shim came back at 23:35 after a manual Reconnect.
- **Playwright's MCP server (Node) failed in the same 100 ms** with `pthread_create: Resource temporarily unavailable`.

## 1. Bun bug?

Partly. The decoded bun.report trace is `WTF::Thread::create` → `AutomaticThread::start` → `JITWorklist::enqueue`. JSC's concurrent JIT could not create a thread (EAGAIN) and hit a `RELEASE_ASSERT`. This matches [oven-sh/bun#44787](https://github.com/oven-sh/bun/issues/44787) (open, unfixed; 1.4.4 is the latest release). The workaround in that issue is `BUN_JSC_useConcurrentJIT=0`. The real cause is that the host ran out of threads or memory for a moment: 16 GB, no swap, about 3.5 GB available now, and Committed_AS is above CommitLimit. Node failed the same way.

## 2. "version negotiation probe … respawning pinned legacy"

On the v2 runtime, Claude Code first asks a stdio server for MCP 2026-07-28 (`server/discover`). If the process closes before init, Claude Code respawns it pinned to the legacy `initialize` handshake. Here the "close" was our crash. `MCP_PROTOCOL_NEGOTIATION=legacy` skips the probe. The [MCP docs](https://code.claude.com/docs/en/mcp) say a stdio server whose first connection fails in an interactive session is "marked as failed; select Reconnect in /mcp". There is no automatic retry, so Claude Code does **not** expect it to come back on its own.

## 3. Runs under Node?

- `node --experimental-strip-types server.ts` fails with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` because of the parameter property in `protocol.ts:164` (`constructor(private onBad …)`).
- `--experimental-transform-types` starts and shuts down cleanly on stdin EOF.
- There are no `Bun.*` or `bun:` APIs. The `./protocol.ts` import works.
- `package.json` "start" still calls `bun install`.

## 4. Recommendation

Stay on Bun. Switching to Node would not have helped, because Node died too. Pinning a newer Bun is not possible yet, since no fixed release exists. Instead:

1. In the start script, set `BUN_JSC_useConcurrentJIT=0`.
2. Wrap `bun server.ts` in a short retry loop: on a fast non-zero exit such as 134, retry with backoff. Claude Code itself will not retry.
3. Investigate the memory and thread pressure at resume time.
4. Optionally set `MCP_PROTOCOL_NEGOTIATION=legacy` to avoid the double spawn.

## Done in stage 0

- `plugin/package.json` start script runs the shim with `BUN_JSC_useConcurrentJIT=0`: one fewer thread to create at startup.
- No retry wrapper: a wrapper keeps Claude Code's pipe open, so a shim that crashed mid-session would be replaced by one that never gets `initialize`, and Claude Code would not even mark the server failed. The broker's heal (`/mcp` → Reconnect) covers the crash instead.
- The memory/thread pressure on the session machine is reported to the owner as a separate issue.
