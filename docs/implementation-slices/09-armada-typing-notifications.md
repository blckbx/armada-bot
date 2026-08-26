# Slice 09 — Armada typing notifications

## Agent brief

Add Armada's encrypted direct-message typing extension after the release-candidate slices are complete. Preserve the single-owner, human-initiated conversation boundary and keep typing delivery ephemeral, best-effort, and independent from the durable reply.

## Functional outcome

After an authenticated owner message is admitted, Armada shows the bot as typing while OpenClaw generates and delivers the response. The notification naturally expires when the turn finishes or fails and can never create a new conversation or agent turn.

## Dependencies

- Slices 01–08 complete and green.
- Armada client interoperability at `soapbox-pub/armada` commit `5b99f88d309052abc1eeb4f0b2ef437de086e709`.

## In scope

- Create an empty `kind:23311` rumor with exactly one recipient `p` tag.
- Sign a standard NIP-59 `kind:13` seal and place it in a fresh-key ephemeral `kind:21059` gift wrap.
- Keep the rumor timestamp current, backdate the seal within the NIP-59 window, and keep the ephemeral outer timestamp current.
- Publish immediately after owner admission, then refresh at most once every four seconds while dispatch remains active.
- Route through the same validated recipient relay decision as the eventual reply.
- Publish no sender self-copy and no explicit stop event; Armada expires the in-memory indicator after eight seconds.
- Treat relay discovery, construction, and publication failures as best-effort typing misses that cannot fail or delay the durable reply.
- Stop scheduling refreshes on completion, dispatch failure, delivery failure, or account cancellation.

## Out of scope

- Accepting inbound typing signals or routing them to OpenClaw.
- Durable `kind:1059` typing events, NIP-40 expiration tags, plaintext typing events, presence, read receipts, or delivery receipts.
- Typing for unauthorized, rate-limited, duplicate, self-copy, or otherwise rejected traffic.
- Any new arbitrary-target, unsolicited, scheduled, group, or community send path.
- A user-configurable timing interval in the first implementation.

## Required automated tests

- The generated rumor is `kind:23311`, empty, current, addressed only to the owner, unsigned, and hash-valid.
- The seal is bot-authored, signature-valid, tagless, encrypted to the owner, and backdated only within the existing NIP-59 bound.
- The outer wrap is `kind:21059`, signature-valid, addressed only to the owner, authored by a fresh ephemeral key, current rather than backdated, and decryptable by Armada's NIP-44/NIP-59 sequence.
- No self-copy or expiration tag is created.
- An admitted turn sends immediately and refreshes on the four-second cadence while dispatch is pending.
- Completion, failure, and cancellation stop future refreshes.
- Typing construction, relay lookup, and publication failures do not block dispatch or fail reply delivery.
- Rejected and rate-limited turns publish no typing event.

## Exit gate

- A current Armada client displays the bot typing during a deliberately delayed OpenClaw response.
- The indicator disappears through Armada's eight-second decay after the turn ends.
- The durable reply still uses `kind:1059` and retains its sender recovery copy; typing uses only recipient `kind:21059` wraps.
- Probe/log/error surfaces expose no typing payload, ciphertext, key, or sender-recipient relationship.
- Tests, lint, typecheck, formatting, build, package validation, smoke tests, dry-run, and audit pass.
