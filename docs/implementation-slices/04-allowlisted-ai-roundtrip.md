# Slice 04 — First complete allowlisted AI round trip

## Agent brief

Implement the narrow core use case end to end after Slices 01–03 are green. This slice is the first usable chatbot milestone: one configured user `npub` sends a NIP-17 DM from an Armada-compatible client and receives an encrypted AI response. Keep policy lock-down and self-copy recovery for later slices.

## Functional outcome

With `dmPolicy: "allowlist"` and the operator's user `npub` in `allowFrom`:

1. The user publishes a gift-wrapped DM to the bot's advertised inbox relays.
2. The plugin decrypts and authenticates the inner sender.
3. OpenClaw routes the plaintext to the sender's direct session and obtains the agent's final text.
4. The plugin discovers the user's valid `kind:10050` inbox relays.
5. It sends a fresh NIP-17 reply containing an `e` reference to the triggering rumor.
6. The Armada-compatible user decrypts and displays the response.

## Dependencies

- Slice 01 install/config/identity.
- Slice 02 crypto core.
- Slice 03 relay lifecycle and loopback harness.

## In scope

- Implement the bounded inbound queue and `inbound.ts` mapping.
- Authenticate and authorize exclusively with the verified inner rumor author.
- Normalize configured allowlist entries to hex pubkeys.
- Integrate the exact OpenClaw `2026.6.34` APIs:
  - `resolveStableChannelMessageIngress`;
  - `dispatchInboundDirectDmWithRuntime`;
  - stable direct-session identity;
  - final-text outbound callback/adapter.
- Claim the account+inner-rumor ID with `createClaimableDedupe` after authentication and before dispatch; commit after successful dispatch and release after a failed dispatch.
- Implement signed kind-10050 lookup, validation, bounded caching, and routing.
- Fail closed when the recipient has no valid kind-10050 because `allowFallbackDelivery` remains `false`.
- Publish the encrypted peer reply to the discovered relays and return the inner rumor ID as `messageId`.
- Treat success from at least one recipient relay as delivery success.

## Required tests

- A full loopback path runs: disposable Armada-like user -> gift wrap -> relay -> plugin -> mocked OpenClaw agent -> gift-wrapped reply -> independent user decrypt.
- The authenticated inner sender becomes sender ID, direct peer, session key input, policy identity, and reply target.
- The outer ephemeral pubkey appears nowhere in authorization, rate limiting, session routing, reply routing, or display identity.
- An allowlisted sender reaches the agent; a non-allowlisted sender never does and receives no plaintext response in this policy.
- A valid recipient kind-10050 routes only to its relays and is never unioned with configured defaults.
- Reject wrong-author, invalid-signature, future-dated, malformed, empty, or unusable kind-10050 lists.
- Reject relay URLs with credentials, insecure schemes, redirects, loopback/private/link-local/metadata destinations, disallowed DNS answers, or DNS rebinding.
- Missing recipient kind-10050 fails before response encryption/publication and surfaces a sanitized delivery error.
- The response contains the correct `p` and `e` tags, uses a fresh wrapper key, and is decryptable by the user.
- Duplicate delivery during one process lifetime cannot start two concurrent agent turns.
- Dispatch failure releases the dedupe claim; successful dispatch commits it.
- Dedupe storage failure stops intake rather than degrading to memory-only protection.
- Plaintext is handed only to the OpenClaw runtime/model boundary and never logged.

## Security invariants

- NIP-17 E2EE ends at the OpenClaw host. A configured remote model provider receives plaintext; document this in the test/demo handoff.
- Authorization occurs only after full outer/seal/rumor validation.
- No response is sent to a pubkey or relay derived from unauthenticated outer data.
- `allowFallbackDelivery` stays disabled for this slice.

## Deliverables

- Inbound authorization/dispatch adapter.
- Claimable-dedupe compatibility adapter for OpenClaw `2026.6.34`.
- Recipient relay discovery/routing module with SSRF and DNS-rebinding defenses.
- Automatic reply adapter and full encrypted loopback integration test.
- A concise manual recipe using an allowlisted disposable user npub.

## Exit gate

- The complete encrypted request/AI-response path typechecks against the exact OpenClaw `2026.6.34` SDK baseline and passes on the patched deployable host with a mocked model response.
- Two different allowlisted senders receive independent direct sessions.
- A user without a valid kind-10050 gets a clear delivery failure; the plugin does not silently publish to Ditto/Dreamith.
- All earlier slice tests remain green.

## Handoff to Slice 05

Keep the policy decision isolated behind OpenClaw's ingress resolver so Slice 05 can lock it to one owner without changing cryptographic identity handling.
