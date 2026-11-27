// Convert HTML (support case comments, Customer Portal content) into compact Markdown for a
// language model: headings, lists, tables, code blocks, links, and admonitions survive; page
// chrome is dropped. Shared with mcp-redhat-knowledge; apply fixes to both copies.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const SKIP = new Set(["script", "style", "template", "noscript", "svg", "button", "rh-icon", "rh-tooltip", "rh-button", "head"]);
const SKIP_CLASS = /\b(copy-link|section-link|link-icon|check-icon)/;
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "details", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "rh-alert", "rh-code-block",
]);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", times: "×", rarr: "→", larr: "←", bull: "•", middot: "·", zwsp: "" };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(src) {
  const attrs = {};
  for (const m of src.matchAll(/([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

// Build a tolerant element tree: { tag, attrs, children } with text nodes as strings
export function parseHtml(html) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=/"'>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  let m;
  const top = () => stack[stack.length - 1];
  const text = (t) => { if (t) top().children.push(decodeEntities(t)); };
  while ((m = re.exec(html))) {
    text(html.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const at = stack.findLastIndex((n) => n.tag === tag);
      if (at > 0) stack.length = at;
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const node = { tag, attrs: parseAttrs(m[3] || ""), children: [] };
      top().children.push(node);
      if (RAW_TEXT.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag}`, last);
        const stop = end === -1 ? html.length : end;
        node.children.push(html.slice(last, stop));
        re.lastIndex = last = html.indexOf(">", stop) + 1 || html.length;
      } else if (!m[4] && !VOID.has(tag)) {
        stack.push(node);
      }
    }
  }
  text(html.slice(last));
  return root;
}

function skipped(node) {
  return SKIP.has(node.tag) || SKIP_CLASS.test(node.attrs.class || "") || "hidden" in node.attrs;
}

function textContent(node) {
  if (typeof node === "string") return node;
  if (skipped(node)) return "";
  if (node.tag === "br") return "\n";
  return node.children.map(textContent).join("");
}

function resolveHref(href, base) {
  if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function renderInline(nodes, ctx) {
  let out = "";
  for (const node of nodes) {
    if (typeof node === "string") {
      out += node.replace(/\s+/g, " ");
      continue;
    }
    if (skipped(node)) continue;
    const inner = () => renderInline(node.children, ctx);
    switch (node.tag) {
      case "br": out += "\n"; break;
      case "code": case "kbd": case "samp": case "tt": {
        const t = textContent(node).replace(/\s+/g, " ").trim();
        if (t) out += t.includes("`") ? `\`\` ${t} \`\`` : `\`${t}\``;
        break;
      }
      case "strong": case "b": { const t = inner().trim(); if (t) out += `**${t}**`; break; }
      case "em": case "i": case "cite": { const t = inner().trim(); if (t) out += `*${t}*`; break; }
      case "a": {
        const t = inner().trim();
        const href = resolveHref(node.attrs.href, ctx.base);
        out += href && t && href !== t ? `[${t}](${href})` : (t || href || "");
        break;
      }
      case "img": if (node.attrs.alt) out += `[image: ${node.attrs.alt}]`; break;
      default: out += inner();
    }
  }
  return out;
}

const tidy = (s) => s.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/[ \t]{2,}/g, " ").trim();

function renderTable(node, ctx) {
  const rows = [];
  const collect = (n) => {
    for (const c of n.children) {
      if (typeof c === "string" || skipped(c)) continue;
      if (c.tag === "tr") {
        rows.push(c.children.filter((x) => typeof x !== "string" && (x.tag === "td" || x.tag === "th"))
          .map((cell) => renderBlocks(cell.children, ctx).trim().replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|")));
      } else if (c.tag !== "table") {
        collect(c);
      }
    }
  };
  collect(node);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  const caption = node.children.find((c) => typeof c !== "string" && c.tag === "caption");
  const head = caption ? `**${tidy(renderInline(caption.children, ctx))}**\n\n` : "";
  return head + [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

function renderList(node, ctx) {
  const ordered = node.tag === "ol";
  let n = Number.parseInt(node.attrs.start, 10) || 1;
  const items = [];
  for (const c of node.children) {
    if (typeof c === "string" || skipped(c) || c.tag !== "li") continue;
    const marker = ordered ? `${n++}. ` : "- ";
    const body = renderBlocks(c.children, ctx).trim() || " ";
    const pad = " ".repeat(marker.length);
    items.push(marker + body.split("\n").map((l, i) => (i === 0 || !l ? l : pad + l)).join("\n"));
  }
  return items.join("\n");
}

function renderBlock(node, ctx) {
  switch (node.tag) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const t = tidy(renderInline(node.children, ctx)).replace(/\n+/g, " ");
      return t ? `${"#".repeat(Math.min(6, Number(node.tag[1]) + ctx.headingShift))} ${t}` : "";
    }
    case "pre": {
      const lang = (node.attrs.class || "").match(/language-([\w+-]+)/)?.[1];
      const code = textContent(node).replace(/^\n+|\s+$/g, "");
      const fence = code.includes("```") ? "~~~" : "```";
      return `${fence}${lang && lang !== "plaintext" ? lang : ""}\n${code}\n${fence}`;
    }
    case "ul": case "ol": return renderList(node, ctx);
    case "table": return renderTable(node, ctx);
    case "hr": return "---";
    case "dl": {
      const parts = [];
      for (const c of node.children) {
        if (typeof c === "string" || skipped(c)) continue;
        const body = renderBlocks(c.children, ctx).trim();
        if (c.tag === "dt") parts.push(`- **${body.replace(/\n+/g, " ")}**`);
        else if (c.tag === "dd") parts.push(body.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n"));
      }
      return parts.join("\n");
    }
    case "blockquote": case "rh-alert": {
      let header = "";
      let children = node.children;
      if (node.tag === "rh-alert") {
        const h = children.find((c) => typeof c !== "string" && /admonition_header/.test(c.attrs.class || ""));
        header = h ? tidy(textContent(h)) : (node.attrs.class || "").match(/admonition (\w+)/)?.[1] || "";
        children = children.filter((c) => c !== h);
      }
      const body = renderBlocks(children, ctx).trim();
      const text = header ? `**${header[0].toUpperCase()}${header.slice(1)}:** ${body}` : body;
      return text.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
    }
    case "p": {
      const cls = node.attrs.class || "";
      const t = tidy(renderInline(node.children, ctx));
      // docs.redhat.com marks block titles (Procedure, Prerequisites, Example) as p.title
      return /\btitle\b/.test(cls) && t && !t.startsWith("**") ? `**${t}**` : t;
    }
    default: return renderBlocks(node.children, ctx);
  }
}

export function renderBlocks(nodes, ctx) {
  const blocks = [];
  let inline = [];
  const flush = () => {
    const t = tidy(renderInline(inline, ctx));
    if (t) blocks.push(t);
    inline = [];
  };
  for (const node of nodes) {
    if (typeof node !== "string" && skipped(node)) continue;
    if (typeof node !== "string" && BLOCK.has(node.tag)) {
      flush();
      const b = renderBlock(node, ctx);
      if (b && b.trim()) blocks.push(b);
    } else {
      inline.push(node);
    }
  }
  flush();
  return blocks.join("\n\n");
}

function findById(node, id) {
  if (typeof node === "string") return null;
  if (node.attrs.id === id) return node;
  for (const c of node.children) {
    const hit = findById(c, id);
    if (hit) return hit;
  }
  return null;
}

// Convert HTML to Markdown. base resolves relative links; headingShift demotes headings so they
// nest under a tool's own title; fragment limits the output to the element with that id.
// Returns { markdown, fragmentFound }.
export function convertHtml(html, { base = "https://access.redhat.com/", headingShift = 0, fragment } = {}) {
  if (!html) return { markdown: "", fragmentFound: false };
  const root = parseHtml(String(html));
  const target = fragment ? findById(root, fragment) : null;
  const nodes = target ? [target] : root.children;
  const markdown = renderBlocks(nodes, { base, headingShift }).replace(/\n{3,}/g, "\n\n").trim();
  return { markdown, fragmentFound: Boolean(target) };
}

export function htmlToMarkdown(html, options) {
  return convertHtml(html, options).markdown;
}
