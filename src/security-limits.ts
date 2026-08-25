export interface SecurityLimits {
  readonly outerEventBytes: number;
  readonly ciphertextBytes: number;
  readonly tags: number;
  readonly tagElements: number;
  readonly tagElementBytes: number;
  readonly outgoingTextCharacters: number;
  readonly nip44PlaintextBytes: number;
  readonly nip59TimestampWindowSeconds: number;
  readonly relayUrlBytes: number;
  readonly configuredRelays: number;
  readonly recipientDeliveryRelays: number;
  readonly rawIngressEnvelopeBytes: number;
  readonly pendingInboundEvents: number;
  readonly concurrentInboundHandlers: number;
  readonly authenticatedSenderRatePerMinute: number;
  readonly authenticatedSenderBurst: number;
  readonly authenticatedGlobalRatePerMinute: number;
  readonly authenticatedGlobalBurst: number;
  readonly rateLimitIdentities: number;
  readonly authChallengeBytes: number;
  readonly queryResultEvents: number;
  readonly connectTimeoutMs: number;
  readonly websocketHandshakeTimeoutMs: number;
  readonly authTimeoutMs: number;
  readonly publishAckTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly overallSendTimeoutMs: number;
  readonly initialReconnectDelayMs: number;
  readonly maximumReconnectDelayMs: number;
  readonly stableConnectionMs: number;
}

export const SECURITY_LIMITS: Readonly<SecurityLimits> = Object.freeze({
  outerEventBytes: 131_072,
  ciphertextBytes: 100_000,
  tags: 32,
  tagElements: 8,
  tagElementBytes: 1_024,
  outgoingTextCharacters: 16_000,
  nip44PlaintextBytes: 65_535,
  nip59TimestampWindowSeconds: 2 * 24 * 60 * 60,
  relayUrlBytes: 2_048,
  configuredRelays: 8,
  recipientDeliveryRelays: 3,
  rawIngressEnvelopeBytes: 140_000,
  pendingInboundEvents: 256,
  concurrentInboundHandlers: 8,
  authenticatedSenderRatePerMinute: 10,
  authenticatedSenderBurst: 5,
  authenticatedGlobalRatePerMinute: 60,
  authenticatedGlobalBurst: 20,
  rateLimitIdentities: 1_024,
  authChallengeBytes: 4_096,
  queryResultEvents: 64,
  connectTimeoutMs: 5_000,
  websocketHandshakeTimeoutMs: 10_000,
  authTimeoutMs: 5_000,
  publishAckTimeoutMs: 10_000,
  queryTimeoutMs: 10_000,
  overallSendTimeoutMs: 20_000,
  initialReconnectDelayMs: 1_000,
  maximumReconnectDelayMs: 30_000,
  stableConnectionMs: 30_000,
});
