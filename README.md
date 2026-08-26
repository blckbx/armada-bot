# OpenClaw Armada DM

`openclaw-armada-dm` is an OpenClaw channel plugin for private, one-to-one Armada conversations over standard Nostr NIP-17 direct messages. It provides a strict single-owner allowlist, file-backed bot identity, redundant relay inbox, authenticated AI replies, encrypted inbound image/audio/video/file analysis, Armada-compatible encrypted typing notifications, sender recovery copies, durable replay suppression, bounded resource use, and sanitized operational probes.

## Build and local installation

Build the JavaScript artifact before installing it:

```bash
npm install
npm test
npm run build
npm run package:validate
```

From an npm-managed local OpenClaw `2026.6.1` checkout, install the built working directory:

```bash
npm install /absolute/path/to/openclaw-armada-dm
openclaw config set plugins.load.paths \
  '["/absolute/path/to/openclaw-checkout/node_modules/openclaw-armada-dm"]' \
  --strict-json
openclaw plugins enable armada-dm
openclaw gateway restart
openclaw channels status --probe
```

OpenClaw `2026.6.1` does not automatically scan arbitrary packages placed in a checkout's root `node_modules`, so the explicit `plugins.load.paths` entry is required for this literal npm workflow. A source checkout managed as OpenClaw's pnpm monorepo is a different installation shape; use the managed `npm-pack:` workflow below instead.

For a standard OpenClaw installation, pack and install the managed artifact:

```bash
npm pack
openclaw plugins install npm-pack:/absolute/path/openclaw-armada-dm-0.1.0.tgz
openclaw plugins enable armada-dm
openclaw gateway restart
```

The published `setup-entry.js` is an import-safe OpenClaw `2026.6.1` compatibility adapter. It does not run a wizard, prompt for values, edit configuration, read the secret file, publish events, or start relay connections.

## Migrating another Nostr channel

Only one enabled plugin may own channel ID `nostr`. Before enabling `armada-dm`, disable or remove an existing `nostr-nip17` or bundled Nostr plugin while preserving `channels.nostr` and `secrets.providers.nostr`. Review that preserved channel configuration against the strict manual example below, especially the one-entry `allowFrom` list, then enable this plugin and restart. A duplicate owner produces an actionable startup error rather than silently selecting one implementation. Historical Nostr pairing approvals remain untouched on disk but are neither imported nor consulted.

## Bot identity prerequisite

Use a dedicated bot key, never a human identity key. 
For Armada client: 
- Create a new account and setup the Bot profile (marking profile as bot is optional but helps identifying). 
- Save the nsec from settings to disk
- From the user profile create a DM chat with the Bot
- From Bot profile: accept the DM chat

Provision the single-value secret file before enabling the channel in OpenClaw:

```bash
install -d -m 700 /path/to/.openclaw/secrets
umask 077
read -rsp 'Paste Nostr nsec: ' NSEC; printf '\n'
printf '%s\n' "$NSEC" > /path/to/.openclaw/secrets/nostr_nsec
unset NSEC
chmod 600 /path/to/.openclaw/secrets/nostr_nsec

openclaw config set secrets.providers.nostr \
  --provider-source file \
  --provider-path /path/to/.openclaw/secrets/nostr_nsec \
  --provider-mode singleValue

openclaw config set channels.nostr.privateKey \
  --ref-provider nostr \
  --ref-source file \
  --ref-id value

openclaw secrets audit
openclaw secrets reload
openclaw gateway restart
```

The file contains one `nsec` and an optional conventional final line ending. It is not JSON or a `NAME=value` file. OpenClaw owns file access, permission checks, and SecretRef resolution; this plugin accepts only the resolved value in memory and exposes only the derived hex public key and `npub` in status.

The bot defaults its inbox to `wss://relay.armada.buzz`, `wss://relay.ditto.pub`, and `wss://relay.dreamith.to` for redundant receipt. Discovery remains on Ditto and Dreamith. A recipient's valid kind-10050 list is authoritative for replies; configured inbox relays are used only when fallback delivery is enabled and the recipient has no usable announcement. Duplicate deliveries across relays or independently rewrapped copies are suppressed by the authenticated inner rumor ID. Insecure `ws://` configured relays require explicit `allowPrivateRelays: true` consent. The only DM policy is `allowlist`, and exactly one owner must be configured in `allowFrom`.

Configure that owner as an array containing one `npub`:

```bash
openclaw config set channels.nostr.dmPolicy allowlist
openclaw config set channels.nostr.allowFrom '["npub1..."]' --strict-json
openclaw gateway restart
```

Bare or `nostr:`-prefixed 64-character public keys are also accepted and normalized internally. Empty lists, wildcards, multiple entries, and `pairing`, `open`, or `disabled` policies are rejected.

## Manual channel configuration

No setup command is required. Add the provider and channel entries to `openclaw.json`; substitute only the owner's `npub`:

```json
{
  "secrets": {
    "providers": {
      "nostr": {
        "source": "file",
        "path": "/path/to/.openclaw/secrets/nostr_nsec",
        "mode": "singleValue"
      }
    }
  },
  "channels": {
    "nostr": {
      "enabled": true,
      "name": "OpenClaw",
      "privateKey": {
        "source": "file",
        "provider": "nostr",
        "id": "value"
      },
      "relays": [
        "wss://relay.armada.buzz",
        "wss://relay.ditto.pub",
        "wss://relay.dreamith.to"
      ],
      "discoveryRelays": ["wss://relay.ditto.pub", "wss://relay.dreamith.to"],
      "publishInbox": true,
      "allowFallbackDelivery": true,
      "allowPrivateRelays": false,
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1..."]
    }
  }
}
```

`publishInbox: true` is explicit consent for gateway startup to publish or replace this bot identity's kind-10050 inbox list. Set it to `false` only when managing that announcement independently. After editing configuration:

```bash
openclaw secrets audit
openclaw secrets reload
openclaw gateway restart
openclaw channels status --probe
```

## Relay presence and readiness

An enabled gateway connects to each configured inbox relay independently, subscribes to bot-addressed kind-1059 events with the configured recovery lookback plus NIP-59's two-day timestamp window, and reconnects with bounded backoff. When `publishInbox` is enabled, it also signs, publishes, and reads back a kind-10050 announcement containing the configured inbox relay tags. Readiness requires at least one live bot inbox subscription and a verified announcement; opening a WebSocket alone is insufficient. The probe can report `ready` with degraded health when another redundant inbox relay is unavailable.

Relay URLs are checked before connection, redirects are disabled, and the resolved address is pinned into the WebSocket lookup to prevent DNS rebinding. Public `wss://` destinations reject local, private, reserved, and metadata-adjacent address classes. Operator-configured private or `ws://` relays require `allowPrivateRelays`; recipient-provided relay addresses never receive that exception.

NIP-42 AUTH events are connection-scoped, short-lived kind-22242 events and are not published as stored DMs. Authenticating deliberately reveals the bot's real public key to that relay. Status exposes only sanitized connection/readiness state, never challenges or event bodies.

## Authenticated direct-message interface

`unwrapDirectMessage` accepts one raw relay event plus the resolved bot key and configured time bounds. It returns plaintext only after validating the signed gift wrap and seal, decrypting both NIP-44 v2 layers, recomputing the unsigned kind-14 rumor ID, and proving that the rumor author is the seal signer. Later ingress code must use `senderPublicKey` as the authenticated sender; the outer event's ephemeral `pubkey` is never a user identity.

`createDirectMessage` returns one stable `logicalMessageId` (the rumor ID), a recipient gift wrap, and a separately sealed and wrapped sender self-copy. Each wrap uses a new ephemeral key. Automatic replies publish the recipient copy first, followed by a best-effort recovery copy to the bot's configured inbox. A recovery-copy failure does not overturn successful user delivery, and a recovered bot-authored copy is ignored before replay claiming or agent dispatch. All cryptographic failures use the single sanitized `Nip17ProtocolError` category.

After an owner message passes authentication, authorization, replay claiming, and rate limiting, the plugin immediately publishes Armada's encrypted typing extension and refreshes it no more than once every four seconds while OpenClaw is generating the response. Each notification is an empty bot-authored kind-23311 rumor inside a fresh ephemeral kind-21059 NIP-59 wrap sent only to the owner's validated recipient relays. Typing is best-effort, has no sender recovery copy, and stops on completion, failure, or account cancellation; Armada removes a stale indicator locally after eight seconds.

Encrypted attachments enter through standard NIP-17 kind-15 file rumors or the current Armada client's kind-14 `imeta` attachment form. Only authenticated, allowlisted owner turns are fetched. The plugin accepts AES-256-GCM media from validated HTTPS locations, verifies the advertised ciphertext hash when present (required for kind 15), verifies the plaintext hash when present (required when an Armada voice note omits `x`), decrypts locally, and saves the result through OpenClaw's managed inbound-media store. It passes only managed local paths, normalized content types, the caption, and sanitized attachment markers to OpenClaw; blob URLs and encryption parameters are not included in the agent body.

Each turn is limited to four attachments, 20 MiB of plaintext per attachment, 40 MiB total plaintext, and a 20-second guarded load per attachment. A failed attachment becomes `[Attachment unavailable]`; valid siblings can still be analyzed. Whether a particular image, audio, video, PDF, or other file is understood depends on the configured OpenClaw model/provider. Bot-authored uploads and media replies are not implemented; replies remain encrypted text.

Inbound authorization uses only the authenticated inner rumor author. The account and inner rumor ID are claimed in OpenClaw's persistent dedupe store before dispatch, committed after a successful turn, and released after failure. Recipient delivery discovers the newest valid signed kind-10050 list, caches it for one hour, revalidates its URLs as untrusted destinations, and never unions valid recipient relays with configured defaults. When the sole owner has no usable kind-10050, automatic fallback sends the encrypted reply only through configured relays.

## Allowlisted round-trip recipe

The human owner always starts the conversation. This plugin does not expose unsolicited, scheduled, or arbitrary-target Nostr sends. NIP-17 has no separate chat-acceptance event: the bot accepts the conversation by authenticating the configured owner, admitting the inbound message, and replying through that inbound turn.

Use disposable bot and user keys. Keep `publishInbox: true`, set `channels.nostr.dmPolicy` to `allowlist`, set `channels.nostr.allowFrom` to an array containing exactly the owner's `npub` (or canonical hex pubkey), then restart the gateway. Startup publishes and verifies the bot's kind-10050 inbox announcement; confirm `openclaw channels status --probe` reports a ready Nostr account. The owner may publish a kind-10050 reply list; otherwise the plugin automatically uses its configured relays.

From an Armada-compatible client using that owner identity, send a NIP-17 DM to the bot through one of the bot's advertised relays. The reply must decrypt as a bot-authored kind-14 rumor with one `p` tag for the owner and an `e` tag containing the request rumor ID. A different authenticated sender never reaches the model and receives no response.

NIP-17 protects transport content from relays and passive observers. Plaintext necessarily exists inside the OpenClaw host and is sent to the configured model provider for the agent turn. This is transport E2EE, not secrecy from the OpenClaw runtime or model provider.

## Troubleshooting

Run `openclaw channels status --probe` after every configuration or key change. The probe exposes only public and aggregate state: configured/connected inbox counts, per-relay connection/AUTH/subscription state, verified inbox announcement, durable dedupe availability, queue drops, authenticated rate-limit and inbound-failure counts, readiness, and sanitized error categories.

- `Armada DM configuration is invalid.`: verify the exact provider, SecretRef, one-owner allowlist, relay URLs, and time bounds shown above.
- `Nostr bot identity is unavailable or invalid.`: run `openclaw secrets audit`, confirm the provider is `singleValue`, reload secrets, and restart. Never paste the `nsec` into channel configuration or logs.
- `Relay publication failed.` with `publishInbox: true`: at least one discovery relay must accept and return the bot-authored kind-10050 before readiness succeeds.
- No live subscriptions: inspect each relay's sanitized connection, AUTH, and subscription state. One failed relay is degraded redundancy; all failed relays prevent readiness.
- `Replay protection is unavailable.`: inbound dispatch is intentionally stopped until durable storage is healthy and the gateway is restarted.
- Increasing queue-drop or rate-limit counters: the bot is overloaded or the authenticated owner is sending faster than the bounded policy permits.

## Bot-key rotation

Rotation creates a new Nostr bot identity; it is not an in-place credential refresh. Stop the gateway, atomically replace the dedicated secret file using the same mode-0700 directory and mode-0600 file discipline, then run `openclaw secrets audit`, `openclaw secrets reload`, and restart. Confirm the new public key/`npub` and verified kind-10050 in the probe, then deliberately move the Armada contact to the new bot identity. The new public key also creates a new replay namespace; old conversation history and contact identity do not silently migrate.

## Unsupported features

The plugin supports inbound encrypted files/media, direct text replies, and outbound ephemeral Armada typing notifications for an admitted owner turn. It does not implement outbound media uploads/replies, groups, public notes, NIP-04, plaintext remote attachments, reactions, deletes, edits, inbound typing, presence, disappearing messages, scheduled sends, unsolicited bot-initiated DMs, or a native command registry.
