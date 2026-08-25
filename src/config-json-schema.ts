import type { JsonSchemaObject } from "openclaw/plugin-sdk/json-schema-runtime";

export const ARMADA_CHANNEL_JSON_SCHEMA: JsonSchemaObject = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["privateKey", "allowFrom"],
  properties: {
    enabled: { type: "boolean", default: true },
    name: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      default: "OpenClaw",
    },
    privateKey: {
      type: "object",
      additionalProperties: false,
      required: ["source", "provider", "id"],
      properties: {
        source: { const: "file" },
        provider: { const: "nostr" },
        id: { const: "value" },
      },
    },
    relays: {
      $ref: "#/definitions/relayList",
      default: [
        "wss://relay.armada.buzz/",
        "wss://relay.ditto.pub/",
        "wss://relay.dreamith.to/",
      ],
    },
    discoveryRelays: {
      $ref: "#/definitions/relayList",
      default: ["wss://relay.ditto.pub/", "wss://relay.dreamith.to/"],
    },
    publishInbox: { type: "boolean", default: true },
    allowFallbackDelivery: { type: "boolean", default: true },
    allowPrivateRelays: { type: "boolean", default: false },
    dmPolicy: {
      type: "string",
      const: "allowlist",
      default: "allowlist",
    },
    allowFrom: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: {
        type: "string",
        anyOf: [
          { pattern: "^(nostr:)?[0-9A-Fa-f]{64}$" },
          { pattern: "^npub1[023456789acdefghjklmnpqrstuvwxyz]+$" },
        ],
      },
    },
    recoveryLookbackSeconds: {
      type: "integer",
      minimum: 3600,
      maximum: 2_592_000,
      default: 604_800,
    },
    maxFutureSkewSeconds: {
      type: "integer",
      minimum: 0,
      maximum: 3600,
      default: 300,
    },
    maxMessageAgeSeconds: {
      type: "integer",
      minimum: 3600,
      maximum: 2_592_000,
      default: 604_800,
    },
    markdown: {
      type: "object",
      additionalProperties: false,
      default: { tables: "bullets" },
      properties: {
        tables: {
          type: "string",
          enum: ["off", "bullets", "code", "block"],
          default: "bullets",
        },
      },
    },
  },
  definitions: {
    relayList: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: {
        type: "string",
        minLength: 1,
        maxLength: 2048,
        pattern: "^wss?://",
      },
    },
  },
};
