import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SECURITY_LIMITS } from "./security-limits.js";

const UTF8 = new TextEncoder();

export class RelayUrlPolicyError extends Error {
  constructor() {
    super("Relay destination is not allowed.");
    this.name = "RelayUrlPolicyError";
  }
}

export interface RelayDnsAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type RelayDnsLookup = (hostname: string) => Promise<RelayDnsAddress[]>;

export interface ValidatedRelayTarget {
  readonly url: string;
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
}

export interface ValidateRelayUrlInput {
  readonly url: string;
  readonly source: "configured" | "recipient";
  readonly allowPrivateRelays: boolean;
  readonly lookup?: RelayDnsLookup;
}

const defaultLookup: RelayDnsLookup = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.flatMap((answer) =>
    answer.family === 4 || answer.family === 6
      ? [{ address: answer.address, family: answer.family }]
      : [],
  );
};

export async function validateRelayUrl(
  input: ValidateRelayUrlInput,
): Promise<ValidatedRelayTarget> {
  try {
    if (
      typeof input.url !== "string" ||
      input.url.length === 0 ||
      UTF8.encode(input.url).byteLength > SECURITY_LIMITS.relayUrlBytes ||
      hasControlCharacter(input.url)
    ) {
      fail();
    }

    const parsed = new URL(input.url);
    const permitsInsecure =
      input.source === "configured" && input.allowPrivateRelays;
    if (
      (parsed.protocol !== "wss:" &&
        !(permitsInsecure && parsed.protocol === "ws:")) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== "" ||
      parsed.hostname === "" ||
      parsed.hostname.endsWith(".") ||
      !/^[a-z0-9.:[\]-]+$/u.test(parsed.hostname)
    ) {
      fail();
    }

    const hostname = stripIpv6Brackets(parsed.hostname);
    const literalFamily = isIP(hostname);
    const answers: RelayDnsAddress[] =
      literalFamily === 4 || literalFamily === 6
        ? [{ address: hostname, family: literalFamily }]
        : await (input.lookup ?? defaultLookup)(hostname);
    if (answers.length === 0) fail();
    for (const answer of answers) {
      if (
        isIP(answer.address) !== answer.family ||
        (!permitsInsecure && !isPublicAddress(answer.address))
      ) {
        fail();
      }
    }
    const selected = answers[0];
    if (selected === undefined) fail();
    return {
      url: parsed.toString(),
      hostname,
      address: selected.address,
      family: selected.family,
    };
  } catch {
    throw new RelayUrlPolicyError();
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 31 || point === 127) return true;
  }
  return false;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  const third = octets[2] ?? -1;
  if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255))
    return false;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function isPublicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (bytes === undefined) return false;
  const allZero = bytes.every((byte) => byte === 0);
  const loopback =
    bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const mappedIpv4 =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 255 &&
    bytes[11] === 255;
  if (mappedIpv4) {
    return isPublicIpv4(
      `${String(bytes[12])}.${String(bytes[13])}.${String(bytes[14])}.${String(bytes[15])}`,
    );
  }
  return !(
    allZero ||
    loopback ||
    (bytes[0] !== undefined && (bytes[0] & 0xfe) === 0xfc) ||
    (bytes[0] === 0xfe &&
      bytes[1] !== undefined &&
      (bytes[1] & 0xc0) === 0x80) ||
    bytes[0] === 0xff ||
    (bytes[0] === 0x20 &&
      bytes[1] === 0x01 &&
      bytes[2] === 0x0d &&
      bytes[3] === 0xb8)
  );
}

function ipv6Bytes(address: string): number[] | undefined {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const left = parseIpv6Parts(halves[0] ?? "");
  const right = parseIpv6Parts(halves[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  )
    return undefined;
  const parts = [
    ...left,
    ...Array.from({ length: missing }, () => 0),
    ...right,
  ];
  if (parts.length !== 8) return undefined;
  return parts.flatMap((part) => [part >>> 8, part & 0xff]);
}

function parseIpv6Parts(value: string): number[] | undefined {
  if (value === "") return [];
  const parts = value.split(":");
  const result: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/u.test(part)) return undefined;
    result.push(Number.parseInt(part, 16));
  }
  return result;
}

function fail(): never {
  throw new Error("invalid relay target");
}
