import { describe, expect, test } from "vitest";
import { renderMarkdown, safeLink } from "../src/lib/markdown";

describe("untrusted task and comment markdown", () => {
  test.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "vbscript:msgbox(1)", "data:text/html,<script>alert(1)</script>", "java\nscript:alert(1)"])("rejects executable scheme %s", (url) => {
    expect(safeLink(url)).toBeUndefined();
    expect(renderMarkdown(`[click](${url})`)).not.toMatch(/href=/);
    expect(renderMarkdown(`![image](${url})`)).not.toMatch(/src=/);
  });
  test("drops HTML and escapes attribute injection, including highlight text", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n==<svg onload=alert(1)>==');
    expect(html).not.toMatch(/<(script|img|svg)\b/);
    expect(renderMarkdown('[link](https://example.com "&quot; onmouseover=alert(1)")')).not.toContain('title="" onmouseover');
    expect(renderMarkdown('[click](jav&#x61;script:alert(1))')).not.toContain('href="javascript:');
  });
  test("keeps ordinary markdown, highlights, checkboxes, and safe links", () => {
    const html = renderMarkdown("**bold** ==highlight== [link](https://example.com)\n\n- [ ] todo");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<mark>highlight</mark>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('type="checkbox"');
    expect(safeLink("#task")).toBe("#task");
    expect(safeLink("mailto:friend@example.com")).toBe("mailto:friend@example.com");
  });
});
