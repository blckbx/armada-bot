# Slice 01 — Installable plugin and safe bot identity

## Agent brief

Implement only this slice. Read `docs/IMPLEMENTATION_PLAN.md` first and preserve its naming, security boundaries, and OpenClaw `2026.6.1` (`2e08f0f`) compatibility requirements. Use red-green-refactor: add a focused failing test, observe the failure, implement the smallest change, then run the focused and full suites.

## Functional outcome

An operator can build the package, install it into a local npm-managed OpenClaw checkout, enable plugin `armada-dm`, resolve the already-provisioned file-backed bot `nsec`, and inspect the derived bot `npub`. Merely discovering or importing the plugin starts no sockets or background work.

This is an operator-facing slice. It does not yet exchange Nostr messages.

## Dependencies

- None. This is the first slice.
- Use `Ink-North/nostr-nip17-plugin` only as the structural template described in the main plan.
- Treat the OpenClaw `2026.6.1` source and public SDK as authoritative.

## In scope

- Scaffold the ESM TypeScript package and proposed repository layout.
- Create consistent package, plugin, setup, and channel metadata:
  - npm package `openclaw-armada-dm`;
  - plugin ID `armada-dm`;
  - channel ID `nostr`;
  - minimum host/plugin API `2026.6.1`.
- Add import-safe built runtime and setup entry points.
- Register the single-account text-DM channel using only public SDK exports present at the pinned OpenClaw commit.
- Add strict runtime and manifest schemas for `channels.nostr`.
- Resolve `channels.nostr.privateKey` only through the configured `nostr` single-value file SecretRef.
- Parse only a valid Bech32 `nsec`; reject raw hex, inline values, environment/exec inputs, embedded whitespace, zero, and out-of-range scalars.
- Derive and expose only the bot public key/`npub` in sanitized account status.
- Detect an existing owner of channel ID `nostr` and fail with an actionable conflict message without changing existing configuration.
- Add build, test, lint, format, audit, and package-content commands.

## Required tests

- Manifest and package metadata agree on all identifiers and built entry paths.
- `openclaw.plugin.json` uses the native `kind: "channel"` shape accepted by OpenClaw `2026.6.1` and rejects unknown plugin config.
- Every `openclaw/plugin-sdk/*` import resolves against exactly `openclaw@2026.6.1`.
- Importing package/setup entries and discovering a disabled channel starts no socket, timer, or crypto transport.
- Valid relay, policy, limit, and SecretRef configuration parses.
- Missing/mismatched providers, wrong SecretRef provider/ID, inline/env/exec secrets, invalid relay schemes, empty relay sets, unknown keys, invalid limits, and malformed allowlist entries fail with sanitized errors.
- OpenClaw strips the normal secret-file trailing newline before identity validation; other whitespace is rejected.
- Status and errors never contain the `nsec`, file contents, ciphertext, or plaintext.
- A second enabled owner of `nostr` fails clearly and is never silently selected or replaced.
- `npm pack --dry-run` contains built JavaScript, manifest, README, LICENSE, and SECURITY files only from the intended allowlist.

## Implementation notes

- The plugin must never open `/home/claw/.openclaw/secrets/nostr_nsec` directly. OpenClaw owns file access, permission checks, byte limits, newline removal, and SecretRef resolution.
- Do not add NIP-04, TunnelSats, groups, rooms, Lightning, commands, or model-provider code.
- Do not use `postinstall`, `prepare`, TypeScript-at-runtime, or installation-time network access.
- Stub transport lifecycle behind interfaces, but do not connect to relays in this slice.

## Deliverables

- Package/build/test configuration and lockfile.
- `openclaw.plugin.json`, `index.ts`, and `setup-entry.ts` with built counterparts.
- Strict configuration/account/identity modules and tests.
- Minimal README installation and secret-prerequisite section sufficient to exercise this slice.

## Exit gate

- Tests, lint, typecheck/build, package validation, `npm pack --dry-run`, and zero-vulnerability audit pass.
- A clean npm-managed OpenClaw `2026.6.1` checkout discovers the plugin after `npm install /absolute/path/to/openclaw-armada-dm`.
- A clean OpenClaw `2026.6.1` instance discovers the packed artifact through `openclaw plugins install npm-pack:/absolute/path/to/package.tgz`.
- With the documented pre-provisioned SecretRef, status shows the correct bot `npub` and never the secret.
- No relay connection or message processing exists yet.

## Handoff to Slice 02

Expose a small identity/crypto-facing interface that accepts only the resolved secret value in memory. Do not expose OpenClaw runtime objects to the cryptographic module.
