# Nostr Armada DM Bot — Implementation Plan

## 1. Objective

Build a standalone OpenClaw channel plugin that lets people talk privately to an OpenClaw agent from Armada using standard Nostr end-to-end encrypted direct messages:

- NIP-17 `kind:14` direct-message rumors;
- NIP-44 v2 encryption;
- NIP-59 `kind:13` seals and `kind:1059` gift wraps;
- one-to-one direct conversations only.

The plugin should use [`Ink-North/nostr-nip17-plugin`](https://github.com/Ink-North/nostr-nip17-plugin) as the recognizable OpenClaw channel-integration template: package metadata, runtime/setup entry separation, channel registration, runtime injection, the simple `dmPolicy: "allowlist"`/`allowFrom` configuration, and local npm installation. Its legacy portable-bundle metadata and Nostr transport must not be copied blindly; the implementation must use the native plugin contract and public SDK exports available in OpenClaw `2026.6.1` (`2e08f0f`) plus the stricter cryptographic, routing, replay, and lifecycle requirements in this plan.

[`Tunnelsats/nostr-community-bot`](https://github.com/Tunnelsats/nostr-community-bot) is only a technical reference for Nostr cryptography, relay lifecycle, replay protection, and tests. The plugin has no TunnelSats product, identity, namespace, business-logic, or runtime dependency.

Working identifiers used by this plan:

- npm package: `openclaw-armada-dm` (unscoped and installable from a local directory or npm tarball; registry publication is optional);
- OpenClaw plugin ID: `armada-dm`;
- OpenClaw channel ID: `nostr`, matching `nostr-nip17` and the existing `channels.nostr` configuration;
- direct-session identity form: `nostr:<64-char-hex-pubkey>`, derived only from an authenticated inbound sender.

These names can be changed before the initial publish without affecting the architecture.

## 2. Sources reviewed

This plan is based on the following implementations and specifications as of 2026-08-25:

- [`nostr-community-bot` at `7ecc4b4`](https://github.com/Tunnelsats/nostr-community-bot/tree/7ecc4b4053a961f163e428fc08e487b07e571e72), especially `src/nip17-dm.ts`, `src/relay-connection-manager.ts`, `src/bot.ts`, and their Vitest suites;
- [`Ink-North/nostr-nip17-plugin` at `e824a82`](https://github.com/Ink-North/nostr-nip17-plugin/tree/e824a82e04eea27aa7a237b7feeeca9bead3e0d1), especially its `package.json`, `openclaw.plugin.json`, portable runtime/setup entry separation, channel registration, runtime injection, and simple allowlist configuration. Its package-name mismatch, legacy portable-bundle shape, permissive schemas, NIP-04 support, outer-event dedupe, and direct relay transport are explicitly not normative for this project;
- [Armada at `5b99f88`](https://github.com/soapbox-pub/armada/tree/5b99f88d309052abc1eeb4f0b2ef437de086e709), especially its [NIP-17 protocol implementation](https://github.com/soapbox-pub/armada/blob/5b99f88d309052abc1eeb4f0b2ef437de086e709/src/lib/nip17/protocol.ts), [DM transport](https://github.com/soapbox-pub/armada/blob/5b99f88d309052abc1eeb4f0b2ef437de086e709/src/hooks/useDm17.ts), and [relay defaults](https://github.com/soapbox-pub/armada/blob/5b99f88d309052abc1eeb4f0b2ef437de086e709/src/lib/platform.ts);
- [OpenClaw `2026.6.1` at `2e08f0f`](https://github.com/openclaw/openclaw/tree/2e08f0f4221f522b60423ed6ffd83427942b28de), particularly its official Nostr channel, public plugin-SDK exports, package/setup contract, SecretRef implementation, persistent-dedupe helper, and channel-plugin guide as they existed at that revision;
- [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md), [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md), [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md), and [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md).

Important interoperability finding: Armada is the client, not one fixed messaging server. Its builds read and write NIP-17 DMs through configurable DM/app relays and discover a recipient's `kind:10050` inbox relays. The plugin defaults its own inbox to `wss://relay.armada.buzz`, `wss://relay.ditto.pub`, and `wss://relay.dreamith.to`; discovery defaults to Ditto and Dreamith. A recipient's valid `kind:10050` list is authoritative. It also publishes a separate self-addressed gift wrap for sender-side recovery.

## 3. Scope

### Goals

1. Install and register as an OpenClaw text channel.
2. Load a dedicated Nostr bot identity from an OpenClaw file SecretRef whose single value is an `nsec`, without exposing the secret key.
3. Subscribe to `kind:1059` events whose outer `p` tag names the bot.
4. Strictly unwrap, decrypt, validate, and authenticate one-to-one `kind:14` rumors.
5. Use the authenticated inner author—not the gift wrap's random author—as the OpenClaw sender and session identity.
6. Admit only the one statically configured owner through OpenClaw's allowlist ingress policy before agent dispatch.
7. Route accepted plaintext to an OpenClaw agent as a direct conversation.
8. Send agent responses as fresh NIP-17/NIP-59 gift wraps to the user.
9. Prefer recipient inbox relays from `kind:10050`, automatically using the configured relays when the single owner has no usable announcement.
10. Survive relay failures and reconnect without duplicate agent turns.
11. Provide a documented manual configuration flow, status/probe output, tests, and a release-ready package.
12. Show an encrypted Armada typing indicator while an admitted owner's agent turn is active.

### Non-goals for the first release

- Public notes, public channels, rooms, or group messages.
- NIP-29 groups, Armada Concord communities, membership, roles, invitations, mentions, or room discovery.
- The official Buzz room protocol (`kind:9`, room UUIDs, threads, rich diffs, or room membership events).
- Lightning, LND, CLN, zaps, node lookup, or TunnelSats business logic.
- A plugin-owned slash-command registry or native command catalog.
- Porting `parseCommand`, `registerCommand`, `CommandContext`, or command handlers from `nostr-community-bot`.
- Media/file DMs (`kind:15`), reactions, deletes, message edits, disappearing-message timers, or presence.
- NIP-04 legacy DMs or an automatic privacy downgrade.
- NIP-46 remote signing or plugin-generated keys in v1. The operator supplies a dedicated `nsec` in a permission-restricted secret file, resolved through OpenClaw's secret-input system.
- Contact/profile search or mutable display-name-based addressing. Stable pubkeys are the identity boundary.

OpenClaw may still interpret its own textual control commands after an authorized message enters the normal inbound pipeline. That is core OpenClaw behavior, not a command registry implemented by this plugin.

## 4. Product behavior

### Inbound conversation

1. A user opens a direct conversation with the bot's `npub` in Armada.
2. Armada constructs an unsigned `kind:14` rumor, a sender-signed `kind:13` seal, and a fresh ephemeral-key `kind:1059` gift wrap addressed to the bot.
3. The plugin receives the wrap from any configured inbox relay.
4. It validates and decrypts both encrypted layers locally.
5. It authenticates the sender from the seal/rumor relationship.
6. It deduplicates on the inner rumor ID and checks the authenticated author against the single configured owner.
7. If admitted, it dispatches the plaintext to the bound OpenClaw agent in a session scoped to that sender pubkey.
8. The agent's final text is sealed and gift-wrapped back to the sender and appears in Armada's DM view.

### Human-initiated reply conversation

The human owner always initiates the conversation with a valid NIP-17 DM. The bot accepts that conversation by authenticating and admitting the owner message, then replies only through the delivery callback associated with that inbound turn. There is no standalone outbound or shared `message`-tool adapter in v1.

Every reply includes an `e` tag for the triggering rumor ID. This preserves NIP-17 reply context without exposing OpenClaw thread semantics. The channel declares direct-chat support and no native threads.

### Single-owner access control

`dmPolicy` is fixed to `allowlist`. `allowFrom` contains exactly one normalized owner `npub` or hex pubkey. Pairing-store augmentation is disabled, so historical approvals cannot broaden access. Pairing, open access, disabled mode, multiple owners, and plugin-owned approval state are outside v1.

Policy evaluation uses the authenticated inner sender pubkey. Outer gift-wrap pubkeys are random and must never be used for authorization, session routing, rate limiting, or display identity.

## 5. Architecture

```text
Armada client
  -> recipient DM/app relays
  -> kind 1059 subscription (#p = bot pubkey)
  -> relay/auth + reconnect manager
  -> NIP-59 unwrap / NIP-44 decrypt / NIP-17 validation
  -> replay and freshness gate (inner rumor ID)
  -> OpenClaw single-owner allowlist gate
  -> direct session for authenticated sender pubkey
  -> OpenClaw agent
  -> conversation-bound reply adapter
  -> kind 10050 recipient-relay discovery + Armada fallback relays
  -> peer gift wrap + bot self-copy gift wrap
  -> relays
  -> Armada client
```

Keep four boundaries explicit:

1. `nip17.ts` owns event construction, encryption, decryption, and structural validation.
2. `relay-*` modules own WebSocket connections, NIP-42, subscriptions, reconnects, and publication acknowledgements.
3. `inbound.ts` owns mapping a verified rumor into OpenClaw's authorization and dispatch contracts.
4. `channel.ts`/`gateway.ts` own OpenClaw lifecycle, account configuration, reply delivery, and outbound results.

Crypto and relay code must not import OpenClaw agent/runtime internals. OpenClaw adapters must not duplicate cryptographic parsing.

## 6. Proposed repository layout

```text
.
├── AGENTS.md
├── LICENSE
├── README.md
├── SECURITY.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── eslint.config.js
├── openclaw.plugin.json
├── index.ts
├── setup-entry.ts
├── .github/workflows/ci.yml
├── scripts/
│   ├── smoke-built-artifact.mjs
│   ├── smoke-install-paths.mjs
│   ├── smoke-packed-artifact.mjs
│   ├── validate-package.mjs
│   └── validate-sdk-imports.mjs
├── dist/                       # generated, published JavaScript
│   ├── index.js
│   ├── setup-entry.js
│   └── src/
├── docs/
│   └── IMPLEMENTATION_PLAN.md
└── src/
    ├── channel.ts
    ├── config-schema.ts
    ├── gateway.ts
    ├── inbound.ts
    ├── identity.ts
    ├── nip17.ts
    ├── relay-manager.ts
    ├── relay-session.ts
    ├── relay-routing.ts
    ├── runtime.ts
    ├── types.ts
    └── __tests__/
        ├── channel.test.ts
        ├── config-schema.test.ts
        ├── gateway.test.ts
        ├── inbound.test.ts
        ├── nip17.test.ts
        ├── relay-manager.test.ts
        ├── relay-routing.test.ts
        ├── documentation.test.ts
        ├── metadata.test.ts
        └── relay-session.test.ts
```

`AGENTS.md` should retain the project's TDD, strict TypeScript, zero-vulnerability, and key-hygiene rules, updated for the OpenClaw plugin structure. `dist/` is generated by the build, included in the npm package, and verified rather than hand-edited.

## 7. Template adaptation map

### Reuse from `Ink-North/nostr-nip17-plugin`

Use the pinned Ink-North repository as the OpenClaw integration template, with the OpenClaw `2026.6.1` source and documentation taking precedence over legacy template fields:

| Template area                          | Action in this repository                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json` OpenClaw metadata       | Reproduce the extension/setup/channel/install/compatibility metadata under the single consistent package name `openclaw-armada-dm`; add current built-runtime entry fields and a strict `files` allowlist.         |
| Runtime/setup entry separation         | Keep `index.ts` and the minimal compatibility-only `setup-entry.ts` import-safe and publish matching built entries. Importing either entry must not prompt, mutate configuration, read secrets, or load transport. |
| Channel registration/runtime injection | Adapt the public SDK registration and runtime setter for channel ID `nostr`, while keeping plugin ID `armada-dm`.                                                                                                  |
| Single-owner DM policy integration     | Use OpenClaw's ingress authorization with `useDefaultPairingStore: false`; require one configured owner and do not create or consume pairing state.                                                                |
| Local npm workflow                     | Preserve the ability to install the built package with `npm install /absolute/path/to/openclaw-armada-dm` from an npm-managed local OpenClaw checkout, and also test the supported managed `npm-pack:` flow.       |

Do not copy the template's NIP-04 path, multi-account behavior, permissive schemas, outer-event-ID dedupe, configured-relay-only publication, sender/event logging, legacy `kind: "bundled-channel-entry"`, or `openclaw.bundle.json`. This project is a native, single-account, NIP-17-only plugin.

### Reuse from `nostr-community-bot`

| Template area                     | Action in this repository                                                                                                                                                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/nip17-dm.ts`                 | Port the strict gift-wrap/seal/rumor validation and sanitized errors into `src/nip17.ts`. Extend automatic reply creation for recipient relay hints and sender self-copies.                                                                                                   |
| `src/relay-connection-manager.ts` | Reuse the lifecycle model: concurrent connections, bounded exponential reconnect, subscription restoration, status snapshots, idempotent stop, and publish-to-at-least-one semantics. Split connection/auth details into `relay-session.ts`.                                  |
| `src/bot.ts` replay handling      | Reuse only rumor-age checks, bounded in-memory in-flight suppression, and stop-time dispatch guards. Replace its durable behavior with OpenClaw 2026.6.1's `createClaimableDedupe` persistent claim/commit/release helper, keyed by account and authenticated inner rumor ID. |
| `event-utils.ts` key parsing      | Reuse the sanitized decoder and scalar validation, but expose only the file-resolved `nsec` input path in v1; raw hex private keys are rejected. Integrate it with OpenClaw `SecretInput` resolution.                                                                         |
| Vitest suites                     | Port the positive/negative cryptographic vectors and relay lifecycle tests before implementation changes.                                                                                                                                                                     |

### Deliberately omit from `nostr-community-bot`

- `parseCommand` and all command registration/dispatch types;
- `registerCommand`, `getRegisteredCommands`, and command-specific tests;
- Lightning/node dependencies or handlers;
- any advertised community, group, or Armada Concord behavior;
- publishing every reply blindly to only the configured relay set.

### Reuse from the OpenClaw 2026.6.1 channel SDK and bundled Nostr/Buzz plugins

Reuse patterns, not room behavior:

- `defineChannelPluginEntry` and a lightweight `setup-entry.ts`;
- `createChatChannelPlugin`, account resolution, status snapshots, and the inbound reply callback;
- gateway cancellation/reconnect behavior and active-account transport lookup;
- `resolveStableChannelMessageIngress`, `StableChannelIngressIdentityParams`, stable ingress identity, `dispatchInboundDirectDmWithRuntime`, and the bundled Nostr channel's dispatch structure;
- secret-input ownership and manual channel-configuration conventions.

Do not port Buzz room discovery, membership, directory groups, group allowlists, mentions, room typing, presence, rich diffs, thread routing, room profiles, or kind-9 message construction. Slice 09 independently implements Armada's encrypted one-to-one DM typing extension.

### Package and local-install contract

`package.json` must use one identity consistently:

- `name: "openclaw-armada-dm"`;
- `type: "module"`;
- `files`: built `dist`, `openclaw.plugin.json`, `README.md`, `LICENSE`, and `SECURITY.md` only;
- `openclaw.extensions: ["./dist/index.js"]`;
- `openclaw.setupEntry: "./dist/setup-entry.js"`;
- channel metadata with ID `nostr`;
- `openclaw.install.npmSpec: "openclaw-armada-dm"`, `minHostVersion: ">=2026.6.1"`, and npm as the default remote choice if the package is ever published;
- `openclaw.compat.pluginApi: ">=2026.6.1"`;
- `openclaw.build.openclawVersion` and `openclaw.build.pluginSdkVersion` set to `2026.6.1`;
- all runtime imports, including `nostr-tools`, declared in `dependencies`; OpenClaw remains a `peerDependency` and test/dev dependency.

`openclaw.plugin.json` must declare plugin ID `armada-dm`, `kind: "channel"`, channel `nostr`, an inline strict plugin-config schema, and the native-plugin metadata accepted by OpenClaw 2026.6.1. It must not declare the Ink-North template's legacy bundled-channel kind. The runtime channel schema remains the authority for `channels.nostr`; plugin-entry config is empty in single-account v1 and rejects unknown keys.

Published or packed artifacts must already contain built JavaScript. Installation must not depend on `postinstall`, `prepare`, TypeScript execution, network access, or lifecycle scripts because OpenClaw's managed npm installer ignores package scripts.

Two clean-host paths must be tested:

1. Literal local-checkout workflow requested for this project: from an npm-managed local OpenClaw checkout, run `npm install /absolute/path/to/openclaw-armada-dm`, enable `armada-dm`, restart the gateway, and verify runtime discovery.
2. OpenClaw-managed local artifact workflow: run `npm pack`, then `openclaw plugins install npm-pack:/absolute/path/openclaw-armada-dm-<version>.tgz`, enable the plugin, and verify runtime discovery.

The README must explain that a bare `npm install` is only the contract for an npm-managed local OpenClaw checkout. Other installations should use OpenClaw's managed `npm-pack:` command so the plugin is registered, dependency-checked, and removable through OpenClaw.

Because `nostr` is a shared channel ID, installation must fail clearly if another enabled plugin already owns it. The migration guide must tell operators to disable/remove the previous `nostr-nip17` or bundled Nostr channel plugin while preserving `channels.nostr` and `secrets.providers.nostr`, then enable plugin ID `armada-dm`. Existing pairing approvals may remain on disk but are deliberately ignored by this plugin; installation must not delete them or broaden the configured owner. Contract tests must prove that ownership conflicts do not silently select one implementation.

### OpenClaw 2026.6.1 compatibility baseline

OpenClaw `2026.6.1` at full commit `2e08f0f4221f522b60423ed6ffd83427942b28de` is the minimum required and release-blocking host:

- compile and typecheck against exactly `openclaw@2026.6.1`, not a floating newer SDK;
- run package discovery, setup-entry import, SecretRef resolution, channel registration, single-owner ingress, reply delivery, status, and gateway lifecycle smoke tests against that exact host build;
- use built JavaScript directly in `openclaw.extensions`/`openclaw.setupEntry`; do not emit the later `runtimeExtensions` or `runtimeSetupEntry` fields;
- use `resolveStableChannelMessageIngress`, `dispatchInboundDirectDmWithRuntime`, and `createClaimableDedupe`, which are present in this revision;
- do not import the later durable ingress monitor, ingress effect-once, or later-only setup/runtime helpers;
- fail installation on hosts older than `2026.6.1` through `openclaw.install.minHostVersion` and `openclaw.compat.pluginApi`.

CI must run an API-baseline test that imports every declared `openclaw/plugin-sdk/*` subpath from an installed `openclaw@2026.6.1` package. Documentation from `main` is informative only; the pinned source tree is authoritative for v1.

## 8. Configuration contract

Proposed single-account v1 configuration:

```json5
{
  secrets: {
    providers: {
      nostr: {
        source: "file",
        path: "/home/claw/.openclaw/secrets/nostr_nsec",
        mode: "singleValue",
      },
    },
  },
  channels: {
    nostr: {
      enabled: true,
      name: "OpenClaw",
      privateKey: { source: "file", provider: "nostr", id: "value" },
      relays: [
        "wss://relay.armada.buzz",
        "wss://relay.ditto.pub",
        "wss://relay.dreamith.to",
      ],
      discoveryRelays: ["wss://relay.ditto.pub", "wss://relay.dreamith.to"],
      publishInbox: true,
      allowFallbackDelivery: true,
      allowPrivateRelays: false,
      dmPolicy: "allowlist",
      allowFrom: ["npub1..."],
      recoveryLookbackSeconds: 604800,
      maxFutureSkewSeconds: 300,
      maxMessageAgeSeconds: 604800,
      markdown: { tables: "bullets" },
    },
  },
}
```

Provision the key before configuring or starting the plugin:

```bash
install -d -m 700 /home/claw/.openclaw/secrets
umask 077
read -rsp 'Paste Nostr nsec: ' NSEC; printf '\n'
printf '%s\n' "$NSEC" > /home/claw/.openclaw/secrets/nostr_nsec
unset NSEC
chmod 600 /home/claw/.openclaw/secrets/nostr_nsec

openclaw config set secrets.providers.nostr \
  --provider-source file \
  --provider-path /home/claw/.openclaw/secrets/nostr_nsec \
  --provider-mode singleValue

openclaw config set channels.nostr.privateKey \
  --ref-provider nostr \
  --ref-source file \
  --ref-id value

openclaw secrets audit
openclaw secrets reload
openclaw gateway restart
```

The secret file `/home/claw/.openclaw/secrets/nostr_nsec` contains only the encoded key, with an optional final line ending:

```text
nsec1...
```

It is not JSON, an environment file, or a `NAME=value` assignment. The plugin caps the resolved value at 256 UTF-8 bytes and rejects multiple lines or any whitespace remaining after OpenClaw removes the conventional trailing line ending.

Field behavior:

- `privateKey`: exactly `{ source: "file", provider: "nostr", id: "value" }`. `secrets.providers.nostr` must use `source: "file"`, `path: "/home/claw/.openclaw/secrets/nostr_nsec"`, and `mode: "singleValue"`. OpenClaw reads the file, verifies its ownership/permissions, strips the conventional trailing newline, and passes the resolved value to the plugin. The resolved value must be exactly one valid `nsec`; raw hex, inline secrets, environment references, paths stored in channel config, empty values, and embedded whitespace are rejected in v1.
- `relays`: the bot's own DM inbox and optional Armada-compatibility fallback set. Normalize and deduplicate; default to `wss://relay.armada.buzz`, `wss://relay.ditto.pub`, and `wss://relay.dreamith.to` for redundant receipt.
- `discoveryRelays`: where the plugin queries and optionally publishes `kind:10050`; default to the same Ditto and Dreamith relays and remain configurable.
- `publishInbox`: explicit configuration consent for gateway startup to publish or replace the bot-authored `kind:10050` event naming `relays`. Disable it to preserve an independently managed announcement.
- `allowFallbackDelivery`: Armada compatibility mode, enabled by default for the sole configured owner. When the owner has no usable `kind:10050`, publish the encrypted reply to configured `relays`. It never adds fallback relays when a valid recipient list exists and never broadens sender authorization.
- `allowPrivateRelays`: disabled by default. Allows operator-configured private-network or insecure `ws://` relays after an explicit warning; it never relaxes validation for relay URLs learned from an untrusted recipient event.
- `dmPolicy`/`allowFrom`: `dmPolicy` is exactly `allowlist`; `allowFrom` contains exactly one owner and accepts `npub`, bare hex, or `nostr:` forms before canonical lowercase-hex storage/comparison. Wildcards, empty/multiple owners, and other policies are rejected.
- `recoveryLookbackSeconds`: relay recovery horizon after startup/reconnect; default seven days, valid range one hour through thirty days. It is distinct from replay protection.
- `maxFutureSkewSeconds`: maximum accepted inner-rumor clock lead; default five minutes, valid range zero through one hour.
- `maxMessageAgeSeconds`: authenticated-rumor age fence; default seven days, valid range one hour through thirty days. It must be at least `recoveryLookbackSeconds` and is never used as the primary replay defense.
- `markdown`: OpenClaw formatting policy. NIP-17 content remains a plain string; Markdown is transported as text.

Environment fallbacks may support only the non-secret `ARMADA_DM_RELAYS` and `ARMADA_DM_DISCOVERY_RELAYS` lists. The Nostr private key has no environment or inline fallback in v1. Secret values must never be copied into status objects, thrown errors, or logs.

The manifest's `channelConfigs.nostr.schema` must mirror the runtime Zod schema exactly and use `additionalProperties: false`. The plugin-entry `configSchema` is separately strict and empty for single-account v1. Set `peerDependencies.openclaw` to `>=2026.6.1`, compile and typecheck against exactly `openclaw@2026.6.1`, and upgrade the baseline deliberately with contract tests. Do not import an SDK symbol merely because it exists in newer OpenClaw documentation.

### Relay URL and outbound-network policy

Relay URLs from configuration and recipient-authored `kind:10050` events cross different trust boundaries:

- require `wss://` by default; configured `ws://` is allowed only with `allowPrivateRelays: true` and an operator warning;
- recipient-provided URLs are always restricted to `wss://`, regardless of `allowPrivateRelays`;
- reject credentials/userinfo, fragments, control characters, overlong URLs, unsupported ports, IP-literal obfuscation, and non-canonical hostnames;
- resolve DNS before connecting and reject loopback, unspecified, private, carrier-grade NAT, link-local, multicast, reserved/documentation, and cloud-metadata destinations for untrusted recipient-provided URLs, for both IPv4 and IPv6;
- bind the validated resolution to the socket connection or revalidate the connected peer address so DNS rebinding cannot bypass the policy;
- do not follow WebSocket redirects across origins, schemes, or validated address classes;
- enforce connect, TLS, handshake, AUTH, publish, idle, byte, and overall deadlines;
- cap relay URLs learned from one event and apply the policy again when cached entries are used.

Operator-configured private relays are a deliberate deployment exception. Recipient-controlled events can never cause the OpenClaw host to connect to its local network.

## 9. NIP-17/NIP-59 implementation contract

### Inbound validation

Treat every relay event as hostile. A wrap is accepted only when all checks pass:

1. The outer event is a valid signed Nostr event of kind `1059`.
2. It has exactly one `p` tag and that recipient is the bot's public key. Other harmless outer tags, such as Armada's first-contact `k` hint, may be present.
3. Its ciphertext and serialized event size are within named limits.
4. NIP-44 v2 decryption with the wrapper pubkey yields valid JSON for a signed kind-13 seal.
5. The seal signature is valid and its tags are empty for the v1 standards-only path.
6. NIP-44 v2 decryption with the seal author yields an unsigned rumor.
7. The rumor is kind `14`, has no `sig`, and has a valid computed NIP-01 ID. A message authored by somebody else must contain exactly one `p` tag naming the bot. A bot-authored rumor may instead contain the original peer's single `p` tag and is classified as a sender self-copy.
8. The rumor pubkey equals the seal pubkey. This is the critical anti-impersonation check.
9. The rumor timestamp is within `maxMessageAgeSeconds` and `maxFutureSkewSeconds`. Durable replay state, not this age fence, is the primary replay defense.
10. A bot-authored rumor is accepted only as a structurally valid sender self-copy and is ignored before replay claiming or dispatch so it cannot recursively invoke the agent.

Reject kind 15, reactions, deletes, multi-recipient rumors, subjects that imply a group, malformed tags, invalid signatures, oversized payloads, and unsupported extensions with one sanitized protocol error category. Never include ciphertext or plaintext in an error.

Use UTF-8 byte limits, not JavaScript string length. Keep the outgoing text chunk limit conservative (initially 16,000 characters) and enforce the NIP-44 65,535-byte plaintext ceiling after serializing the rumor and seal. Enforce a 131,072-byte maximum final outer event by default, independently of any relay advertisement, and allow only a lower operator override.

### Outbound construction

For each response text chunk produced by an admitted inbound owner turn:

1. Build an unsigned kind-14 rumor using the bot's real pubkey and current time.
2. Add exactly one `p` tag for the recipient.
3. Add an `e` tag when replying to an inbound rumor.
4. Compute the rumor ID.
5. Create a recipient-specific kind-13 seal, signed by the bot and NIP-44-encrypted to the recipient. Independently randomize the seal timestamp up to two days into the past.
6. Create a kind-1059 wrap with a new cryptographically random ephemeral key and an independently randomized timestamp up to two days into the past.
7. Repeat sealing/wrapping for the bot's own pubkey as a sender self-copy, as required by NIP-17 recovery behavior.
8. Publish the recipient copy to the resolved recipient/fallback targets and the self-copy to the bot's configured inbox relays.

Never reuse wrapper keys. Do not log wrapper keys, conversation keys, secret key bytes, plaintext, ciphertext, full events, or recipient/sender pairs.

### Relay discovery and routing

`relay-routing.ts` should:

- query the newest signature-valid kind-10050 event authored by the exact recipient on `discoveryRelays`, rejecting implausibly future-dated events;
- extract, normalize, and deduplicate `relay` tags;
- apply the untrusted relay URL/network policy before caching or connecting;
- cache positive and negative results for a bounded period (initially one hour);
- cap the number of remote-provided relay URLs used by one send;
- use the discovered relays as canonical destinations;
- never union fallback relays into a valid recipient list;
- fall back solely to configured relays when the owner has no valid list and `allowFallbackDelivery` is enabled (the single-owner default);
- return a clear, sanitized error when no destination remains.

The recipient copy succeeds when at least one target relay acknowledges it. Preserve per-relay failures for redacted diagnostics, but do not fail a successful send because a redundant relay was unavailable. The self-copy is best-effort after the recipient copy succeeds; its failure should be reported as degraded history recovery, not failed user delivery.

When `publishInbox` is enabled, gateway startup creates a signed replaceable kind-10050 event with one `relay` tag per configured inbox relay, publishes it to the discovery relay set, and verifies it before reporting ready. The configuration flag is the operator's consent to replace that bot identity's previous announcement.

## 10. Relay lifecycle

Implement one managed session per configured inbox relay:

- connect concurrently;
- handle NIP-42 challenges on configured inbox subscriptions by signing kind-22242 AUTH events with the bot identity and the exact relay URL/challenge bound to that socket;
- subscribe only after the session can satisfy authentication requirements;
- use `{ kinds: [1059], "#p": [botPubkey], since }`;
- calculate `since` from `recoveryLookbackSeconds` and subtract NIP-59's two-day timestamp-randomization window, while the authenticated rumor age fence is evaluated separately;
- restore AUTH and subscriptions after reconnect;
- reconnect with jittered exponential backoff from one to thirty seconds;
- reset the retry counter after a stable connection interval;
- expose `connecting`, `connected`, `reconnecting`, and `disconnected` snapshots;
- stop idempotently, cancel timers and connection attempts, close subscriptions/sockets, and await in-flight bookkeeping;
- prevent any event received after shutdown from entering OpenClaw.

Publication should reuse an active authenticated session when possible and open a bounded one-shot session for a relay that is not part of the bot's standing inbox set. Apply explicit connect, AUTH, publish-ack, and overall-send deadlines. A challenge is valid only for its originating connection and until replaced; cap its byte length and never log it. Recipient-relay AUTH may require the bot's real identity as described by NIP-59, so status and security documentation must warn that the authenticated relay can correlate the bot identity with that connection. Never authenticate to a relay that failed the URL/network policy.

## 11. Replay, concurrency, and failure semantics

Deduplicate by authenticated inner rumor ID, not outer wrap ID. The same rumor can arrive through several relays or be rewrapped, and each copy must still produce only one agent turn.

OpenClaw 2026.6.1 does not expose the later durable ingress monitor/effect-once APIs to this plugin. Use its public `createClaimableDedupe` helper from `openclaw/plugin-sdk/persistent-dedupe` for logical replay protection, and rely on relay persistence plus the backdated subscription for crash recovery:

1. At the single receive chokepoint, admit the bounded raw wrap to an account-scoped in-memory queue; a relay WebSocket has no acknowledgement/cursor that can be durably gated here.
2. Process the queue through bounded structural validation and decryption.
3. After authentication, call `claim` with the inner rumor ID and a namespace containing plugin ID, account ID, and bot pubkey. Differently wrapped or cross-relay copies therefore contend on one logical key.
4. Dispatch only the claim winner. An in-flight contender awaits the winner instead of starting another turn.
5. Call `commit` only after the OpenClaw inbound dispatch returns successfully. Call `release` on validation/authorization/dispatch failure before success so relay redelivery can retry.
6. Configure the persistent JSON store in the OpenClaw-resolved plugin state directory with a TTL at least as long as `maxMessageAgeSeconds`, a bounded file entry count sized for the expected message rate, and the SDK's cross-process file lock.

Wrap `createClaimableDedupe` because its 2026.6.1 persistent implementation reports disk errors through `onDiskError` and otherwise falls back to memory. A disk error during `claim` must release/reject the event and stop new account dispatch until persistence is healthy. A disk error during post-dispatch `commit` cannot undo an already completed turn: retain in-memory suppression, mark the account degraded, stop intake, and surface a sanitized operator error. Never quietly continue normal operation with memory-only replay state.

On restart, reconnect with the configured backdated `since`; conforming relays can redeliver stored gift wraps. This is relay-dependent recovery, not a local durable raw-event queue, and the limitation must be documented. The system does not claim mathematically exact-once agent side effects: a crash after agent/tool effects but before the dedupe commit can replay the turn. Acceptance guarantees one dispatch for ordinary cross-relay replay, rewrapping, reconnect, and same-process concurrency cases, while agent/tool permissions must assume this at-least-once crash edge.

Additional controls:

- cap concurrent decrypt operations and queued wraps;
- drop malformed/oversized traffic before expensive inner decryption where possible;
- apply a post-authentication per-sender rate limit before dispatch;
- require one static owner allowlist so unauthorized gift-wrap spam cannot reach the model;
- isolate errors per event so one bad wrap or failed agent turn does not kill the relay session;
- rely on relay redelivery plus claim/release semantics for recovery; do not invent an independent automatic agent retry loop;
- allow transport publication retry only while the OpenClaw delivery pipeline still owns the same response message.

### Mandatory resource limits

Define all limits in one typed `SECURITY_LIMITS` object and exercise their defaults and hard maxima in tests. Initial defaults:

| Control                              | Default                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| Serialized outer event               | 131,072 UTF-8 bytes                                                                |
| Outer/seal ciphertext string         | 100,000 UTF-8 bytes per layer                                                      |
| Tags                                 | 32 tags, 8 elements per tag, 1,024 UTF-8 bytes per element                         |
| Relay URL                            | 2,048 UTF-8 bytes                                                                  |
| Configured inbox/discovery relays    | 8 each                                                                             |
| Recipient-provided delivery relays   | 3                                                                                  |
| Raw in-memory ingress envelope       | 140,000 bytes                                                                      |
| In-memory pending decrypt queue      | 256 per account; reject newest on overflow                                         |
| Concurrent decrypt pipelines         | 8 per account                                                                      |
| Authenticated sender dispatch rate   | 10 messages/minute with burst 5                                                    |
| Owner authorization                  | Exactly one normalized `allowFrom` entry; unauthorized senders receive no response |
| Positive/negative discovery cache    | 1,000 entries each, one-hour TTL                                                   |
| Connect / TLS+WS / AUTH / publish OK | 5s / 10s / 5s / 10s                                                                |
| Overall recipient send               | 20 seconds                                                                         |

Values may be tuned before release using loopback load tests, but implementation must not proceed with unnamed or unbounded limits. Overload counters may identify the account and relay alias but must not log sender-recipient pairs, payloads, ciphertext, or full events.

## 12. OpenClaw integration details

### Channel declaration

`channel.ts` should declare:

- `chatTypes: ["direct"]`;
- `threads: false`;
- text/Markdown capability only;
- target prefix `nostr`;
- no groups, directory groups, media, reactions, polls, native commands, or inbound/OpenClaw typing capability; Slice 09's outbound DM heartbeat is transport-owned;
- reload prefix `channels.nostr`.

Use the narrow public `openclaw/plugin-sdk/*` entrypoints. Do not import OpenClaw core files under `src/channels/**`.

### Conversation identity

The canonical direct-session identity is `nostr:<lowercase-hex>`, derived only from the seal-authenticated inbound rumor author. The plugin does not parse user-supplied outbound targets or accept npub, nsec, event, group, room, or display-name destinations for sending.

### Inbound routing

After cryptographic validation, resolve the OpenClaw route with:

- channel: `nostr`;
- conversation kind: `direct`;
- conversation/peer ID: canonical target for the authenticated sender;
- stable sender subject: lowercase sender hex pubkey;
- message ID: rumor ID;
- reply target: canonical sender target;
- reply-to ID: inbound rumor ID.

Run OpenClaw 2026.6.1's `resolveStableChannelMessageIngress` with channel ID `nostr`, account ID, a Nostr-pubkey `StableChannelIngressIdentityParams`, `useDefaultPairingStore: false`, the canonical sender subject/conversation, fixed `dmPolicy: "allowlist"`, the sole raw `allowFrom` owner, and command facts. Pass its sender and command decisions into `dispatchInboundDirectDmWithRuntime`; do not reconstruct authorization from message fields later. Use the bundled 2026.6.1 Nostr channel as the compile-time integration reference, while retaining this plan's stricter log redaction and NIP-17 authentication.

The agent-facing body may label the sender with a short `npub`, but the stable ID remains hex. Do not fetch mutable profiles in v1.

### Reply adapter

Expose response text only through the delivery callback created for an admitted inbound direct-message turn. Do not expose the legacy outbound adapter or shared OpenClaw message adapter. Declare only capabilities proven by contract tests:

- durable final text: yes;
- native reply reference: yes, through the inner `e` tag;
- native threads: no;
- media/reactions/actions: no.

Return the inner rumor ID as `messageId`; outer wrap IDs are relay carriers and differ between recipient and self copies.

## 13. Manual configuration and operator experience

The plugin has no interactive setup wizard. The operator provisions the dedicated secret file, configures the `nostr` single-value file provider, adds the matching `channels.nostr.privateKey` SecretRef and channel fields to `openclaw.json`, enables the plugin, reloads secrets when needed, and restarts the gateway. The minimal `setup-entry.ts` exists only because OpenClaw `2026.6.1` expects a separate import-safe package entry.

The plugin must never open the configured secret path directly. OpenClaw owns path expansion, file reads, ownership/permission checks, byte limits, trailing-newline removal, and SecretRef resolution. Runtime identity validation accepts only one resolved `nsec` encoding a non-zero secp256k1 scalar and must not accept or persist it through normal channel configuration, a command-line argument, an environment variable, status, or logs.

The operator owns secret and channel provisioning. If the provider/SecretRef shape is wrong or the resolved secret is missing, empty, oversized, multi-value, or invalid, the channel remains unconfigured or startup fails with a category-only diagnostic. Documentation directs the operator to correct the configuration, run `openclaw secrets audit`, reload secrets, restart the gateway, and inspect `openclaw channels status --probe`.

Document rotation as a new bot identity: stop the gateway, atomically replace `/home/claw/.openclaw/secrets/nostr_nsec` using the same `umask 077`/mode-0600 discipline, run `openclaw secrets audit`, run `openclaw secrets reload`, restart the gateway, publish the new kind-10050, display the new npub, and require the owner contact to move deliberately. Key rotation must never silently reuse the old replay namespace for a different pubkey.

Status output should include account ID, enabled/configured/running state, bot public key, configured relay count, per-relay state, and the last sanitized transport error. It must never include the secret key, decrypted text, ciphertext, AUTH challenge, owner identity, or contact graph.

Document this trust boundary prominently: NIP-17 protects content and most metadata from relays and passive observers. Plaintext necessarily exists inside the OpenClaw host and is sent to the configured model/provider according to the operator's OpenClaw setup. This is transport E2EE, not end-to-end secrecy from the agent runtime.

## 14. Functional implementation slices

Implementation work is divided into the following ordered, agent-ready files. Each slice produces a demonstrable functional outcome and has its own dependencies, scope, tests, security invariants, deliverables, and hard exit gate. An implementation agent should take one file, implement only that slice, and leave later-slice behavior out unless it is required by the current slice's interface.

1. [`01-installable-plugin-and-identity.md`](implementation-slices/01-installable-plugin-and-identity.md) — locally install the plugin, resolve the file-backed bot identity, and expose a safe public status.
2. [`02-nip17-cryptographic-core.md`](implementation-slices/02-nip17-cryptographic-core.md) — decrypt/authenticate Armada-compatible requests and construct decryptable NIP-17 replies offline.
3. [`03-relay-presence-and-inbox.md`](implementation-slices/03-relay-presence-and-inbox.md) — connect, authenticate, subscribe, publish the bot kind-10050, and report actual reachability.
4. [`04-allowlisted-ai-roundtrip.md`](implementation-slices/04-allowlisted-ai-roundtrip.md) — deliver the first complete owner-to-bot-to-AI-to-owner encrypted conversation.
5. [`05-pairing-and-dm-policies.md`](implementation-slices/05-pairing-and-dm-policies.md) — lock the channel to one configured owner and add automatic configured-relay fallback.
6. [`06-conversation-bound-replies-and-self-copy.md`](implementation-slices/06-conversation-bound-replies-and-self-copy.md) — keep replies bound to human-initiated conversations and add independent sender recovery copies.
7. [`07-replay-resilience-and-resource-limits.md`](implementation-slices/07-replay-resilience-and-resource-limits.md) — harden duplicates, restarts, relay failures, shutdown, and overload behavior.
8. [`08-setup-interoperability-and-release.md`](implementation-slices/08-setup-interoperability-and-release.md) — complete manual configuration guidance, probes, real Armada staging, packaging, and release evidence.
9. [`09-armada-typing-notifications.md`](implementation-slices/09-armada-typing-notifications.md) — publish Armada-compatible encrypted ephemeral typing notifications only while an admitted owner turn is active.

Slices are sequential: an agent starts only after every dependency's exit gate is green. For every slice, follow red-green-refactor: add a focused failing test, observe the intended failure, implement the minimum change, then refactor with focused and full suites green. The detailed coverage inventory below remains normative; the slice files assign those requirements to implementable work packets.

### Coverage group 1 — Scaffold and configuration

**Red**

- Manifest recognizes exactly the `nostr` channel under plugin ID `armada-dm`.
- Package name, install hint, plugin ID, channel ID, source entries, and built runtime entries are mutually consistent.
- Manifest uses `kind: "channel"`; package entries point directly to built JavaScript; compatibility/install/build metadata all name OpenClaw `2026.6.1`; later-only runtime-entry fields are absent.
- Every imported `openclaw/plugin-sdk/*` subpath resolves and typechecks from exactly `openclaw@2026.6.1`.
- Startup fails with a clear ownership diagnostic when another enabled plugin already registers channel `nostr`; migration preserves configuration but never silently replaces a runtime owner.
- Runtime and JSON schemas accept the pre-provisioned `nostr` file provider and matching `channels.nostr.privateKey` SecretRef plus valid relay/DM-policy configuration.
- Missing/mismatched providers, inline/env/exec secret inputs, file refs whose provider is not `nostr` or whose ID is not `value`, invalid protocols, empty relay sets, unknown keys, bad recovery/age/skew values, and invalid allowlist entries fail with sanitized errors.
- Package entry discovery does not open sockets or load the heavy crypto/transport path.
- `npm pack --dry-run` contains built JavaScript, the manifest, README, LICENSE, and SECURITY documentation, and excludes sources/secrets/fixtures not required at runtime.

**Green**

- Add package/build/lint/test configuration, current native manifest, source and built entrypoints, runtime setter, config schema, account resolver, file SecretRef resolution contract, and nsec-only identity parsing.
- Use ESM, strict TypeScript, `nostr-tools`, Zod, Vitest, ESLint, and Prettier.

**Exit**

- `npm test`, `npm run lint`, `npm run build`, package validation, and `npm pack --dry-run` pass.
- `npm audit` reports zero vulnerabilities.
- A clean npm-managed local OpenClaw `2026.6.1` checkout discovers the plugin after `npm install /absolute/path/to/openclaw-armada-dm`; a clean managed OpenClaw `2026.6.1` install also discovers the packed tarball through `npm-pack:`.
- The migration smoke test disables the prior Nostr plugin, preserves `secrets.providers.nostr` and `channels.nostr`, configures exactly one owner, enables plugin `armada-dm`, audits/reloads secrets, restarts the gateway, and proves existing `nostr` pairing approvals are ignored rather than deleted or imported.

### Coverage group 2 — NIP-17 cryptographic core

**Red**

- Valid Armada-compatible gift wrap decrypts to the authenticated kind-14 rumor.
- A resolved single-value `nsec`, including the normal secret-file trailing newline stripped by OpenClaw, derives the expected public key; raw hex, embedded whitespace, and invalid/out-of-range keys are rejected.
- Invalid outer kind/recipient/signature, invalid seal kind/signature/tags, malformed JSON/ciphertext, rumor signature presence, wrong rumor hash, sender/seal mismatch, wrong/multiple recipients, unsupported kind, oversized payload, and future timestamp are rejected.
- Errors never include secret keys, plaintext, or ciphertext.
- Two identical replies use different wrapper keys and wrap IDs.
- Recipient and self-copy wraps decrypt to the same rumor ID.
- Reply construction includes the expected `p` and `e` tags.
- Recipient seal, self-copy seal, and their wraps use independent past-randomized timestamps inside the two-day window.

**Green**

- Port and adapt the `nostr-community-bot` reference's key parsing and NIP-17 code; do not port the Ink-North transport implementation.
- Add conversation-bound reply construction and self-copy support.

**Exit**

- Unit tests require no network and use deterministic clocks/fixtures except where wrapper randomness is the behavior under test.

### Coverage group 3 — Relay transport and authentication

**Red**

- Multiple inbox relays connect concurrently and independently.
- Bot-addressed kind-1059 subscriptions include `#p` and the correct backdated `since`.
- NIP-42 challenges are signed with the bot key and exact relay URL.
- Challenges cannot cross connections, expired/replaced challenges are not signed, and failed URL-policy destinations are never authenticated.
- A dropped connection reconnects with bounded backoff and restores AUTH/subscription.
- Publishing succeeds when at least one target acknowledges and fails when none do.
- Start/stop are idempotent; stop cancels reconnects and late event delivery.
- Handler rejection and malformed events do not terminate the session.

**Green**

- Implement `relay-session.ts` and `relay-manager.ts` behind injectable WebSocket/relay interfaces.
- Port the template lifecycle behavior and add NIP-42 plus targeted one-shot publication.

**Exit**

- No tests use public relays.
- Fake timers cover reconnect schedules without real waiting.

### Coverage group 4 — Replay gate and inbound OpenClaw dispatch

**Red**

- Cross-relay duplicates and differently wrapped copies of one rumor cause one dispatch.
- Raw wraps enter a bounded in-memory queue; inner-rumor dedupe is claimed with OpenClaw 2026.6.1's `createClaimableDedupe` after authentication and committed only after successful dispatch.
- A failed dispatch releases the claim; a successful dispatch commits it; differently wrapped and concurrent copies cannot both dispatch during normal operation.
- Dedupe disk failures stop account intake and surface a sanitized degraded state rather than silently continuing with memory-only replay protection.
- Restart tests redeliver stored wraps through the loopback relay and exercise the documented crash window; no test asserts a later durable-ingress API or impossible absolute exactly-once side effects.
- Stale/future/self-authored rumors do not dispatch.
- The authenticated inner sender becomes the direct peer, session, sender ID, and reply target.
- The ephemeral wrapper pubkey appears nowhere in authorization or routing.
- The sole configured owner behaves through OpenClaw's ingress resolver with pairing-store augmentation disabled.
- An unauthorized sender never reaches the model and receives no response.
- Shutdown racing an inbound decrypt cannot start a new agent turn.

**Green**

- Implement the bounded receive queue, 2026.6.1 claimable-dedupe compatibility adapter, age/skew gate, `inbound.ts`, and gateway dispatch wiring.
- Build the exact channel inbound context from the host ingress result.

**Exit**

- Two senders get separate direct sessions.
- No group or mention policy path is present.

### Coverage group 5 — Recipient relay discovery and reply delivery

**Red**

- Newest valid kind-10050 wins; malformed/duplicate/non-WebSocket relay tags are ignored.
- Invalid signatures, wrong authors, future-dated events, credentials, redirects, insecure schemes, private/loopback/link-local/metadata addresses, and DNS rebinding are rejected before connection.
- Discovery is cached and bounded.
- A recipient list routes to those relays.
- A valid recipient list is never unioned with fallback relays.
- Missing owner kind-10050 uses configured Armada compatibility relays by default; strict mode can explicitly disable fallback.
- No destination fails before encryption/publication side effects.
- Every automatic response produces peer and self-copy wraps with the same rumor ID.
- Every response uses the triggering inbound rumor's `e` tag.
- Peer delivery success is not overturned by self-copy failure.
- Oversized Unicode content is chunked/rejected before producing an invalid NIP-44 envelope.
- No standalone outbound target parser or message adapter is exposed.

**Green**

- Implement `relay-routing.ts`, conversation-bound reply delivery, active transport reuse, and sender recovery publication.
- Return the rumor ID through the conversation-bound delivery result.

**Exit**

- Outbound and inbound-reply tests decrypt the emitted wraps with independent recipient keys.

### Coverage group 6 — Manual configuration and status

**Red**

- Runtime consumes the already configured `nostr` single-value file provider and matching `channels.nostr.privateKey` SecretRef; plugin code never reads or repairs the file.
- Missing/mismatched configuration and missing, empty, oversized, invalid, or multi-value resolved secrets fail closed without printing their contents.
- `publishInbox: true` is explicit consent for startup to publish and verify the configured bot kind-10050 tags.
- The compatibility-only setup entry imports without prompting, configuration mutation, secret access, or transport startup.
- Probe/status distinguish invalid configuration/identity, unreachable relays, AUTH/subscription state, missing inbox announcement, dedupe degradation, queue drops, authenticated rate limiting, partial operation, and healthy operation without sensitive details.

**Green**

- Implement manual configuration validation, startup inbox announcement, status snapshots, documentation, and release probes.

**Exit**

- An operator with a prepared `nsec` secret file can install, configure `openclaw.json`, restart, obtain the bot npub, and exchange a DM without a setup wizard or placing the secret in channel configuration.

### Coverage group 7 — Interoperability, packaging, and hardening

**Automated**

- Add a loopback WebSocket relay harness covering EVENT/OK, REQ/EOSE, reconnect, and NIP-42 AUTH.
- Run a full encrypted round trip: disposable Armada-like sender -> relay -> plugin -> mocked OpenClaw dispatch -> encrypted reply -> sender decrypt.
- Assert kind-1059 carrier events contain neither message plaintext nor the real sender pubkey outside encrypted layers. Separately assert and document that a relay receiving a NIP-42 AUTH event can observe the authenticating bot pubkey even though AUTH is not published as a stored DM event.
- Assert package import, setup import, and disabled-channel discovery do not start background work.
- Run tests, coverage, lint, build, native package/manifest validation, the 2026.6.1 SDK-import baseline, both local-install smoke paths on an exact 2026.6.1 host, package dry-run, package-content allowlist, and zero-vulnerability audit in CI.

**Manual staging**

1. Use disposable bot and user keys.
2. Publish the bot's kind-10050 to the configured discovery relays.
3. Add the bot npub as a DM peer in the current Armada web/desktop client.
4. Verify first-contact delivery through `wss://relay.armada.buzz`, `wss://relay.ditto.pub`, and `wss://relay.dreamith.to`.
5. Verify the sole configured owner completes a normal multi-turn conversation without pairing.
6. Stop the gateway, send a message, restart inside `recoveryLookbackSeconds`, and confirm one turn.
7. Deliver the same rumor from two relays and confirm one turn.
8. Break one relay and confirm degraded but successful delivery through another.
9. Verify no plaintext/secret appears in gateway logs or relay-side event JSON.

**Release**

- Pack an initial prerelease and test both local `npm install` and OpenClaw-managed `npm-pack:` installation into clean OpenClaw `2026.6.1` (`2e08f0f`) instances. Registry publication is optional.
- Promote to `1.0.0` only after the current Armada client initiates a conversation, receives an automatic reply, and the bot safely recognizes its recovery copy.

## 15. Required documentation

The README should include:

- what the plugin does and does not do;
- local npm-checkout installation, OpenClaw-managed `npm-pack:` installation, channel-ownership migration, a complete `openclaw.json` example, and enable/reload/restart/inspect commands;
- the exact `/home/claw/.openclaw/secrets/nostr_nsec` provisioning commands, mode-0700 directory and mode-0600 file requirements, `secrets.providers.nostr` single-value provider, `channels.nostr.privateKey` SecretRef commands, audit/reload/restart sequence, failure diagnostics, and rotation procedure;
- how to copy/share the bot npub in Armada;
- single-owner `dmPolicy: "allowlist"` and `allowFrom: ["npub1..."]` configuration;
- Armada/Ditto/Dreamith inbox defaults, Ditto/Dreamith discovery defaults, relay URL/network restrictions, kind-10050 discovery, automatic owner fallback delivery, and its relay-metadata tradeoff;
- the human-initiated conversation flow and absence of unsolicited/scheduled sends;
- status/probe and troubleshooting instructions;
- the OpenClaw-host/model plaintext trust boundary;
- supported outbound Armada DM typing behavior and unsupported media, reactions, groups, NIP-04, presence, and disappearing messages.

`SECURITY.md` should cover file-secret ownership/permissions and rotation, reporting, log redaction, relay SSRF/network policy, NIP-42 identity disclosure to authenticated relays, relay metadata limitations, replay/spam/resource controls, residual at-least-once crash semantics, model-provider exposure, why stale pairing approvals are ignored, and why a human identity's nsec must never be used as the bot key. Recommend least-privilege OpenClaw tools and sandboxing for every agent reachable through this channel.

## 16. Acceptance criteria

The first release is complete when all of the following are true:

- An npm-managed local OpenClaw checkout can discover the plugin after local `npm install`, and a clean standard OpenClaw installation can install the packed package through `npm-pack:`; both can configure, enable, disable, inspect, and remove it.
- All required manual configuration, secret, channel, single-owner ingress, reply-delivery, status, and lifecycle flows pass against OpenClaw `2026.6.1` (`2e08f0f`), and the package advertises that version as its minimum host/plugin API.
- A pre-existing owner of channel `nostr` produces a clear conflict; migration to plugin `armada-dm` preserves the operator's `channels.nostr` and `secrets.providers.nostr` configuration only after the previous owner is disabled or removed.
- The plugin exposes only direct text chat capability.
- A valid Armada NIP-17 kind-14 DM reaches the intended OpenClaw agent once under cross-relay replay, rewrapping, reconnect, and concurrent-delivery tests; residual process-crash semantics are documented accurately rather than described as absolute exactly-once execution.
- Sender authorization and session identity derive only from the verified inner sender.
- The bot private key is resolved only from an OpenClaw `singleValue` file SecretRef containing one `nsec`; configuration, CLI arguments, environment variables, logs, status, and errors never contain it.
- The agent's response is a fresh NIP-59 gift wrap that the current Armada client decrypts and displays.
- During an admitted owner turn, Armada receives current encrypted ephemeral typing wraps; completion, failure, and cancellation stop refreshes without affecting the durable reply.
- The bot cannot initiate a DM independently of an authenticated, admitted owner turn.
- Recipient kind-10050 discovery, SSRF/DNS-rebinding defenses, authoritative valid-list routing, and automatic configured-relay owner fallback are covered by tests.
- A sender self-copy is emitted without causing a recursive agent turn.
- Relay reconnect, NIP-42, offline recovery lookback, duplicate delivery, shutdown, and partial relay failure are covered.
- No public/group/community/Lightning/command-registry code or dependency exists.
- Tests, lint, TypeScript build, package dry-run, and audit pass in CI.
- Logs and errors contain no secrets, decrypted content, ciphertext, full events, AUTH challenges, or sender-recipient relationship.
- README and security documentation accurately describe the transport and trust boundaries.

## 17. Deferred follow-ups

These require separate product decisions and must not silently expand v1:

- NIP-15 file messages and encrypted media upload;
- NIP-17 reactions and wrapped deletion requests;
- Armada disappearing-message extensions;
- profile/name directory lookup;
- NIP-46 remote signers or external HSM-backed identities;
- multi-account OpenClaw configuration;
- NIP-77 inbox synchronization and recipient deletion of stored wraps;
- push notifications;
- delivery receipts beyond relay acceptance;
- group or community support of any kind.

## 18. Delivery milestones

- **Foundation:** Slices 01–03 produce an installable plugin with a verified bot identity, tested cryptography, and a reachable advertised inbox, but no model dispatch.
- **Usable owner-chat MVP:** Slice 04 is the first deployable product milestone. An allowlisted Armada user can send one encrypted DM and receive one encrypted OpenClaw AI response using kind-10050 routing.
- **Feature-complete v1:** Slices 05–06 lock access to one owner, add automatic owner relay fallback, and publish sender recovery copies for human-initiated replies.
- **Release candidate:** Slices 07–08 prove failure behavior, resource bounds, manual configuration, exact-host packaging, and interoperability with the current Armada client.
- **Armada typing interoperability:** Slice 09 adds best-effort encrypted typing UX without widening the human-initiated conversation boundary.

Prefer one pull request per slice. A pull request must link its slice file, satisfy that file's exit gate, and leave the full suite green. Do not combine Slice 04 with later policy or recovery-copy work: keeping the first end-to-end path narrow makes sender identity, relay routing, and OpenClaw dispatch independently reviewable.
