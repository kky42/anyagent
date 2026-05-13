import { marked } from "marked";

const HTML_TAG_PATTERN = /(<\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)>/g;
const PROTECTED_PRE_PATTERN = /<pre\b[^>]*>[\s\S]*?<\/pre>/gi;

function escapeHtmlAttr(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeHtmlText(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function decodeHtmlEntities(text) {
  const named = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", '"'],
    ["apos", "'"],
    ["nbsp", " "]
  ]);

  return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (entity, body) => {
    const key = String(body ?? "").toLowerCase();
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
      } catch {
        return entity;
      }
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
      } catch {
        return entity;
      }
    }
    return named.get(key) ?? entity;
  });
}

function normalizeTelegramHtmlSpacing(html) {
  const preserved = [];
  const withPlaceholders = String(html ?? "").replace(PROTECTED_PRE_PATTERN, (block) => {
    const token = `@@PRE${preserved.length}@@`;
    preserved.push(block);
    return token;
  });
  const normalized = withPlaceholders
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized.replace(/@@PRE(\d+)@@/g, (_match, index) => preserved[Number(index)] ?? "");
}

function inlineTokenText(token) {
  if (!token) return "";
  if (Array.isArray(token.tokens)) return token.tokens.map(inlineTokenText).join("");
  if (token.type === "br") return " ";
  if (token.type === "html") return token.raw ?? token.text ?? "";
  if (token.type === "image") return token.text ?? "";
  return token.text ?? token.raw ?? "";
}

function tableCellText(cell) {
  const text = Array.isArray(cell?.tokens) ? cell.tokens.map(inlineTokenText).join("") : cell?.text;
  return decodeHtmlEntities(text).replace(/\s+/g, " ").trim();
}

function cellText(html) {
  return decodeHtmlEntities(String(html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(HTML_TAG_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim());
}

function cellAlign(attrs) {
  const align = /\balign=(?:["']?)(left|center|right)(?:["']?)/i.exec(String(attrs ?? ""))?.[1];
  return align ? align.toLowerCase() : null;
}

function padTableCell(text, width, align) {
  const value = String(text ?? "");
  const missing = Math.max(0, width - value.length);
  if (align === "right") return `${" ".repeat(missing)}${value}`;
  if (align === "center") {
    const left = Math.floor(missing / 2);
    return `${" ".repeat(left)}${value}${" ".repeat(missing - left)}`;
  }
  return `${value}${" ".repeat(missing)}`;
}

function renderTableAsText(tableHtml) {
  const rows = [];
  const aligns = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(String(tableHtml ?? ""))) !== null) {
    const cells = [];
    const cellPattern = /<t([hd])\b([^>]*)>([\s\S]*?)<\/t\1>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      const index = cells.length;
      cells.push(cellText(cellMatch[3]));
      aligns[index] ??= cellAlign(cellMatch[2]);
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return "";

  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_value, column) => Math.max(
    1,
    ...rows.map((row) => String(row[column] ?? "").length)
  ));
  const line = (row) => widths.map((width, column) => padTableCell(row[column] ?? "", width, aligns[column])).join(" | ").trimEnd();
  const separator = widths.map((width) => "-".repeat(width)).join(" | ");
  const lines = [line(rows[0])];
  if (rows.length > 1) lines.push(separator);
  for (const row of rows.slice(1)) lines.push(line(row));
  return lines.join("\n");
}

function renderTablesAsPre(html) {
  return String(html ?? "").replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (tableHtml) => {
    const text = renderTableAsText(tableHtml);
    return text ? `<pre>${escapeHtmlText(text)}</pre>` : "";
  });
}

function renderTableTokenAsText(token) {
  const rows = [token.header.map(tableCellText), ...token.rows.map((row) => row.map(tableCellText))];
  if (!rows.length) return "";
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_value, column) => Math.max(
    1,
    ...rows.map((row) => String(row[column] ?? "").length)
  ));
  const line = (row) => widths.map((width, column) => padTableCell(row[column] ?? "", width, token.align?.[column])).join(" | ").trimEnd();
  const separator = widths.map((width) => "-".repeat(width)).join(" | ");
  return [line(rows[0]), separator, ...rows.slice(1).map(line)].join("\n");
}

function replaceMarkdownTables(markdown) {
  const source = String(markdown ?? "");
  const tokens = new marked.Lexer({ gfm: true, breaks: true }).lex(source);
  let cursor = 0;
  let out = "";
  for (const token of tokens) {
    if (token.type !== "table") continue;
    const index = source.indexOf(token.raw, cursor);
    if (index < 0) continue;
    out += source.slice(cursor, index);
    const tableText = renderTableTokenAsText(token);
    out += tableText ? `<pre>${escapeHtmlText(tableText)}</pre>\n\n` : "";
    cursor = index + token.raw.length;
  }
  return cursor ? out + source.slice(cursor) : source;
}

function transformMarkdownHtml(html) {
  html = renderTablesAsPre(html);
  const listStack = [];
  let listItemDepth = 0;
  let preserveWhitespace = false;
  let out = "";
  let lastIndex = 0;

  const append = (text) => {
    out += text;
  };

  const appendBlockBreak = () => {
    append(listItemDepth > 0 ? "\n" : "\n\n");
  };

  const appendHtmlText = (text) => {
    if (!text) return;
    if (!preserveWhitespace && /\n/.test(text) && !text.trim()) return;
    append(text);
  };

  HTML_TAG_PATTERN.lastIndex = 0;
  let match;
  while ((match = HTML_TAG_PATTERN.exec(String(html ?? ""))) !== null) {
    appendHtmlText(match.input.slice(lastIndex, match.index));

    const isClosing = match[1] === "</";
    const name = String(match[2] ?? "").toLowerCase();
    const attrs = String(match[3] ?? "");

    if (isClosing) {
      switch (name) {
        case "strong":
        case "b":
          append("</b>");
          break;
        case "em":
        case "i":
          append("</i>");
          break;
        case "s":
        case "strike":
        case "del":
          append("</s>");
          break;
        case "code":
          append("</code>");
          break;
        case "pre":
          append("</pre>");
          preserveWhitespace = false;
          appendBlockBreak();
          break;
        case "a":
          append("</a>");
          break;
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6":
          append("</b>");
          appendBlockBreak();
          break;
        case "p":
          appendBlockBreak();
          break;
        case "blockquote":
          append("</blockquote>");
          appendBlockBreak();
          break;
        case "li":
          if (!out.endsWith("\n")) append("\n");
          if (listItemDepth > 0) listItemDepth -= 1;
          break;
        case "ul":
        case "ol":
          if (listStack.length > 0) listStack.pop();
          append("\n");
          break;
        default:
          break;
      }
    } else {
      switch (name) {
        case "strong":
        case "b":
          append("<b>");
          break;
        case "em":
        case "i":
          append("<i>");
          break;
        case "s":
        case "strike":
        case "del":
          append("<s>");
          break;
        case "code":
          append("<code>");
          break;
        case "pre":
          append("<pre>");
          preserveWhitespace = true;
          break;
        case "a": {
          const href = /\shref=(["'])(.*?)\1/i.exec(attrs)?.[2]?.trim();
          if (href) append(`<a href="${escapeHtmlAttr(href)}">`);
          break;
        }
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6":
          append("<b>");
          break;
        case "p":
          break;
        case "blockquote":
          append("<blockquote>");
          break;
        case "br":
          append("\n");
          break;
        case "hr":
          append("---\n\n");
          break;
        case "ul":
          listStack.push({ type: "bullet", index: 0 });
          break;
        case "ol": {
          const start = Number(/\bstart=(["']?)(\d+)\1/i.exec(attrs)?.[2] ?? "1");
          listStack.push({ type: "ordered", index: start - 1 });
          break;
        }
        case "li": {
          const depth = listStack.length;
          const prefix = depth > 1 ? "  ".repeat(depth - 1) : "";
          const current = listStack.at(-1);
          if (current?.type === "ordered") {
            current.index += 1;
            append(`${prefix}${current.index}. `);
          } else {
            append(`${prefix}• `);
          }
          listItemDepth += 1;
          break;
        }
        default:
          break;
      }
    }

    lastIndex = match.index + match[0].length;
  }

  appendHtmlText(match?.input?.slice(lastIndex) ?? String(html ?? "").slice(lastIndex));
  return normalizeTelegramHtmlSpacing(out);
}

export function renderMarkdownToTelegramHtml(markdown) {
  const prepared = replaceMarkdownTables(String(markdown ?? ""));
  const raw = marked.parse(prepared, { async: false, gfm: true, breaks: true });
  return transformMarkdownHtml(raw);
}
