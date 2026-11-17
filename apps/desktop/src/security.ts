export function allowedNavigation(target: string, origin: string): boolean {
  try { return new URL(target).origin === origin; } catch { return false; }
}

export function safeExternal(target: string): boolean {
  try { return ["https:", "http:", "mailto:"].includes(new URL(target).protocol); } catch { return false; }
}
