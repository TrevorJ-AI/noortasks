import { Marked } from "marked";

const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function safeLink(href: string, image = false): string | undefined {
  try {
    const url = new URL(href, "https://noortasks.invalid/");
    if ((image ? ["http:", "https:"] : ["http:", "https:", "mailto:"]).includes(url.protocol)) return href;
  } catch { /* invalid link */ }
  return undefined;
}

const markdown = new Marked({
  gfm: true, breaks: true,
  renderer: {
    html: () => "",
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safe = safeLink(href);
      return safe === undefined ? text : `<a href="${escapeAttr(safe)}"${title ? ` title="${escapeAttr(title)}"` : ""} rel="noreferrer noopener">${text}</a>`;
    },
    image({ href, title, text }) {
      const safe = safeLink(href, true);
      return safe === undefined ? escapeAttr(text) : `<img src="${escapeAttr(safe)}" alt="${escapeAttr(text)}"${title ? ` title="${escapeAttr(title)}"` : ""}>`;
    },
  },
});

export function renderMarkdown(src: string): string {
  const html = markdown.parse(src, { async: false }) as string;
  // Apply highlights after markdown escaping; never interpolate unescaped input into HTML.
  return html.replace(/==([^=<\n]+)==/g, "<mark>$1</mark>");
}
