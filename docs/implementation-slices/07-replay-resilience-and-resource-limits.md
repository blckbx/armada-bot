# Slice 07 — Replay safety, resilience, and resource limits

## Agent brief

Harden the already-functional channel without changing its normal user behavior. Exercise failure modes through deterministic loopback/fake-time tests. Do not claim absolute exactly-once execution across arbitrary process crashes; preserve the semantics stated in the main plan.

## Functional outcome

The bot continues serving conversations when one relay fails, reconnects safely after outages, recovers recent offline messages, and does not normally produce duplicate AI turns when the same rumor arrives from multiple relays or in different gift wraps. Overload and durable-state failures fail closed with useful sanitized status.

## Dependencies

- Slices 01–06, including the inbound and conversation-bound reply paths.

## In scope

- Complete bounded reconnect/backoff/jitter and restored subscription behavior.
- Exercise recovery lookback after gateway restart.
- Use `wss://relay.armada.buzz`, `wss://relay.ditto.pub`, and `wss://relay.dreamith.to` as the bot's default redundant inbox set; keep discovery defaults on Ditto and Dreamith.
- Keep a recipient's valid kind-10050 list authoritative and cap one-shot recipient delivery to three relays.
- Add bounded raw-wrap queue, decrypt concurrency, per-sender/global rate limits, discovery cache, dedupe retention, event/content size limits, and publication timeouts.
- Finish persistent claim/commit/release handling keyed by account plus authenticated inner rumor ID.
- Suppress cross-relay duplicates and differently rewrapped copies.
- Stop account intake when dedupe persistence is unavailable; surface degraded status without falling back to memory-only replay protection.
- Guard all shutdown races so late decrypts, relay callbacks, model completions, and reconnects cannot start new work after stop.
- Ensure partial recipient relay failure succeeds when at least one relay acknowledges.
- Bound NIP-42 challenges, subscription state, DNS results, redirects, and one-shot delivery resources.
- Audit logs/errors/status for sensitive data across all failure paths.

## Required tests

- Same carrier from two relays causes one dispatch.
- Different valid wraps containing the same inner rumor cause one dispatch.
- Concurrent copies cannot both pass the claim gate.
- Failed dispatch releases its claim; retry can succeed. Successful dispatch commits and suppresses later delivery.
- Restart redelivery exercises the documented crash window and does not depend on APIs introduced after OpenClaw `2026.6.1`.
- Dedupe disk errors stop intake and expose a sanitized degraded state.
- Offline message inside `recoveryLookbackSeconds` is processed after restart; stale messages are rejected.
- Future, stale, self-authored, malformed, unauthorized, and oversized messages consume bounded work and never reach the model.
- One failed inbox relay leaves the bot operational through another; total failure is visible and bounded.
- Reconnect uses bounded exponential backoff with jitter and never duplicates subscriptions/handlers.
- Queue overflow follows the documented reject/backpressure policy and does not grow memory without bound.
- Authenticated sender and global token buckets reject bursts, refill deterministically, and keep a bounded identity table.
- Query result accumulation and one-shot relay fan-out remain bounded under malicious relay responses or oversized caller input.
- Stop during connect, AUTH, decrypt, dedupe, dispatch, model response, or publish produces no late agent turn or runaway timer.
- DNS rebinding and redirect tests revalidate every actual destination before connection.
- Fuzz/property tests cover event parsing, relay tags, Unicode size boundaries, and sanitized failures.

## Security invariants

- Dedupe key is the authenticated inner rumor ID, never the outer wrap ID.
- Resource controls apply before expensive crypto/model work whenever identity-independent validation permits.
- Do not log full events, ciphertext, plaintext, keys, AUTH challenges, pairing codes, or the sender-recipient graph.
- Document residual at-least-once crash semantics accurately.

## Deliverables

- Completed replay/lifecycle/resource-limit implementation.
- Deterministic reconnect, overload, restart, crash-window, and shutdown-race suites.
- Status/error states for partial relay failure, total relay failure, dedupe degradation, and delivery failure.

## Exit gate

- Reliability suite passes repeatedly without public network access or real-time sleeps.
- Duplicate and rewrapped delivery produces one normal-operation agent turn.
- A relay outage degrades service without losing the healthy relay path.
- Memory, timers, subscriptions, queues, caches, and retries are demonstrably bounded.
- All earlier slice tests remain green.

## Handoff to Slice 08

Expose stable status/probe snapshots and test hooks needed by setup diagnostics and final staging. No debug surface may reveal sensitive payloads.
