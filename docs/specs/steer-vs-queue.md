# SPEC: steer-without-interrupt + double-Enter gesture (codex)

Status: FROZEN for Phase 1 (research + spec only). Implementation lands in later dispatches.

## Protocol verdict (codex-cli 0.154.0)

Native mid-turn steering EXISTS; no child kill or restart is needed.

- Real binary: `/opt/homebrew/bin/codex` is an opencodex shim that `exec`s
  `/opt/homebrew/bin/codex.opencodex-real` -> `/opt/homebrew/Caskroom/codex/0.154.0/bin/codex`
  (native Rust build, Homebrew cask; not the npm package).
- Live stdio probe of `codex.opencodex-real app-server` (transcript:
  /private/tmp/omb-steer-probe2.log on this machine): server identifies as
  `omb-probe/0.154.0`. `turn/steer`, `turn/interrupt`, and `thread/queue/add`
  all exist as JSON-RPC methods (empty params -> `-32600 Invalid request:
  missing field \`threadId\``; an unknown method would return -32601).
  With a well-formed threadId, `turn/steer` dispatches without param errors.
- Binary strings (`strings` on the Mach-O) show the surrounding protocol:
  methods `turn/start`, `turn/steer`, `turn/interrupt`, `thread/queue/add`,
  `thread/start`, `thread/resume`, `thread/read`; error variants
  `ActiveTurnNotSteerable { turnKind }`, `NotIdle`, `PendingTriggerTurn`,
  `NoActiveTurn`, `ExpectedTurnMismatch`; notifications `ThreadQueueChanged`,
  `TurnAborted`, `TurnStarted`, `TurnComplete`, `ItemStarted`, `ItemCompleted`;
  a persistent `queued_items` sqlite table per thread.
- Upstream app-server protocol docs (openai/codex codex-rs app-server-protocol,
  v2 JSON schema ~0.153.x) describe `activeTurnNotSteerable` as: "turn/start or
  turn/steer was submitted while the current active turn was not steerable, for
  example /review or manual ..." -- i.e. both methods engage the active turn.
- Semantics: steering redirects the RUNNING turn. Codex aborts the in-flight
  model stream at a safe boundary (turn-level abort via protocol) and continues
  the same turn/session with the new input folded in. The app-server child and
  the native thread stay alive; nothing is SIGTERMed or restarted. The OpenMausBot
  codex driver already runs one app-server per turn, so `turn/steer` rides the
  live request instance that owns the running turn.

Open items to pin down in Phase 2 (not blockers): exact `turn/steer` param
fields beyond threadId (input items, approval/effort passthrough, turn-id
guard), its response/event sequence (`turn/aborted` -> resumed items?), and
fallback when `NoActiveTurn` races completion (fall back to queue).

## Acceptance criteria (one per user requirement)

(a) On a busy 1:1 steer-capable thread, Enter still queues with no added
latency, and a second Enter within a short window steers the just-queued
message into the running turn. Plain sends stay latency-free; the gesture is
discoverable via existing steer locale strings.
(b) Steering never interrupts or kills the running bot: no path from steer or
queue may call killCliTree (or otherwise SIGTERM the child) mid-turn. Turn-level
protocol abort inside turn/steer is in-scope and expected; process-level kill
is out.
(c) The SIGTERM runtime error ("codex exited null (signal SIGTERM) before
turn/completed; no stderr after the last app-server output") is unreachable
from steer, queue, and explicit Stop. Stop uses the graceful protocol interrupt
(`turn/interrupt`) first, kill only as escalation, and the close handler must
not surface raw SIGTERM as runtime.error for intentional stops (fix the
stopRequested race).
(d) Rooms and groups stay queue-only; no steering surfaces there.

## Behavior matrix (rows to test)

| Action | codex (capable) | claude (already steers) |
| --- | --- | --- |
| Enter (busy 1:1) | queue, no latency added | queue, unchanged |
| double-Enter (busy 1:1) | second Enter steers queued msg via turn/steer; child alive; no SIGTERM error | same gesture via existing adapter.steer |
| Steer chip | non-interrupting steer (turn/steer) | non-interrupting steer (existing) |
| Stop | graceful turn/interrupt; clean end, no SIGTERM runtime.error; kill only escalation | unchanged |
| Any action in rooms/groups | queue-only | queue-only |

## Test plan (one test per criterion)

(a) Composer/driver test: Enter queues; a second Enter within the window routes
the queued message to adapter.steer and the queue empties (no new turn started,
no interrupt dispatched).
(b) Driver test: steer reaches the running turn through turn/steer on the SAME
child; killCliTree/terminate is not called; child still emits turn events after.
(c) Driver test: explicit Stop sends turn/interrupt and the close handler
reports a clean end (no runtime.error mentioning SIGTERM); escalation-kill only
after interrupt fails/times out. Queue-drain test asserts no SIGTERM path.
(d) UI test: no steer affordance or double-Enter steering in rooms/groups.

## Boundary

Phase 1 adds this SPEC only: no driver, server, or UI changes.

