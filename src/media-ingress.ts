import { createDecipheriv, createHash } from "node:crypto";
import {
  saveMediaBuffer,
  type SavedMedia,
} from "openclaw/plugin-sdk/media-store";
import {
  loadWebMediaRaw,
  type WebMediaResult,
} from "openclaw/plugin-sdk/web-media";
import type { DirectMessageRumor } from "./nip17.js";
import { SECURITY_LIMITS } from "./security-limits.js";

const MIME_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const AES_GCM_TAG_BYTES = 16;
const MEDIA_SUBDIRECTORY = "inbound";

type LoadRemoteMedia = (
  url: string,
  options: {
    maxBytes: number;
    readIdleTimeoutMs: number;
    requestInit: RequestInit;
  },
) => Promise<WebMediaResult>;

type SaveManagedMedia = (
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
  detectionFilePathHint?: string,
) => Promise<SavedMedia>;

export class MediaIngressError extends Error {
  constructor() {
    super("Inbound media is invalid.");
    this.name = "MediaIngressError";
  }
}

export interface EncryptedInboundAttachment {
  readonly url: string;
  readonly contentType: string;
  readonly keyHex: string;
  readonly nonceHex: string;
  readonly encryptedSha256: string | undefined;
  readonly plaintextSha256: string | undefined;
  readonly declaredCiphertextBytes: number | undefined;
  readonly filename: string | undefined;
}

export interface ParsedInboundMedia {
  readonly caption: string;
  readonly attachments: EncryptedInboundAttachment[];
  readonly unavailableAttachments: number;
}

export interface MaterializedInboundMedia {
  readonly body: string;
  readonly media: { path: string; contentType?: string }[];
  readonly unavailableAttachments: number;
}

export function parseInboundMedia(
  rumor: DirectMessageRumor,
): ParsedInboundMedia {
  try {
    return parseInboundMediaStrict(rumor);
  } catch {
    throw new MediaIngressError();
  }
}

export async function materializeInboundMedia(input: {
  readonly parsed: ParsedInboundMedia;
  readonly signal?: AbortSignal;
  readonly loadRemote?: LoadRemoteMedia;
  readonly saveMedia?: SaveManagedMedia;
}): Promise<MaterializedInboundMedia> {
  const loadRemote = input.loadRemote ?? loadWebMediaRaw;
  const saveMedia = input.saveMedia ?? saveMediaBuffer;
  const media: { path: string; contentType?: string }[] = [];
  let unavailable = input.parsed.unavailableAttachments;
  let totalPlaintextBytes = 0;

  for (const attachment of input.parsed.attachments) {
    if (input.signal?.aborted) break;
    try {
      const timeoutSignal = AbortSignal.timeout(
        SECURITY_LIMITS.inboundMediaFetchTimeoutMs,
      );
      const signal = input.signal
        ? AbortSignal.any([input.signal, timeoutSignal])
        : timeoutSignal;
      const loaded = await loadRemote(attachment.url, {
        maxBytes:
          SECURITY_LIMITS.inboundMediaPlaintextBytes + AES_GCM_TAG_BYTES,
        readIdleTimeoutMs: SECURITY_LIMITS.inboundMediaFetchTimeoutMs,
        requestInit: { signal },
      });
      if (input.signal?.aborted) break;
      const ciphertext = Buffer.from(loaded.buffer);
      if (
        ciphertext.length < AES_GCM_TAG_BYTES ||
        ciphertext.length >
          SECURITY_LIMITS.inboundMediaPlaintextBytes + AES_GCM_TAG_BYTES ||
        (attachment.declaredCiphertextBytes !== undefined &&
          attachment.declaredCiphertextBytes !== ciphertext.length) ||
        (attachment.encryptedSha256 !== undefined &&
          sha256(ciphertext) !== attachment.encryptedSha256)
      ) {
        unavailable += 1;
        continue;
      }

      const plaintext = decryptAttachment(ciphertext, attachment);
      if (
        plaintext.length > SECURITY_LIMITS.inboundMediaPlaintextBytes ||
        (attachment.plaintextSha256 !== undefined &&
          sha256(plaintext) !== attachment.plaintextSha256) ||
        totalPlaintextBytes + plaintext.length >
          SECURITY_LIMITS.inboundMediaTotalBytes
      ) {
        unavailable += 1;
        continue;
      }
      totalPlaintextBytes += plaintext.length;

      const saved = await saveMedia(
        plaintext,
        attachment.contentType,
        MEDIA_SUBDIRECTORY,
        SECURITY_LIMITS.inboundMediaPlaintextBytes,
        attachment.filename,
        attachment.filename,
      );
      const contentType = saved.contentType ?? attachment.contentType;
      media.push({
        path: saved.path,
        contentType,
      });
    } catch {
      if (!input.signal?.aborted) unavailable += 1;
    }
  }

  return {
    body: buildAgentBody(input.parsed.caption, media, unavailable),
    media,
    unavailableAttachments: unavailable,
  };
}

function parseInboundMediaStrict(
  rumor: DirectMessageRumor,
): ParsedInboundMedia {
  const candidates: {
    fields: Record<string, string>;
    requireEncryptedHash: boolean;
  }[] = [];
  const candidateUrls: string[] = [];

  if (rumor.kind === 15) {
    const fields = flattenTopLevelTags(rumor.tags);
    fields["url"] = rumor.content;
    candidates.push({ fields, requireEncryptedHash: true });
    candidateUrls.push(rumor.content);
  } else {
    for (const tag of rumor.tags) {
      if (tag[0] !== "imeta") continue;
      for (const part of tag.slice(1)) {
        if (part.startsWith("url ")) candidateUrls.push(part.slice(4));
      }
      const fields = parseImetaFields(tag);
      if (fields === null) {
        candidates.push({ fields: {}, requireEncryptedHash: false });
        continue;
      }
      candidates.push({ fields, requireEncryptedHash: false });
    }
  }

  if (candidates.length > SECURITY_LIMITS.inboundMediaAttachments) {
    throw new Error("invalid");
  }

  const attachments: EncryptedInboundAttachment[] = [];
  let unavailableAttachments = 0;
  for (const candidate of candidates) {
    const parsed = parseAttachment(
      candidate.fields,
      candidate.requireEncryptedHash,
    );
    if (parsed === null) unavailableAttachments += 1;
    else attachments.push(parsed);
  }

  return {
    caption:
      rumor.kind === 15
        ? ""
        : stripAttachmentUrls(rumor.content, candidateUrls),
    attachments,
    unavailableAttachments,
  };
}

function flattenTopLevelTags(tags: string[][]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const tag of tags) {
    const name = tag[0];
    const value = tag[1];
    if (
      name === undefined ||
      value === undefined ||
      name === "p" ||
      name === "e"
    )
      continue;
    if (tag.length !== 2 || Object.hasOwn(fields, name)) return {};
    fields[name] = value;
  }
  return fields;
}

function parseImetaFields(tag: string[]): Record<string, string> | null {
  const fields: Record<string, string> = {};
  for (const part of tag.slice(1)) {
    const separator = part.indexOf(" ");
    if (separator <= 0) return null;
    const name = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (value === "" || Object.hasOwn(fields, name)) return null;
    fields[name] = value;
  }
  return fields;
}

function parseAttachment(
  fields: Record<string, string>,
  requireEncryptedHash: boolean,
): EncryptedInboundAttachment | null {
  const url = validateMediaUrl(fields["url"]);
  const contentType = normalizeMime(fields["file-type"] ?? fields["m"]);
  const algorithm = fields["encryption-algorithm"]?.toLowerCase();
  const keyHex = normalizeHex(fields["decryption-key"], 64);
  const nonceHex = normalizeNonce(fields["decryption-nonce"]);
  const encryptedSha256 = normalizeOptionalHex(fields["x"], 64);
  const plaintextSha256 = normalizeOptionalHex(fields["ox"], 64);
  const declaredCiphertextBytes = parseOptionalSize(fields["size"]);
  if (
    url === null ||
    contentType === null ||
    algorithm !== "aes-gcm" ||
    keyHex === null ||
    nonceHex === null ||
    encryptedSha256 === null ||
    (requireEncryptedHash && encryptedSha256 === undefined) ||
    (encryptedSha256 === undefined && plaintextSha256 === undefined) ||
    plaintextSha256 === null ||
    declaredCiphertextBytes === null
  ) {
    return null;
  }
  return {
    url,
    contentType,
    keyHex,
    nonceHex,
    encryptedSha256,
    plaintextSha256,
    declaredCiphertextBytes,
    filename: normalizeFilename(fields["name"], url),
  };
}

function validateMediaUrl(value: string | undefined): string | null {
  if (value === undefined || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeMime(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return MIME_TYPE.test(normalized) ? normalized : null;
}

function normalizeHex(
  value: string | undefined,
  length: number,
): string | null {
  if (value === undefined) return null;
  const normalized = value.toLowerCase();
  return normalized.length === length && /^[0-9a-f]+$/u.test(normalized)
    ? normalized
    : null;
}

function normalizeOptionalHex(
  value: string | undefined,
  length: number,
): string | undefined | null {
  if (value === undefined) return undefined;
  return normalizeHex(value, length);
}

function normalizeNonce(value: string | undefined): string | null {
  if (value === undefined || (value.length !== 24 && value.length !== 32))
    return null;
  return normalizeHex(value, value.length);
}

function parseOptionalSize(
  value: string | undefined,
): number | undefined | null {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) &&
    size >= AES_GCM_TAG_BYTES &&
    size <= SECURITY_LIMITS.inboundMediaPlaintextBytes + AES_GCM_TAG_BYTES
    ? size
    : null;
}

function normalizeFilename(
  value: string | undefined,
  url: string,
): string | undefined {
  const fromUrl = new URL(url).pathname.split("/").pop();
  const candidate = (value ?? fromUrl ?? "").split(/[\\/]/u).pop()?.trim();
  if (candidate === undefined || candidate === "") return undefined;
  let clean = "";
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code > 31 && code !== 127) clean += candidate[index] ?? "";
  }
  clean = clean.slice(0, 255);
  return clean === "" ? undefined : clean;
}

function stripAttachmentUrls(content: string, urls: string[]): string {
  let caption = content;
  for (const url of urls) caption = caption.split(url).join("");
  return caption
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

function decryptAttachment(
  ciphertext: Buffer,
  attachment: EncryptedInboundAttachment,
): Buffer {
  const body = ciphertext.subarray(0, -AES_GCM_TAG_BYTES);
  const authTag = ciphertext.subarray(-AES_GCM_TAG_BYTES);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(attachment.keyHex, "hex"),
    Buffer.from(attachment.nonceHex, "hex"),
  );
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildAgentBody(
  caption: string,
  media: { contentType?: string }[],
  unavailable: number,
): string {
  const lines = caption === "" ? [] : [caption];
  for (const item of media) {
    lines.push(
      `[Attachment: ${item.contentType ?? "application/octet-stream"}]`,
    );
  }
  for (let index = 0; index < unavailable; index += 1) {
    lines.push("[Attachment unavailable]");
  }
  return lines.join("\n") || "[Attachment unavailable]";
}
