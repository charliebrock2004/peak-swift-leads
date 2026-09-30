/**
 * Structured server logs: one JSON object per line, readable in Vercel's log
 * view and any log drain.
 *
 * Every entry has an `event` name and the identifiers that let one be traced —
 * `userId`, `jobId`, `leadId`, `emailId`, `source`. Values are passed through
 * `redact`, so a field that looks like a credential is never written, however
 * it arrived: tokens, keys, secrets and passwords by field name, and
 * bearer/basic credentials or Google tokens by shape.
 */

type Level = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const SECRET_FIELD = /(token|secret|password|authorization|api[_-]?key|cookie|credential|refresh|access_?code|\bkey\b)/i;
const SECRET_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|ya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9._-]{20,}|GOCSPX-[A-Za-z0-9_-]+|enc:v1:[A-Za-z0-9:._-]+/g;

function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { name: error.name, message: redactString(error.message).slice(0, 500), ...(code ? { code: String(code) } : {}) };
  }
  return { message: redactString(String(error)).slice(0, 500) };
}

function redactString(value: string): string {
  return value.replace(SECRET_VALUE, "[redacted]");
}

export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value).slice(0, 2000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return errorFields(value);
  if (depth > 3) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const out: LogFields = {};
    for (const [key, item] of Object.entries(value as LogFields)) {
      out[key] = SECRET_FIELD.test(key) && key !== "tokenProblem" ? "[redacted]" : redact(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function write(level: Level, event: string, fields: LogFields = {}): void {
  const entry = { level, event, at: new Date().toISOString(), ...(redact(fields) as LogFields) };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const log = {
  info: (event: string, fields?: LogFields) => write("info", event, fields),
  warn: (event: string, fields?: LogFields) => write("warn", event, fields),
  error: (event: string, fields?: LogFields) => write("error", event, fields),
};
