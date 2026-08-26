# Slice 10 — NIP-17 encrypted media ingress

## Agent brief

Accept encrypted media attached by the configured Armada owner, materialize it through bounded and SSRF-safe OpenClaw media services, and attach only managed local files to the existing human-initiated direct-message turn. Preserve the cryptographic, authorization, replay, rate-limit, and text-reply boundaries completed in Slices 01–09.

## Functional outcome

An owner can attach an image, audio recording, video, PDF, or other OpenClaw-supported file in Armada. The bot authenticates the enclosing NIP-17 rumor, safely downloads and decrypts the attachment, supplies it to OpenClaw's media-aware agent pipeline, and returns the normal encrypted text reply in the same conversation.

## Dependencies

- Slices 01–09 complete and green.
- OpenClaw public plugin SDK exactly `2026.6.1`.
- NIP-17 kind-15 file-message format.
- Armada client interoperability at `soapbox-pub/armada` commit `5b99f88d309052abc1eeb4f0b2ef437de086e709`.

## In scope

- Authenticate and admit one-to-one NIP-17 kind-15 file rumors.
- Recognize current Armada kind-14 attachments carried in encrypted-rumor `imeta` tags, including voice notes and multiple attachments.
- Require AES-256-GCM attachment encryption and validated HTTPS blob URLs.
- Require and verify the encrypted SHA-256 `x` hash for kind-15 files. For current Armada kind-14 media, verify `x` when present and require/verify `ox` when Armada voice-note metadata omits `x`; AES-GCM authentication remains mandatory in both cases.
- Accept 12-byte and Armada/0xChat-compatible 16-byte GCM nonces.
- Download only after authentication, owner authorization, replay claiming, and authenticated rate limiting.
- Use OpenClaw's public SSRF-guarded raw media loader and managed inbound media store.
- Bound attachment count, individual ciphertext/plaintext bytes, aggregate plaintext bytes, fetch duration, metadata, and filenames.
- Pass managed local paths and detected content types through OpenClaw's inbound media payload fields.
- Preserve a text caption when present and add sanitized attachment/unavailable placeholders without exposing URLs or encryption parameters to the model context.
- Keep the existing outbound response as a kind-14 text rumor with its sender recovery copy.

## Out of scope

- Bot-authored file uploads or outbound media replies.
- Plaintext remote attachments, unencrypted URL scraping, data URLs, local/file URLs, redirects to private networks, or operator private-relay exceptions for media.
- Executing, rendering, or extracting archives; OCR/transcription/model behavior remains owned by OpenClaw and its configured providers.
- Persistent plugin-owned media storage, a media cache, attachment forwarding, thumbnails, reactions, deletion, or disappearing-message behavior.
- Group/community media and legacy NIP-04 attachments.

## Security limits

- At most 4 encrypted attachments per admitted rumor.
- At most 20 MiB plaintext plus the 16-byte GCM tag in a downloaded ciphertext, and 20 MiB decrypted plaintext per attachment.
- At most 40 MiB aggregate decrypted plaintext per turn.
- At most 20 seconds for each remote load, in addition to OpenClaw's guarded streaming/idle limits.
- HTTPS only; no credentials or fragments; all DNS, redirect, and private-address enforcement remains fail-closed in OpenClaw's public media loader.
- No attachment URL, key, nonce, hash, remote response body, decrypted bytes, local managed path, or sender-recipient relationship in logs, errors, probes, or replies.

## Required automated tests

- A valid independently wrapped kind-15 rumor authenticates with its original tags and sender identity intact.
- Kind-15 and kind-14 `imeta` metadata parse into the same normalized encrypted attachment descriptor.
- Multiple Armada `imeta` attachments retain caption text while their URLs are removed from the agent body.
- Unsupported algorithms, malformed/duplicate metadata, kind-15 messages missing `x`, Armada attachments missing both `x` and `ox`, invalid key/nonce/hash/size/MIME/URL, excess attachments, and oversized declarations never trigger a fetch.
- The downloader receives only validated HTTPS URLs with a strict byte cap and abort signal.
- Ciphertext `x`, AES-GCM authentication, optional plaintext `ox`, declared size, individual byte limits, and aggregate byte limits fail closed.
- Successfully decrypted bytes are saved through OpenClaw's managed media store and emitted as aligned local path/content-type payload fields.
- Partial attachment failure is represented only by a sanitized unavailable placeholder; valid siblings can still reach the agent.
- Unauthorized, duplicate, self-copy, rate-limited, and cancelled turns perform no media download.
- A media-aware dispatch receives local paths, sends typing while work is active, and returns the normal decryptable text reply and recovery copy.

## Exit gate

- Current Armada image attachment and voice-note sends reach an OpenClaw test agent as media-aware inbound turns.
- A standard independently generated kind-15 AES-GCM file message reaches the same path.
- Text-only behavior, typing, reply routing, replay semantics, cancellation, and recovery copies remain green.
- Tests, lint, strict typecheck, formatting, build, package validation, SDK baseline, smoke tests, dry-run packaging, and production audit pass.
