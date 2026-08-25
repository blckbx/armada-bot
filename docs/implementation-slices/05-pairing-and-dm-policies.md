# Slice 05 — Single-owner allowlist policy

## Agent brief

Lock the Slice 04 round trip to one statically configured owner. Follow the simple OpenClaw-compatible `dmPolicy: "allowlist"` and `allowFrom: ["npub1..."]` model. Do not implement pairing codes, pairing approvals, open access, disabled mode, or a plugin-owned authorization store.

## Functional outcome

The operator configures exactly one owner `npub` or hex public key in `allowFrom`:

1. A NIP-17 message is fully decrypted and authenticated.
2. Only the configured inner-rumor author reaches the OpenClaw direct session.
3. A signed kind-10050 relay list is preferred for replies when present.
4. When the owner has no usable kind-10050, the plugin automatically sends the encrypted reply through the configured default relays.
5. Every other authenticated sender is ignored before model or tool dispatch and receives no response.

## Dependencies

- Slice 04 complete inbound and reply path.

## In scope

- Make `allowlist` the only accepted `dmPolicy` value and the default.
- Require exactly one non-wildcard `allowFrom` entry.
- Accept `npub`, bare 64-character hex, or `nostr:`-prefixed public keys and normalize to lowercase hex.
- Disable OpenClaw pairing-store augmentation so historical approvals cannot broaden the configured owner.
- Keep authorization and routing keyed exclusively to the authenticated inner rumor author.
- Prefer a valid recipient kind-10050 without unioning configured fallback relays.
- Automatically use configured relays only when the sole owner has no valid kind-10050.
- Preserve old pairing records on disk without reading, deleting, or migrating them into authorization.
- Describe the single-owner mode and kind-10050 fallback clearly in configuration and operator documentation.

## Out of scope

- Pairing challenges, approval commands, or pairing-store authorization.
- Multiple owners or multiple accounts.
- `open`, `pairing`, or `disabled` DM policies.
- Sender self-copy publication and suppression, which remain Slice 06 work.
- General overload and per-sender rate-limit hardening, which remains Slice 07 work.

## Required tests

- Configuration accepts one normalized `npub`, hex, or `nostr:` public key.
- Configuration rejects an empty allowlist, multiple entries, wildcard, malformed entries, and every policy other than `allowlist`.
- The authenticated configured owner reaches the exact OpenClaw 2026.6.1 ingress and direct-DM dispatcher surfaces.
- A different authenticated inner sender causes zero model dispatches and receives no response.
- The outer ephemeral wrapper author is never compared with `allowFrom`.
- `useDefaultPairingStore` is false so stale OpenClaw pairing approvals cannot authorize another sender.
- A valid owner kind-10050 remains authoritative and is never unioned with configured relays.
- Missing, malformed, or unusable owner kind-10050 automatically routes the encrypted reply only to configured relays.
- Reply fallback still contains the correct `p` and `e` tags and decrypts independently in the owner client.
- Rewrapped or cross-relay copies cannot obtain additional turns or replies.

## Security invariants

- `allowFrom` identifies the seal-authenticated inner rumor author, never the gift-wrap author.
- Unauthorized plaintext never reaches the model or tools.
- Configured fallback relays change delivery location only; they never broaden sender authorization.
- Recipient-authored relay URLs remain untrusted and retain the Slice 04 SSRF and DNS-rebinding defenses.
- No owner identity, plaintext, ciphertext, secret, AUTH challenge, or historical pairing record is logged or exposed in status.

## Deliverables

- Strict single-owner configuration and manifest schema.
- OpenClaw ingress wiring with pairing-store augmentation disabled.
- Automatic owner relay fallback using the existing encrypted reply path.
- Focused policy, routing, and encrypted loopback tests.
- README and security documentation for the simplified configuration.

## Exit gate

- The configured owner can complete a multi-turn encrypted Armada conversation without a pairing challenge.
- A non-owner cannot start an OpenClaw turn or receive a reply.
- Replies work both with a valid owner kind-10050 and, when it is absent, through configured default relays.
- No pairing controller, challenge, approval, open-policy, or disabled-policy runtime path exists.
- All earlier slice tests remain green.

## Handoff to Slice 06

Keep the reply primitive bound to the admitted inbound owner turn. Slice 06 adds sender recovery-copy publication and suppression without exposing a standalone outbound target or message-tool adapter.
