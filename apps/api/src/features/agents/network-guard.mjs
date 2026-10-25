import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../../core/config.mjs";

function unsafeEndpoint(message) {
  const error = new Error(message);
  error.code = "UNSAFE_AGENT_ENDPOINT";
  return error;
}

function inCidr(value, network, prefix, width) {
  const shift = BigInt(width - prefix);
  return (value >> shift) === (network >> shift);
}

function ipv4Value(address) {
  if (net.isIP(address) !== 4) return null;
  return address
    .split(".")
    .reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

const ipv4BlockedCidrs = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].map(([address, prefix]) => [ipv4Value(address), prefix]);

function parseIPv6(address) {
  if (net.isIP(address) !== 6) return null;
  let input = address.toLowerCase();
  const dottedIndex = input.lastIndexOf(":");
  if (input.includes(".")) {
    const dotted = input.slice(dottedIndex + 1);
    const ipv4 = ipv4Value(dotted);
    if (ipv4 === null) return null;
    const high = Number((ipv4 >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4 & 0xffffn).toString(16);
    input = `${input.slice(0, dottedIndex)}:${high}:${low}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) {
    return null;
  }
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

const ipv6BlockedCidrs = [
  ["64:ff9b::", 96], // Well-known NAT64 prefix can encode non-public IPv4 destinations.
  ["64:ff9b:1::", 48],
  ["100::", 64], // Discard-only range.
  ["2001::", 23], // IETF protocol assignments, including Teredo and benchmarking.
  ["2001:db8::", 32], // Documentation.
  ["2002::", 16], // 6to4 embeds an IPv4 destination.
  ["3ffe::", 16], // Deprecated 6bone allocation.
  ["3fff::", 20], // Documentation.
].map(([address, prefix]) => [parseIPv6(address), prefix]);

function isPublicAddress(address, family = net.isIP(address)) {
  if (family === 4) {
    const value = ipv4Value(address);
    return value !== null && !ipv4BlockedCidrs.some(([network, prefix]) => inCidr(value, network, prefix, 32));
  }
  if (family !== 6) return false;

  const value = parseIPv6(address);
  if (value === null) return false;
  // Only global-unicast IPv6 is accepted. This rejects unspecified, loopback,
  // IPv4-mapped, ULA, link-local, multicast, and other non-global ranges.
  if (!inCidr(value, parseIPv6("2000::"), 3, 128)) return false;
  return !ipv6BlockedCidrs.some(([network, prefix]) => inCidr(value, network, prefix, 128));
}

function validateUrl(rawUrl) {
  let endpoint;
  try {
    endpoint = new URL(rawUrl);
  } catch {
    throw unsafeEndpoint("Agent endpoint must be a valid URL.");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw unsafeEndpoint("Agent endpoint must use HTTP or HTTPS.");
  }
  if (config.isProduction && endpoint.protocol !== "https:") {
    throw unsafeEndpoint("Agent endpoints must use HTTPS in production.");
  }
  if (endpoint.username || endpoint.password) {
    throw unsafeEndpoint("Agent endpoint must not contain credentials in the URL.");
  }
  return endpoint;
}

function isLocalHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local");
}

export async function resolveSafeAgentEndpoint(rawUrl, { lookup = dns.lookup } = {}) {
  const endpoint = validateUrl(rawUrl);
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
  const allowPrivate = config.allowPrivateAgentEndpoints;

  if (!hostname || (!allowPrivate && isLocalHostname(hostname))) {
    throw unsafeEndpoint("Private and local agent endpoints are not allowed.");
  }

  const literalFamily = net.isIP(hostname);
  let addresses;
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw unsafeEndpoint("Agent endpoint hostname could not be resolved.");
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw unsafeEndpoint("Private and local agent endpoints are not allowed.");
  }

  for (const entry of addresses) {
    const family = entry?.family;
    const address = entry?.address;
    if ((family !== 4 && family !== 6) || net.isIP(address) !== family) {
      throw unsafeEndpoint("Private and local agent endpoints are not allowed.");
    }
    if (!allowPrivate && !isPublicAddress(address, family)) {
      throw unsafeEndpoint("Private and local agent endpoints are not allowed.");
    }
  }

  // Pin the selected, already-validated address into every outbound request.
  // This avoids a second DNS lookup between validation and connection.
  const { address, family } = addresses[0];
  return { endpoint, address, family };
}

export function createPinnedLookup(address, family) {
  if (net.isIP(address) !== family || (family !== 4 && family !== 6)) {
    throw new Error("A valid, previously resolved IP address is required for a pinned connection.");
  }
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

export async function assertSafeAgentEndpoint(rawUrl, options) {
  return (await resolveSafeAgentEndpoint(rawUrl, options)).endpoint;
}
