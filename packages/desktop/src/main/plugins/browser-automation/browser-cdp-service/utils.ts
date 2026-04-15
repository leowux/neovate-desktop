import { minimatch } from "minimatch";

export function normalizeBrowserRef(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

export function formatBrowserRef(ref: string): string {
  return ref.startsWith("@") ? ref : `@${ref}`;
}

export function normalizeBrowserUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function matchesBrowserPattern(value: string, pattern: string): boolean {
  return minimatch(value, pattern, { nocase: true, matchBase: true });
}
