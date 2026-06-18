function escapeInlineCode(text) {
  return String(text ?? "").replaceAll("`", "\\`");
}

function escapeTableCell(text) {
  return String(text ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("|", "\\|");
}

function normalizeBlankLines(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function linkMarkdown(label, url) {
  const text = richTextToMarkdown(label).trim() || String(url ?? "").trim();
  const href = String(url ?? "").trim();
  return href ? `[${text}](${href})` : text;
}

export function richTextToMarkdown(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(richTextToMarkdown).join("");
  }

  if (typeof value !== "object") {
    return String(value);
  }

  const type = String(value.type ?? "");
  const text = richTextToMarkdown(value.text);

  switch (type) {
    case "bold":
      return `**${text}**`;
    case "italic":
      return `_${text}_`;
    case "underline":
      return `<u>${text}</u>`;
    case "strikethrough":
      return `~~${text}~~`;
    case "spoiler":
      return `||${text}||`;
    case "subscript":
      return `<sub>${text}</sub>`;
    case "superscript":
      return `<sup>${text}</sup>`;
    case "marked":
      return `==${text}==`;
    case "code":
      return `\`${escapeInlineCode(text)}\``;
    case "custom_emoji":
      return String(value.alternative_text ?? text ?? "");
    case "mathematical_expression":
      return value.expression ? `$${value.expression}$` : text;
    case "url":
      return linkMarkdown(value.text, value.url);
    case "email_address":
      return linkMarkdown(value.text, value.email_address ? `mailto:${value.email_address}` : "");
    case "phone_number":
      return linkMarkdown(value.text, value.phone_number ? `tel:${value.phone_number}` : "");
    case "text_mention": {
      const userId = value.user?.id;
      return linkMarkdown(value.text, userId !== null && userId !== undefined ? `tg://user?id=${userId}` : "");
    }
    case "date_time":
      return text;
    case "anchor":
      return value.name ? `<a name="${value.name}"></a>` : "";
    case "anchor_link":
      return value.anchor_name ? `[${text}](#${value.anchor_name})` : text;
    case "reference":
      return value.name ? `[^${value.name}]: ${text}` : text;
    case "reference_link":
      return value.reference_name ? `${text}[^${value.reference_name}]` : text;
    case "mention":
    case "hashtag":
    case "cashtag":
      return text || String(value.value ?? value.name ?? "");
    case "bot_command": {
      const command = text || String(value.value ?? value.name ?? "");
      return command && !command.startsWith("/") ? `/${command}` : command;
    }
    default:
      return text || String(value.expression ?? value.alternative_text ?? value.url ?? value.name ?? "");
  }
}

function captionMarkdown(caption) {
  if (!caption || typeof caption !== "object") {
    return "";
  }

  const text = richTextToMarkdown(caption.text).trim();
  const credit = richTextToMarkdown(caption.credit).trim();
  if (text && credit) {
    return `${text} — ${credit}`;
  }
  return text || credit;
}

function renderBlocks(blocks, depth = 0) {
  return normalizeBlankLines(
    (Array.isArray(blocks) ? blocks : [])
      .map((block) => richBlockToMarkdown(block, depth))
      .filter((part) => String(part ?? "").trim())
      .join("\n\n")
  );
}

function indentContinuation(text, spaces = 2) {
  const indent = " ".repeat(spaces);
  return String(text ?? "")
    .split("\n")
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join("\n");
}

function listMarker(item) {
  if (item?.has_checkbox) {
    return item.is_checked ? "- [x]" : "- [ ]";
  }
  if (Number.isFinite(Number(item?.value))) {
    return `${Number(item.value)}.`;
  }
  const label = String(item?.label ?? "").trim();
  if (/^\d+[.)]$/.test(label)) {
    return label.endsWith(".") ? label : `${label.slice(0, -1)}.`;
  }
  return "-";
}

function renderList(block, depth) {
  return (Array.isArray(block.items) ? block.items : [])
    .map((item) => {
      const body = renderBlocks(item?.blocks, depth + 1) || richTextToMarkdown(item?.text).trim();
      if (!body) {
        return "";
      }
      const indent = "  ".repeat(depth);
      return `${indent}${listMarker(item)} ${indentContinuation(body, 2).trimStart()}`;
    })
    .filter(Boolean)
    .join("\n");
}

function renderBlockQuote(block) {
  const body = renderBlocks(block.blocks) || richTextToMarkdown(block.text).trim();
  const credit = richTextToMarkdown(block.credit).trim();
  const lines = credit ? `${body}\n— ${credit}` : body;
  return lines
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

function renderTable(block) {
  const rows = Array.isArray(block.cells) ? block.cells : [];
  if (rows.length === 0) {
    return captionMarkdown(block.caption);
  }

  const tableRows = rows.map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => escapeTableCell(richTextToMarkdown(cell?.text)))
  );
  const columnCount = Math.max(1, ...tableRows.map((row) => row.length));
  const normalizedRows = tableRows.map((row) => [
    ...row,
    ...Array.from({ length: Math.max(0, columnCount - row.length) }, () => "")
  ]);
  const hasHeader = rows[0]?.some?.((cell) => cell?.is_header) ?? false;
  const header = hasHeader ? normalizedRows[0] : normalizedRows[0].map((cell) => cell || " ");
  const bodyRows = hasHeader ? normalizedRows.slice(1) : normalizedRows.slice(1);
  const separator = Array.from({ length: columnCount }, () => "---");
  const table = [header, separator, ...bodyRows]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
  const caption = captionMarkdown(block.caption);
  return caption ? `${caption}\n\n${table}` : table;
}

function mediaLabel(block) {
  const caption = captionMarkdown(block.caption);
  const type = String(block?.type ?? "media").replaceAll("_", " ");
  return caption ? `[${type}: ${caption}]` : `[${type}]`;
}

function richBlockToMarkdown(block, depth = 0) {
  if (!block || typeof block !== "object") {
    return "";
  }

  switch (block.type) {
    case "paragraph":
      return richTextToMarkdown(block.text);
    case "heading": {
      const size = Math.min(6, Math.max(1, Number(block.size) || 1));
      return `${"#".repeat(size)} ${richTextToMarkdown(block.text).trim()}`.trim();
    }
    case "pre": {
      const language = String(block.language ?? "").trim();
      return `\`\`\`${language}\n${richTextToMarkdown(block.text)}\n\`\`\``;
    }
    case "footer":
      return richTextToMarkdown(block.text);
    case "divider":
      return "---";
    case "mathematical_expression":
      return block.expression ? `$$${block.expression}$$` : "";
    case "anchor":
      return block.name ? `<a name="${block.name}"></a>` : "";
    case "list":
      return renderList(block, depth);
    case "blockquote":
    case "pullquote":
      return renderBlockQuote(block);
    case "collage":
    case "slideshow": {
      const body = renderBlocks(block.blocks, depth);
      const caption = captionMarkdown(block.caption);
      return [body, caption].filter(Boolean).join("\n\n");
    }
    case "table":
      return renderTable(block);
    case "details": {
      const summary = richTextToMarkdown(block.summary).trim() || "Details";
      const body = renderBlocks(block.blocks, depth);
      const open = block.is_open ? " open" : "";
      return `<details${open}><summary>${summary}</summary>\n\n${body}\n\n</details>`;
    }
    case "map":
    case "animation":
    case "audio":
    case "photo":
    case "video":
    case "voice_note":
      return mediaLabel(block);
    case "thinking":
      return richTextToMarkdown(block.text);
    default:
      return richTextToMarkdown(block.text) || captionMarkdown(block.caption);
  }
}

export function richMessageToMarkdown(richMessage) {
  return renderBlocks(richMessage?.blocks);
}

export function telegramMessageText(message) {
  if (typeof message?.text === "string") {
    return message.text;
  }
  if (typeof message?.caption === "string") {
    return message.caption;
  }
  return richMessageToMarkdown(message?.rich_message ?? message?.richMessage);
}
