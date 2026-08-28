# Security policy

Report suspected vulnerabilities privately to the repository maintainers. Do not include live secret keys, decrypted messages, ciphertext, or AUTH challenges in a report unless a secure exchange has been agreed.

Use a dedicated Nostr bot identity. Store its single `nsec` at `/path/to/.openclaw/secrets/nostr_nsec` in a mode-0700 directory and a mode-0600 file, configure OpenClaw's `nostr` single-value file provider, and reference it from `channels.nostr.privateKey`. The plugin never opens that file directly and must never expose the resolved key through configuration, logs, errors, or status.

Deploy only on OpenClaw `2026.7.2-beta.6` or newer. The plugin deliberately compiles and typechecks against the narrower `2026.6.34` public SDK surface for compatibility, but npm currently reports advisories in that exact development-only package tree, so it is not the approved smoke-test or runtime host.

`npm run audit` checks the complete dependency tree as well as production dependencies. It fails for any advisory outside the nested, development-only `openclaw@2026.6.34` SDK baseline, and it independently verifies that the deployable host tree is the patched version above. Findings attached to the exact SDK baseline are reported explicitly, never shipped in the plugin package, and never accepted in the runtime smoke host.

NIP-17 is transport end-to-end encryption. Plaintext exists on the OpenClaw host and is provided to the operator's configured model provider. Use least-privilege tools and sandboxing for every agent reachable through this channel.

Encrypted attachments are fetched only after NIP-17 authentication, owner authorization, replay claiming, and rate limiting. Remote blob locations must be HTTPS and are loaded through OpenClaw's SSRF-guarded media loader, which applies pinned address validation and guarded redirects. The plugin bounds attachment count, download size and duration, per-file plaintext, and aggregate plaintext; verifies AES-GCM authentication plus the available ciphertext/plaintext hashes; and stores decrypted bytes only in OpenClaw's managed inbound-media area. Attachment URLs, keys, nonces, hashes, bytes, filenames, and managed paths must not appear in plugin logs, errors, probes, or replies.

NIP-17 hides the attachment location and decryption material from relays, but the blob host can observe the bot host's address and fetch timing and can identify the encrypted object requested. After local decryption, the configured OpenClaw model/provider may receive the plaintext media for analysis. Media transport encryption therefore does not make the attachment secret from the bot host or its configured model provider.

Relay operators can observe timing, outer kind-1059 and ephemeral kind-21059 recipient tags, and connection metadata. The kind-21059 typing refresh additionally reveals that the bot is actively processing a turn for that recipient, although its kind-23311 rumor remains encrypted. A NIP-42 authenticated relay can associate the bot public key with that exact connection. AUTH uses a signed ephemeral kind-22242 event and is not published or stored as a direct message, but its bot pubkey is intentionally visible to the authenticating relay. Challenges, AUTH event bodies, typing payloads, and sender-recipient relationships must never be logged.

When an owner has no usable kind-10050 and configured-relay fallback is enabled, those configured relays receive encrypted reply and typing wraps and can observe their outer recipient key and timing. This improves delivery compatibility at the cost of exposing that metadata to more relays; disable fallback to require owner-authored relay discovery.

Relay destinations are validated before connection. Public destinations require `wss://`, reject credentials, fragments, malformed or overlong URLs, and reject any DNS answer in local, private, reserved, or documentation address classes. The approved DNS answer is pinned into the WebSocket connection and redirects are disabled. `allowPrivateRelays` is an explicit exception only for operator-configured relays; recipient-provided relay URLs can never use it.

Exactly one configured owner is authorized from the authenticated inner rumor author. OpenClaw pairing-store records are deliberately ignored and cannot broaden that owner; migration leaves them untouched on disk. The transport and cryptographic core apply bounded frames, callback queues, query results, relay fan-out, envelopes, ciphertext, tags, plaintext, AUTH challenges, acknowledgements, and deadlines. Per-sender and global token buckets apply only after authentication and authorization, and their identity table is bounded.

Allowlisted ingress claims the authenticated inner rumor ID in OpenClaw's persistent dedupe store before dispatch and stops intake if persistence fails. Different carrier events and independently rewrapped copies of the same inner rumor share this key. Normal delivery is duplicate-suppressed, but the process-crash window has residual at-least-once semantics: a crash after an irreversible external effect and before durable commit can permit a retry. The plugin does not claim absolute exactly-once execution.

Rotate the bot key as a new identity. Stop the gateway, atomically replace only the dedicated mode-0600 secret file, audit and reload OpenClaw secrets, restart, verify the new public identity and kind-10050 announcement, and deliberately migrate the Armada contact. Never reuse a human identity as the bot key, and never assume old replay state or conversation identity transfers to the new public key.

The plugin has no interactive setup wizard and never edits `openclaw.json` or the secret provider. Configured `publishInbox: true` authorizes startup to replace the bot-authored kind-10050 relay list. Disable that flag when another process owns the announcement.

Use least-privilege OpenClaw tools and sandboxing for the agent reachable through this channel. Direct messages can contain adversarial instructions even when they come from the sole authenticated owner.
