function compact(value: unknown, maxLength = 180): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

export function logInfo(message: string, fields: Record<string, unknown> = {}): void {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${compact(value)}`)
    .join(" ");
  console.log(`[${new Date().toISOString()}] ${message}${suffix ? ` ${suffix}` : ""}`);
}

export function logError(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[${new Date().toISOString()}] ${message} error=${compact(detail)}`);
}
