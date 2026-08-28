# Slice 08 — Manual configuration, Armada interoperability, and release

## Agent brief

Finish operator documentation, diagnostics, interoperability evidence, and release validation after all functional and resilience slices are green. There is no interactive setup wizard. Operators configure the file SecretRef and `channels.nostr` directly through OpenClaw configuration. Keep only the minimal import-safe setup entry required by the OpenClaw `2026.6.34` package contract.

## Functional outcome

An operator who provisioned `/path/to/.openclaw/secrets/nostr_nsec`, installed the package on OpenClaw `2026.7.2-beta.6` or newer, and added the documented `secrets.providers.nostr` and `channels.nostr` configuration can restart the gateway, see a truthful sanitized probe, and hold a multi-turn encrypted conversation with the bot from the current Armada client. With `publishInbox: true`, gateway startup publishes and verifies the bot's kind-10050 inbox automatically. The package continues to use only the OpenClaw `2026.6.34` public SDK baseline.

## Dependencies

- Slices 01–07 complete and green.

## In scope

- Document the complete manual installation and `openclaw.json` configuration flow, including the file provider, SecretRef, exactly one `allowFrom` owner, relay roles, enable/reload/restart, and status commands.
- Treat configured `publishInbox: true` as explicit operator consent for startup to publish or replace the bot-authored kind-10050 relay list.
- Keep `setup-entry.ts` as a side-effect-free compatibility adapter only; it must not prompt, mutate configuration, read files, publish events, or start transport.
- Validate the pre-existing `nostr` file provider and matching `channels.nostr.privateKey` SecretRef at runtime through OpenClaw-owned SecretRef resolution; never create, overwrite, repair, or directly read the secret file.
- Preserve startup kind-10050 publication/verification and refuse ready status when the configured mandatory announcement is unavailable.
- Complete sanitized probes for configuration/identity state, relay connectivity, AUTH, subscriptions, inbox announcement verification, dedupe degradation, queue overload, and authenticated rate limiting.
- Complete README, SECURITY.md, migration, rotation, trust-boundary, unsupported-feature, and troubleshooting documentation.
- Add exact-host SDK-import checks, package-content validation, built-artifact smoke tests, installation guidance, CI quality gates, and vulnerability audit.
- Perform disposable-key staging with the current Armada web/desktop client; never use a human's long-lived identity as the bot key.

## Out of scope

- `openclaw channels add --channel nostr` prompts or a plugin-owned setup wizard.
- Creating or editing the secret file, provider, SecretRef, or channel configuration on the operator's behalf.
- Registry publication, release signing, or version promotion without a separate release decision.

## Required automated tests

- Runtime configuration accepts the documented provider/SecretRef/channel shape and rejects missing, mismatched, empty, oversized, invalid, or multi-value resolved secrets with category-only diagnostics.
- The minimal setup entry and runtime package entries import without sockets, timers, configuration mutation, secret access, or transport startup.
- `publishInbox: true` publishes and verifies the configured Armada/Ditto/Dreamith kind-10050 tags during gateway startup; failure remains visible and prevents ready status.
- Status distinguishes invalid configuration/identity, unreachable relays, AUTH state, subscription state, missing inbox announcement, dedupe degradation, queue drops, authenticated rate limiting, partial relay operation, and healthy operation without payloads or relationship metadata.
- CI runs the full tests, coverage, lint, typecheck, format check, build, manifest/package validation, package dry-run, package-content allowlist, exact `2026.6.34` SDK-import baseline, built-artifact smoke test, and complete-tree/zero-runtime-vulnerability audit.
- A built-artifact test imports emitted JavaScript and proves an Armada-compatible NIP-17 request/reply encryption round trip without importing TypeScript source modules.

## Manual Armada staging

1. Use disposable bot and user keys; never use a human's long-lived identity as the bot key.
2. Install the packed artifact into a clean OpenClaw `2026.7.2-beta.6` or newer instance.
3. Provision the bot `nsec` through the documented mode-0700 directory, mode-0600 file, `singleValue` provider, and SecretRef commands.
4. Add the documented `channels.nostr` configuration with the disposable Armada user as the sole `allowFrom` owner and `publishInbox: true`.
5. Restart the gateway and verify the probe reports the derived bot public identity, at least one live subscription, and a verified Armada/Ditto/Dreamith inbox announcement.
6. Verify the owner initiates a DM and receives an AI reply without a pairing challenge or unsolicited bot message.
7. Verify a valid owner kind-10050 is authoritative, then remove it and verify configured-relay fallback delivery.
8. Verify a multi-turn conversation and the bot's sender recovery copies.
9. Stop the gateway, send a message, restart inside the recovery window, and confirm one turn.
10. Deliver the same rumor through multiple relays and independent gift wraps and confirm one turn.
11. Break one relay and confirm continued operation through another with truthful per-relay status.
12. Inspect gateway logs and relay-side carrier JSON for secret/plaintext leakage and document expected metadata exposure.

## Security and documentation checklist

- Explain that NIP-17 protects the Armada-to-OpenClaw transport, while plaintext exists on the OpenClaw host and may be sent to its configured model provider.
- Explain kind-1059 outer recipient/timing metadata and NIP-42 bot-identity disclosure.
- Document authoritative kind-10050 routing and the relay-metadata cost of automatic configured-relay owner fallback.
- Document secret rotation as a new bot identity, including replay namespace and owner-contact migration.
- Document channel ownership migration from `nostr-nip17`, including that old pairing approvals remain untouched but are ignored.
- At this slice boundary, document unsupported media, reactions, groups, NIP-04, presence, disappearing messages, and unsolicited/scheduled sends. Slice 09 separately adds outbound Armada DM typing, and Slice 10 later adds encrypted inbound media while retaining text-only replies.
- Recommend least-privilege tools and sandboxing for the exposed OpenClaw agent.

## Deliverables

- Manual configuration and troubleshooting documentation.
- Completed sanitized status/probe implementation.
- Minimal import-safe setup compatibility entry with no wizard behavior.
- Exact-host CI, SDK baseline, package validation, and built-artifact smoke suites.
- A manual disposable-key Armada staging checklist and recorded operator confirmation when performed.

## Exit gate

- Both local `npm install --omit=dev /absolute/path/to/openclaw-armada-dm` and managed `npm-pack:` workflows are documented and validated against OpenClaw `2026.7.2-beta.6` or newer.
- Adding the documented configuration and restarting the gateway is sufficient to publish/verify the bot inbox and reach ready status; no setup command is required.
- The current Armada client sends a NIP-17 DM that reaches the intended OpenClaw agent once under normal duplicate delivery, then decrypts and renders the bot's response.
- Human-initiated multi-turn replies, sender recovery copies, sole-owner allowlist, restart recovery, partial relay failure, authoritative kind-10050 routing, and automatic owner fallback have automated or manual evidence.
- Tests, lint, typecheck, formatting, build, package checks, built-artifact smoke, and audit pass.
- Registry publication and `1.0.0` promotion remain separate explicitly authorized release actions.
