const SENSITIVE_KEY = /password|secret|token|api[_-]?key|authorization|cookie|payment|card|cvv|ssn|full[_-]?profile|private[_-]?key/i;
const MAX_DEPTH = 6;
const MAX_KEYS = 40;
const MAX_ITEMS = 40;
const MAX_STRING = 1200;

export function redactEvidence(value, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  if (depth >= MAX_DEPTH) return "[redacted: depth limit]";
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => redactEvidence(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, MAX_KEYS).map(([key, current]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : redactEvidence(current, depth + 1),
      ]),
    );
  }
  return String(value).slice(0, MAX_STRING);
}

export function redactToolCall(call) {
  if (!call || typeof call !== "object") return null;
  return {
    name: typeof call.name === "string" ? call.name.slice(0, 160) : "unknown",
    arguments: redactEvidence(call.arguments ?? {}),
    ...(call.parseError ? { parseError: String(call.parseError).slice(0, 300) } : {}),
  };
}
