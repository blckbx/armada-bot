# Slice 03 — Relay presence and bot inbox announcement

## Agent brief

Implement only this slice after Slices 01–02 are green. Use the loopback relay harness for automated tests; public relays are reserved for staging. Preserve the relay URL and outbound-network policy in the main plan.

## Functional outcome

When the OpenClaw gateway starts, the bot connects to its configured inbox relays, handles NIP-42 safely when challenged, subscribes to bot-addressed `kind:1059` events, and publishes/verifies its `kind:10050` inbox announcement. Status reports whether the bot is actually reachable.

The bot does not yet dispatch messages to an AI agent.

## Dependencies

- Slice 01 lifecycle/configuration surfaces.
- Slice 02 signing/key interfaces.

## In scope

- Implement injectable `relay-session.ts` and `relay-manager.ts`.
- Add a loopback WebSocket relay supporting EVENT/OK, REQ/EOSE, CLOSE, AUTH, disconnect, and replay.
- Connect independently and concurrently to:
  - `wss://relay.armada.buzz`;
  - `wss://relay.ditto.pub`;
  - `wss://relay.dreamith.to`.
- Subscribe with `kinds:[1059]`, `#p:[botPubkey]`, and a bounded recovery `since`.
- Validate the outer event before putting it on a bounded inbound callback/queue boundary.
- Implement connection-scoped NIP-42 challenge handling using the exact normalized relay URL.
- Publish/update the bot-authored `kind:10050` inbox list to discovery relays when configured.
- Verify the resulting valid bot-authored announcement can be read back.
- Make a verified kind-10050 announcement a readiness requirement when `publishInbox` is enabled; do not report healthy merely because a WebSocket opened.
- Implement idempotent start/stop, bounded reconnect, subscription restoration, and sanitized per-relay status.

## Required tests

- Multiple relay sessions connect and fail independently.
- Subscription filters contain only the expected kind, recipient, and bounded lookback.
- Malformed or irrelevant events do not reach the later ingress callback.
- AUTH challenges cannot cross connections, cannot be replayed after replacement/expiry, and are never signed for a URL rejected by network policy.
- Reconnect restores AUTH state and subscription without multiplying handlers.
- Publish succeeds when at least one target returns a valid OK and fails when none do.
- Stop cancels reconnects, subscriptions, timers, and late callback delivery.
- Handler rejection does not terminate a healthy session.
- Published kind-10050 contains the configured Armada/Ditto/Dreamith relay tags, a valid signature, and no secret material.
- Readiness is degraded when inbox publication/verification fails and healthy when at least the required relay conditions are met.

## Security invariants

- Apply scheme, credential, redirect, hostname/IP, and private-network policy before connecting or authenticating.
- Never log AUTH challenges, full events, ciphertext, keys, or sender/recipient relationships.
- NIP-42 authenticates the bot to that relay and may reveal the bot pubkey; document this without representing AUTH as a stored DM.
- A relay event is untrusted even after transport-level AUTH.

## Deliverables

- Relay session/manager modules and loopback relay harness.
- Gateway lifecycle wiring that remains inactive for a disabled channel.
- Kind-10050 publisher/verifier and reachability status.

## Exit gate

- All tests use the loopback relay and fake timers; no test contacts a public relay.
- Starting the enabled gateway produces one restored subscription per configured relay.
- The bot is reported ready only after its identity is valid, the required subscription is live, and its usable inbox announcement is verified.
- A received candidate wrap reaches only the bounded raw-event handoff; no OpenClaw agent turn is started.

## Handoff to Slice 04

The event callback must support backpressure and cancellation. It passes raw carrier events to the crypto layer but must not infer sender identity from the outer event.
