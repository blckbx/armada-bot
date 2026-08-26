# Security policy

Report suspected vulnerabilities privately to the repository maintainers. Do not include live secret keys, decrypted messages, ciphertext, or AUTH challenges in a report unless a secure exchange has been agreed.

Use a dedicated Nostr bot identity. Store its single `nsec` at `/path/to/.openclaw/secrets/nostr_nsec` in a mode-0700 directory and a mode-0600 file, configure OpenClaw's `nostr` single-value file provider, and reference it from `channels.nostr.privateKey`. The plugin never opens that file directly and must never expose the resolved key through configuration, logs, errors, or status.

NIP-17 is transport end-to-end encryption. Plaintext exists on the OpenClaw host and is provided to the operator's configured model provider. Use least-privilege tools and sandboxing for every agent reachable through this channel.

Relay operators can observe timing, the outer kind-1059 recipient tag, and connection metadata. A NIP-42 authenticated relay can associate the bot public key with that exact connection. AUTH uses a signed ephemeral kind-22242 event and is not published or stored as a direct message, but its bot pubkey is intentionally visible to the authenticating relay. Challenges, AUTH event bodies, and sender-recipient relationships must never be logged.

When an owner has no usable kind-10050 and configured-relay fallback is enabled, those configured relays receive the encrypted recipient wrap and can observe its outer recipient key and timing. This improves delivery compatibility at the cost of exposing that metadata to more relays; disable fallback to require owner-authored relay discovery.

Relay destinations are validated before connection. Public destinations require `wss://`, reject credentials, fragments, malformed or overlong URLs, and reject any DNS answer in local, private, reserved, or documentation address classes. The approved DNS answer is pinned into the WebSocket connection and redirects are disabled. `allowPrivateRelays` is an explicit exception only for operator-configured relays; recipient-provided relay URLs can never use it.

Exactly one configured owner is authorized from the authenticated inner rumor author. OpenClaw pairing-store records are deliberately ignored and cannot broaden that owner; migration leaves them untouched on disk. The transport and cryptographic core apply bounded frames, callback queues, query results, relay fan-out, envelopes, ciphertext, tags, plaintext, AUTH challenges, acknowledgements, and deadlines. Per-sender and global token buckets apply only after authentication and authorization, and their identity table is bounded.

Allowlisted ingress claims the authenticated inner rumor ID in OpenClaw's persistent dedupe store before dispatch and stops intake if persistence fails. Different carrier events and independently rewrapped copies of the same inner rumor share this key. Normal delivery is duplicate-suppressed, but the process-crash window has residual at-least-once semantics: a crash after an irreversible external effect and before durable commit can permit a retry. The plugin does not claim absolute exactly-once execution.

Rotate the bot key as a new identity. Stop the gateway, atomically replace only the dedicated mode-0600 secret file, audit and reload OpenClaw secrets, restart, verify the new public identity and kind-10050 announcement, and deliberately migrate the Armada contact. Never reuse a human identity as the bot key, and never assume old replay state or conversation identity transfers to the new public key.

The plugin has no interactive setup wizard and never edits `openclaw.json` or the secret provider. Configured `publishInbox: true` authorizes startup to replace the bot-authored kind-10050 relay list. Disable that flag when another process owns the announcement.

Use least-privilege OpenClaw tools and sandboxing for the agent reachable through this channel. Direct messages can contain adversarial instructions even when they come from the sole authenticated owner.
