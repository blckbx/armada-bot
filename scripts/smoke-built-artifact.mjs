import { getPublicKey } from "nostr-tools/pure";
import { createDirectMessage, unwrapDirectMessage } from "../dist/index.js";

const NOW = 1_750_000_000;
const botSecretKey = scalar(1);
const ownerSecretKey = scalar(2);
const botPublicKey = getPublicKey(botSecretKey);
const ownerPublicKey = getPublicKey(ownerSecretKey);

const request = createDirectMessage({
  senderSecretKey: ownerSecretKey,
  recipientPublicKey: botPublicKey,
  content: "built artifact request",
  now: NOW,
});
const admitted = unwrapDirectMessage({
  wrap: request.recipient.wrap,
  recipientSecretKey: botSecretKey,
  recipientPublicKey: botPublicKey,
  now: NOW,
});

assert(admitted.senderPublicKey === ownerPublicKey);
assert(admitted.content === "built artifact request");

const response = createDirectMessage({
  senderSecretKey: botSecretKey,
  recipientPublicKey: ownerPublicKey,
  content: "built artifact response",
  replyToEventId: admitted.rumorId,
  now: NOW,
});
const received = unwrapDirectMessage({
  wrap: response.recipient.wrap,
  recipientSecretKey: ownerSecretKey,
  recipientPublicKey: ownerPublicKey,
  now: NOW,
});

assert(received.senderPublicKey === botPublicKey);
assert(received.content === "built artifact response");
assert(received.replyToEventId === admitted.rumorId);

console.log("Validated the emitted JavaScript NIP-17 request/reply artifact.");

function scalar(lastByte) {
  const value = new Uint8Array(32);
  value[31] = lastByte;
  return value;
}

function assert(condition) {
  if (!condition) throw new Error("Built artifact smoke test failed.");
}
