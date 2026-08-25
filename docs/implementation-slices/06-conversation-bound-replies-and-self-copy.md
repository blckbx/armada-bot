# Slice 06 — Human-initiated conversations and sender recovery copies

## Agent brief

Complete sender-side recovery for the automatic reply path after the single-owner policy is green. The human owner initiates every conversation by sending the bot a valid NIP-17 DM. Do not expose an arbitrary outbound target, shared `message`-tool adapter, scheduled-send path, or proactive-send API.

## Functional outcome

The configured owner starts a DM conversation with the bot. Once the first inbound message is authenticated and admitted, OpenClaw can respond through that inbound turn's delivery callback. Each delivered response has the triggering rumor's `e` tag and produces a separate bot-addressed recovery copy with the same inner rumor ID. A recovery copy received by the bot is recognized and ignored before replay claiming or agent dispatch.

There is no separate Nostr acceptance event. In v1, the bot accepts the conversation by authenticating the owner, admitting the message through the static allowlist, and replying.

## Dependencies

- Slice 04 automatic reply routing and delivery.
- Slice 05 single-owner authorization and fallback behavior.

## In scope

- Keep all outbound text inside the delivery callback of an admitted inbound owner turn.
- Require every response rumor to contain one `p` tag for the authenticated owner and an `e` tag for the triggering inbound rumor.
- Emit recipient and bot self-copy wraps for the same inner rumor ID.
- Use independent seals, ephemeral wrapper keys, randomized timestamps, signatures, and outer IDs for recipient and self copies.
- Publish the recipient copy through the existing kind-10050/configured-fallback routing path.
- Publish the self-copy to the bot's configured inbox relays only after recipient delivery succeeds.
- Treat recipient delivery as authoritative. A self-copy failure returns a sanitized recovery warning without turning successful recipient delivery into failure.
- Classify a valid bot-authored, bot-addressed self-copy and ignore it before replay claiming, authorization, or model dispatch.
- Reject oversized Unicode text before creating an invalid NIP-44 envelope.
- Return the inner rumor ID as the stable response receipt.

## Out of scope

- Bot-initiated or unsolicited DMs.
- Scheduled messages, alerts, cron integration, and background agent sends.
- OpenClaw shared `message`-tool or legacy outbound adapters for channel `nostr`.
- User-supplied outbound target parsing or arbitrary `nostr:<npub-or-hex>` destinations.
- Conversation invitations sent by the bot or plugin-owned pairing/acceptance state.

## Required tests

- Automatic responses retain the triggering inbound rumor's `e` tag.
- Recipient and self-copy wraps decrypt to the same rumor ID, content, `p`, and `e` tags using their respective keys.
- Recipient/self seals and wraps use independent randomized timestamps, signatures, and ephemeral keys.
- Recipient success plus self-copy failure returns success with only a sanitized recovery warning.
- Recipient failure returns failure and does not publish a self-copy.
- A valid bot-authored self-copy received on the bot subscription is ignored before replay claiming and cannot start an agent turn.
- A non-owner cannot establish a conversation or cause recipient/self-copy publication.
- A valid owner kind-10050 remains authoritative; configured fallback is used only when the owner has no usable announcement and fallback is enabled.
- Boundary-size Unicode content follows the documented rejection behavior.
- The channel exposes no standalone outbound/message adapter.

## Security invariants

- Only a fully authenticated and allowlisted inbound owner rumor can create the callback that sends a response.
- Reply routing derives from the authenticated inner sender, never from an outer carrier or user-supplied outbound target.
- Self-copy encryption is addressed to the bot and does not reuse the recipient's seal or outer carrier.
- A self-copy never enters replay storage, authorization, session routing, model dispatch, or reply delivery.
- Receipt IDs are inner rumor IDs; outer carrier IDs are never stable message identity.

## Deliverables

- Conversation-bound response and recovery-copy publication support.
- Safe inbound self-copy classification and suppression.
- Unit and encrypted loopback tests for delivery ordering, warning semantics, and non-recursion.
- README documentation for the human-initiated conversation model.

## Exit gate

- The configured owner initiates an Armada-compatible DM and receives an automatic response carrying the correct reply reference.
- That response creates a decryptable sender recovery copy without recursive dispatch.
- No public API can initiate a Nostr DM independently of an admitted inbound owner turn.
- All earlier slice tests remain green.

## Handoff to Slice 07

Receive and conversation-bound reply operations expose cancellation, bounded queues, acknowledgement state, and stable logical IDs so lifecycle and replay stress can be tested without adding proactive sends.
