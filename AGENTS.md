# Repository guidance

- Follow the ordered slices in `docs/IMPLEMENTATION_PLAN.md` and implement only the active slice.
- Use red-green-refactor: observe a focused test fail before implementing behavior, then run focused and full suites.
- Keep TypeScript strict and use public exports from exactly `openclaw@2026.6.34`.
- Do not read Nostr secret files in plugin code. OpenClaw resolves the configured file SecretRef.
- Never log or expose private keys, resolved secret values, plaintext, ciphertext, AUTH challenges, or sender-recipient relationships.
- Keep transport, cryptography, and OpenClaw adapter boundaries separate.
- Do not add groups, public notes, NIP-04, Lightning, command registries, or model-provider behavior.
- Builds, tests, lint, package validation, and the dependency audit must pass before a slice is complete.
- Do not edit generated `dist/` files by hand and do not commit secrets or fixtures containing live keys.
