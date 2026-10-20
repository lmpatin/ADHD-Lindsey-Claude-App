// Link parsing: turns markdown links, HTML anchors and bare URLs into chips.

export interface LinkChip {
  label: string;
  url: string;
}

const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const HTML_ANCHOR = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const BARE_URL = /https?:\/\/[^\s<>"'\]\[()]+/g;

/** Known services, matched in order; the first hit names the chip. */
const KNOWN: { label: string; test: (u: URL) => boolean }[] = [
  { label: "Gmail", test: (u) => u.hostname === "mail.google.com" },
  { label: "Meet", test: (u) => u.hostname === "meet.google.com" },
  { label: "Google Doc", test: (u) => u.hostname === "docs.google.com" && u.pathname.startsWith("/document") },
  { label: "Google Sheet", test: (u) => u.hostname === "docs.google.com" && u.pathname.startsWith("/spreadsheets") },
  { label: "Google Slides", test: (u) => u.hostname === "docs.google.com" && u.pathname.startsWith("/presentation") },
  { label: "Google Form", test: (u) => u.hostname === "docs.google.com" && u.pathname.startsWith("/forms") },
  { label: "Google Drive", test: (u) => u.hostname === "drive.google.com" },
  { label: "Notion", test: (u) => hostIs(u, "notion.so") || hostIs(u, "notion.site") },
  { label: "Zoom", test: (u) => hostIs(u, "zoom.us") },
  { label: "Teams", test: (u) => hostIs(u, "teams.microsoft.com") || hostIs(u, "teams.live.com") },
  { label: "Salesforce", test: (u) => hostIs(u, "salesforce.com") || hostIs(u, "force.com") },
];

function hostIs(u: URL, domain: string): boolean {
  return u.hostname === domain || u.hostname.endsWith(`.${domain}`);
}

function parseUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Trailing punctuation that ends a sentence rather than the URL. */
function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?'"]+$/, "");
}

/** Chip label: the link text if any, else a known service name, else the hostname. */
export function chipLabel(url: string, text?: string): string {
  const t = text?.trim();
  if (t && t !== url && !/^https?:\/\//i.test(t)) return t;
  const u = parseUrl(url);
  if (!u) return url;
  for (const k of KNOWN) if (k.test(u)) return k.label;
  return u.hostname.replace(/^www\./, "");
}

/** Name of the known service for a URL, or null. */
export function knownService(url: string): string | null {
  const u = parseUrl(url);
  if (!u) return null;
  for (const k of KNOWN) if (k.test(u)) return k.label;
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
}

/**
 * Pulls every link out of one or more texts (Todoist markdown or Google
 * Calendar HTML), in order of appearance, without duplicates.
 */
export function extractLinks(...texts: (string | undefined | null)[]): LinkChip[] {
  const seen = new Set<string>();
  const out: LinkChip[] = [];
  const add = (rawUrl: string, text?: string) => {
    const url = trimUrl(decodeEntities(rawUrl));
    if (!parseUrl(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, label: chipLabel(url, text) });
  };

  for (const text of texts) {
    if (!text) continue;
    let rest = text;
    rest = rest.replace(HTML_ANCHOR, (_m, href: string, inner: string) => {
      add(href, stripTags(inner));
      return " ";
    });
    rest = rest.replace(MARKDOWN_LINK, (_m, label: string, href: string) => {
      add(href, label);
      return " ";
    });
    for (const m of rest.matchAll(BARE_URL)) add(m[0]);
  }
  return out;
}

/** Display text: markdown links collapse to their text; HTML is stripped. */
export function plainText(text: string | undefined | null): string {
  if (!text) return "";
  return stripTags(text.replace(MARKDOWN_LINK, (_m, label: string, href: string) => label || href))
    .replace(/[ \t]+/g, " ")
    .trim();
}
