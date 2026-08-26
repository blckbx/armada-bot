import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MediaIngressError,
  materializeInboundMedia,
  parseInboundMedia,
} from "../media-ingress.js";
import {
  BOT_PUBLIC_KEY,
  FIXTURE_NOW,
  SENDER_PUBLIC_KEY,
} from "./nip17-fixtures.js";

const URL = "https://blossom.example/media/photo.bin";
const KEY = Buffer.alloc(32, 0x11);
const NONCE = Buffer.alloc(16, 0x22);
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function encrypt(plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", KEY, NONCE);
  return Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

function rumor(kind: 14 | 15, content: string, tags: string[][]) {
  return {
    kind,
    content,
    tags,
    created_at: FIXTURE_NOW,
    pubkey: SENDER_PUBLIC_KEY,
    id: "44".repeat(32),
  };
}

function topLevelTags(ciphertext: Buffer, plaintext: Buffer): string[][] {
  return [
    ["p", BOT_PUBLIC_KEY],
    ["file-type", "image/png"],
    ["encryption-algorithm", "aes-gcm"],
    ["decryption-key", KEY.toString("hex")],
    ["decryption-nonce", NONCE.toString("hex")],
    ["x", sha256(ciphertext)],
    ["ox", sha256(plaintext)],
    ["size", String(ciphertext.length)],
    ["name", "photo.png"],
  ];
}

function imetaTag(ciphertext: Buffer, plaintext: Buffer, url = URL): string[] {
  return [
    "imeta",
    `url ${url}`,
    "m image/png",
    `encryption-algorithm aes-gcm`,
    `decryption-key ${KEY.toString("hex")}`,
    `decryption-nonce ${NONCE.toString("hex")}`,
    `x ${sha256(ciphertext)}`,
    `ox ${sha256(plaintext)}`,
    `size ${String(ciphertext.length)}`,
    "name photo.png",
  ];
}

describe("Armada encrypted inbound media", () => {
  it("normalizes kind-15 and Armada kind-14 imeta metadata", () => {
    const plaintext = Buffer.from("image bytes");
    const ciphertext = encrypt(plaintext);

    const file = parseInboundMedia(
      rumor(15, URL, topLevelTags(ciphertext, plaintext)),
    );
    const chat = parseInboundMedia(
      rumor(14, `please inspect\n${URL}`, [
        ["p", BOT_PUBLIC_KEY],
        imetaTag(ciphertext, plaintext),
      ]),
    );

    expect(file.attachments).toEqual(chat.attachments);
    expect(file.attachments).toHaveLength(1);
    expect(chat.caption).toBe("please inspect");
    expect(chat.unavailableAttachments).toBe(0);
  });

  it("accepts Armada voice-note metadata with plaintext integrity but no x tag", async () => {
    const plaintext = Buffer.from("opus voice bytes");
    const ciphertext = encrypt(plaintext);
    const voiceTag = imetaTag(ciphertext, plaintext).filter(
      (part) => !part.startsWith("x ") && !part.startsWith("size "),
    );
    voiceTag[voiceTag.findIndex((part) => part.startsWith("m "))] =
      "m audio/webm;codecs=opus";
    const parsed = parseInboundMedia(
      rumor(14, URL, [["p", BOT_PUBLIC_KEY], voiceTag]),
    );
    const saveMedia = vi.fn(() =>
      Promise.resolve({
        id: "voice.webm",
        path: "/managed/inbound/voice.webm",
        size: plaintext.length,
        contentType: "audio/webm",
      }),
    );

    const result = await materializeInboundMedia({
      parsed,
      loadRemote: () =>
        Promise.resolve({ buffer: ciphertext, kind: undefined }),
      saveMedia,
    });

    expect(parsed.attachments).toHaveLength(1);
    expect(saveMedia).toHaveBeenCalledWith(
      plaintext,
      "audio/webm",
      "inbound",
      MAX_MEDIA_BYTES,
      "photo.png",
      "photo.png",
    );
    expect(result.media).toEqual([
      { path: "/managed/inbound/voice.webm", contentType: "audio/webm" },
    ]);
  });

  it.each([
    ["unsupported algorithm", "encryption-algorithm xchacha20"],
    ["short key", "decryption-key 11"],
    ["short nonce", "decryption-nonce 22"],
    ["missing encrypted hash", "x "],
    ["oversized declaration", `size ${String(MAX_MEDIA_BYTES + 17)}`],
    ["insecure URL", "url http://blossom.example/media/photo.bin"],
    ["credentialed URL", "url https://user:pass@blossom.example/photo.bin"],
  ])("rejects %s metadata before download", (_label, replacement) => {
    const plaintext = Buffer.from("image bytes");
    const ciphertext = encrypt(plaintext);
    const tag = imetaTag(ciphertext, plaintext);
    const separator = replacement.indexOf(" ");
    const field = separator < 0 ? replacement : replacement.slice(0, separator);
    const index = tag.findIndex((part) => part.startsWith(`${field} `));
    if (index < 0) throw new Error("missing test field");
    tag[index] = replacement;

    const parsed = parseInboundMedia(
      rumor(14, URL, [["p", BOT_PUBLIC_KEY], tag]),
    );

    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.unavailableAttachments).toBe(1);
  });

  it("rejects excess attachments before download", () => {
    const plaintext = Buffer.from("image bytes");
    const ciphertext = encrypt(plaintext);
    const tags = [["p", BOT_PUBLIC_KEY]];
    for (let index = 0; index < 5; index += 1) {
      tags.push(
        imetaTag(
          ciphertext,
          plaintext,
          `https://blossom.example/media/${String(index)}.bin`,
        ),
      );
    }

    expect(() => parseInboundMedia(rumor(14, "files", tags))).toThrow(
      MediaIngressError,
    );
    try {
      parseInboundMedia(rumor(14, "files", tags));
    } catch (error) {
      expect(String(error)).toBe(
        "MediaIngressError: Inbound media is invalid.",
      );
    }
  });

  it("downloads, verifies, decrypts, and saves managed media", async () => {
    const plaintext = Buffer.from("real image bytes");
    const ciphertext = encrypt(plaintext);
    const loadRemote = vi.fn(
      (
        url: string,
        options: {
          maxBytes: number;
          readIdleTimeoutMs: number;
          requestInit: RequestInit;
        },
      ) => {
        void url;
        void options;
        return Promise.resolve({
          buffer: ciphertext,
          contentType: "application/octet-stream",
          kind: undefined,
          fileName: "ciphertext.bin",
        });
      },
    );
    const saveMedia = vi.fn(() =>
      Promise.resolve({
        id: "photo.png",
        path: "/managed/inbound/photo.png",
        size: plaintext.length,
        contentType: "image/png",
      }),
    );
    const parsed = parseInboundMedia(
      rumor(14, `please inspect\n${URL}`, [
        ["p", BOT_PUBLIC_KEY],
        imetaTag(ciphertext, plaintext),
      ]),
    );

    const result = await materializeInboundMedia({
      parsed,
      loadRemote,
      saveMedia,
    });

    expect(loadRemote.mock.calls[0]?.[0]).toBe(URL);
    const loadOptions = loadRemote.mock.calls[0]?.[1];
    expect(loadOptions?.maxBytes).toBe(MAX_MEDIA_BYTES + 16);
    expect(loadOptions?.readIdleTimeoutMs).toBe(20_000);
    expect(loadOptions?.requestInit.signal).toBeInstanceOf(AbortSignal);
    expect(saveMedia).toHaveBeenCalledWith(
      plaintext,
      "image/png",
      "inbound",
      MAX_MEDIA_BYTES,
      "photo.png",
      "photo.png",
    );
    expect(result.media).toEqual([
      { path: "/managed/inbound/photo.png", contentType: "image/png" },
    ]);
    expect(result.body).toContain("please inspect");
    expect(result.body).toContain("[Attachment: image/png]");
    expect(result.body).not.toContain(URL);
    expect(result.unavailableAttachments).toBe(0);
  });

  it("fails a changed ciphertext hash without saving plaintext", async () => {
    const plaintext = Buffer.from("real image bytes");
    const ciphertext = encrypt(plaintext);
    const changed = Buffer.from(ciphertext);
    changed[0] = (changed[0] ?? 0) ^ 1;
    const saveMedia = vi.fn();
    const parsed = parseInboundMedia(
      rumor(15, URL, topLevelTags(ciphertext, plaintext)),
    );

    const result = await materializeInboundMedia({
      parsed,
      loadRemote: () => Promise.resolve({ buffer: changed, kind: undefined }),
      saveMedia,
    });

    expect(saveMedia).not.toHaveBeenCalled();
    expect(result.media).toHaveLength(0);
    expect(result.body).toBe("[Attachment unavailable]");
    expect(result.unavailableAttachments).toBe(1);
  });

  it("fails closed on GCM authentication, plaintext hash, and declared-size mismatches", async () => {
    const plaintext = Buffer.from("real image bytes");
    const ciphertext = encrypt(plaintext);
    const badTag = Buffer.from(ciphertext);
    badTag[badTag.length - 1] = (badTag[badTag.length - 1] ?? 0) ^ 1;
    const cases = [
      {
        loaded: badTag,
        tags: topLevelTags(badTag, plaintext),
      },
      {
        loaded: ciphertext,
        tags: topLevelTags(ciphertext, Buffer.from("different plaintext")),
      },
      {
        loaded: ciphertext,
        tags: topLevelTags(ciphertext, plaintext).map((tag) =>
          tag[0] === "size" ? ["size", String(ciphertext.length + 1)] : tag,
        ),
      },
    ];

    for (const testCase of cases) {
      const saveMedia = vi.fn();
      const parsed = parseInboundMedia(rumor(15, URL, testCase.tags));
      const result = await materializeInboundMedia({
        parsed,
        loadRemote: () =>
          Promise.resolve({ buffer: testCase.loaded, kind: undefined }),
        saveMedia,
      });

      expect(saveMedia).not.toHaveBeenCalled();
      expect(result.body).toBe("[Attachment unavailable]");
    }
  });

  it("keeps valid siblings when another attachment fails", async () => {
    const plaintext = Buffer.from("real image bytes");
    const ciphertext = encrypt(plaintext);
    const firstUrl = "https://blossom.example/media/first.bin";
    const secondUrl = "https://blossom.example/media/second.bin";
    const invalid = imetaTag(ciphertext, plaintext, secondUrl).map((part) =>
      part.startsWith("x ") ? `x ${"00".repeat(32)}` : part,
    );
    const parsed = parseInboundMedia(
      rumor(14, `inspect both\n${firstUrl}\n${secondUrl}`, [
        ["p", BOT_PUBLIC_KEY],
        imetaTag(ciphertext, plaintext, firstUrl),
        invalid,
      ]),
    );

    const result = await materializeInboundMedia({
      parsed,
      loadRemote: () =>
        Promise.resolve({ buffer: ciphertext, kind: undefined }),
      saveMedia: () =>
        Promise.resolve({
          id: "first.png",
          path: "/managed/inbound/first.png",
          size: plaintext.length,
          contentType: "image/png",
        }),
    });

    expect(result.media).toHaveLength(1);
    expect(result.unavailableAttachments).toBe(1);
    expect(result.body).toBe(
      "inspect both\n[Attachment: image/png]\n[Attachment unavailable]",
    );
    expect(result.body).not.toContain("https://");
  });

  it("enforces the aggregate decrypted-byte limit", async () => {
    const plaintext = Buffer.alloc(14 * 1024 * 1024, 0x41);
    const ciphertext = encrypt(plaintext);
    const tags: string[][] = [["p", BOT_PUBLIC_KEY]];
    for (let index = 0; index < 3; index += 1) {
      tags.push(
        imetaTag(
          ciphertext,
          plaintext,
          `https://blossom.example/media/${String(index)}.bin`,
        ),
      );
    }
    const saveMedia = vi.fn(() =>
      Promise.resolve({
        id: "large.png",
        path: "/managed/inbound/large.png",
        size: plaintext.length,
        contentType: "image/png",
      }),
    );

    const result = await materializeInboundMedia({
      parsed: parseInboundMedia(rumor(14, "three files", tags)),
      loadRemote: () =>
        Promise.resolve({ buffer: ciphertext, kind: undefined }),
      saveMedia,
    });

    expect(saveMedia).toHaveBeenCalledTimes(2);
    expect(result.media).toHaveLength(2);
    expect(result.unavailableAttachments).toBe(1);
  });

  it("does not start a download after cancellation", async () => {
    const plaintext = Buffer.from("real image bytes");
    const ciphertext = encrypt(plaintext);
    const abort = new AbortController();
    abort.abort();
    const loadRemote = vi.fn();
    const parsed = parseInboundMedia(
      rumor(15, URL, topLevelTags(ciphertext, plaintext)),
    );

    await materializeInboundMedia({
      parsed,
      signal: abort.signal,
      loadRemote,
      saveMedia: vi.fn(),
    });

    expect(loadRemote).not.toHaveBeenCalled();
  });
});
