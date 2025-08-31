export type InMemoryFile = { filename: string; text: string };

export function bufferToString(buf?: Buffer): string {
  if (!buf) return "";
  return buf.toString("utf8");
}

export function normalizeNL(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

export function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

