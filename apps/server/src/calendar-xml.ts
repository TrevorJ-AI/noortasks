export interface XmlNode {
  name: string;
  localName: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, ent: string) => {
    switch (ent) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        if (ent.startsWith("#x")) return String.fromCodePoint(Number.parseInt(ent.slice(2), 16));
        if (ent.startsWith("#")) return String.fromCodePoint(Number.parseInt(ent.slice(1), 10));
        return `&${ent};`;
    }
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1]!] = decodeXmlEntities(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

const localOf = (tag: string): string => {
  const i = tag.indexOf(":");
  return (i >= 0 ? tag.slice(i + 1) : tag).toLowerCase();
};

/** Lightweight namespace-prefix-agnostic XML tree parser for CalDAV 207 Multi-Status payloads. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", localName: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const len = xml.length;

  while (i < len) {
    const cur = stack[stack.length - 1]!;
    if (xml[i] !== "<") {
      const next = xml.indexOf("<", i);
      const rawText = next < 0 ? xml.slice(i) : xml.slice(i, next);
      cur.text += decodeXmlEntities(rawText);
      i = next < 0 ? len : next;
      continue;
    }

    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      const endIdx = end < 0 ? len : end;
      cur.text += xml.slice(i + 9, endIdx);
      i = end < 0 ? len : endIdx + 3;
      continue;
    }

    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      i = end < 0 ? len : end + 3;
      continue;
    }

    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2);
      i = end < 0 ? len : end + 2;
      continue;
    }

    if (xml.startsWith("<!", i)) {
      const end = xml.indexOf(">", i + 2);
      i = end < 0 ? len : end + 1;
      continue;
    }

    const closeIdx = xml.indexOf(">", i + 1);
    if (closeIdx < 0) break;
    const rawTag = xml.slice(i + 1, closeIdx).trim();
    i = closeIdx + 1;

    if (!rawTag) continue;
    if (rawTag.startsWith("/")) {
      const target = localOf(rawTag.slice(1).trim());
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k]!.localName === target) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const selfClosing = rawTag.endsWith("/");
    const body = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
    const sp = body.search(/\s/);
    const name = sp < 0 ? body : body.slice(0, sp);
    const attrStr = sp < 0 ? "" : body.slice(sp + 1);
    const node: XmlNode = {
      name,
      localName: localOf(name),
      attrs: attrStr ? parseAttrs(attrStr) : {},
      children: [],
      text: "",
    };
    if (stack.length > 64) throw new Error("calendar_xml_too_deep");
    cur.children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

export function findAll(node: XmlNode, localName: string): XmlNode[] {
  const target = localName.toLowerCase();
  const out: XmlNode[] = [];
  const walk = (n: XmlNode): void => {
    for (const c of n.children) {
      if (c.localName === target) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

export function findFirst(node: XmlNode, localName: string): XmlNode | undefined {
  const target = localName.toLowerCase();
  const walk = (n: XmlNode): XmlNode | undefined => {
    for (const c of n.children) {
      if (c.localName === target) return c;
      const hit = walk(c);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(node);
}

export function textOf(node: XmlNode | undefined): string {
  if (!node) return "";
  return node.text.trim();
}

export function buildPropfindPrincipalXml(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
    "  <D:prop>",
    "    <D:current-user-principal/>",
    "    <C:calendar-home-set/>",
    "    <D:resourcetype/>",
    "    <D:displayname/>",
    "  </D:prop>",
    "</D:propfind>",
  ].join("\n");
}

export function buildPropfindHomeSetXml(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
    "  <D:prop>",
    "    <C:calendar-home-set/>",
    "  </D:prop>",
    "</D:propfind>",
  ].join("\n");
}

export function buildPropfindCalendarsXml(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/">',
    "  <D:prop>",
    "    <D:resourcetype/>",
    "    <D:displayname/>",
    "    <A:calendar-color/>",
    "    <CS:getctag/>",
    "    <C:supported-calendar-component-set/>",
    "  </D:prop>",
    "</D:propfind>",
  ].join("\n");
}

function formatCalDavUtc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

export function buildReportCalendarQueryXml(fromMs: number, toMs: number): string {
  const start = formatCalDavUtc(fromMs);
  const end = formatCalDavUtc(toMs);
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
    "  <D:prop>",
    "    <D:getetag/>",
    "    <C:calendar-data/>",
    "  </D:prop>",
    "  <C:filter>",
    '    <C:comp-filter name="VCALENDAR">',
    '      <C:comp-filter name="VEVENT">',
    `        <C:time-range start="${start}" end="${end}"/>`,
    "      </C:comp-filter>",
    "    </C:comp-filter>",
    "  </C:filter>",
    "</C:calendar-query>",
  ].join("\n");
}
