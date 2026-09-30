export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function safeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value, globalThis.location?.href || "https://example.invalid/");
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
}

export function formatDate(value, withTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", ...(withTime ? { timeStyle: "short" } : {}), timeZone: "America/Sao_Paulo" }).format(date);
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

export function toast(message) {
  const region = document.getElementById("toast-region");
  if (!region) return;
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = message;
  region.appendChild(item);
  setTimeout(() => item.remove(), 3600);
}

function renderRichText(parent, parts = []) {
  for (const part of parts) {
    const text = document.createTextNode(part.text || "");
    const href = safeUrl(part.href);
    let node = text;
    if (href) {
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.appendChild(node);
      node = anchor;
    }
    const marks = [["code", "code"], ["bold", "strong"], ["italic", "em"], ["strikethrough", "s"], ["underline", "u"]];
    for (const [key, tag] of marks) {
      if (!part.annotations?.[key]) continue;
      const wrapper = document.createElement(tag);
      wrapper.appendChild(node);
      node = wrapper;
    }
    parent.appendChild(node);
  }
}

function renderList(blocks, start, parent) {
  const type = blocks[start].type;
  const list = document.createElement(type === "numbered_list_item" ? "ol" : "ul");
  let index = start;
  while (index < blocks.length && blocks[index].type === type) {
    const item = document.createElement("li");
    renderRichText(item, blocks[index].richText);
    if (blocks[index].children?.length) renderBlocks(blocks[index].children, item);
    list.appendChild(item);
    index += 1;
  }
  parent.appendChild(list);
  return index;
}

export function renderBlocks(blocks = [], parent) {
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index];
    if (block.type === "bulleted_list_item" || block.type === "numbered_list_item") {
      index = renderList(blocks, index, parent);
      continue;
    }
    let node;
    if (block.type === "heading_1") node = document.createElement("h2");
    else if (block.type === "heading_2") node = document.createElement("h3");
    else if (block.type === "heading_3") node = document.createElement("h4");
    else if (block.type === "heading_4") node = document.createElement("h5");
    else if (block.type === "quote") node = document.createElement("blockquote");
    else if (block.type === "divider") { parent.appendChild(document.createElement("hr")); index += 1; continue; }
    else if (block.type === "code") {
      node = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = (block.richText || []).map(part => part.text).join("");
      node.appendChild(code);
    } else if (block.type === "callout") {
      node = document.createElement("aside");
      node.className = "reader-callout";
      if (block.icon) {
        const icon = document.createElement("span"); icon.className = "reader-callout-icon"; icon.setAttribute("aria-hidden", "true"); icon.textContent = block.icon; node.appendChild(icon);
      }
      const body = document.createElement("div"); renderRichText(body, block.richText); if (block.children?.length) renderBlocks(block.children, body); node.appendChild(body); parent.appendChild(node); index += 1; continue;
    } else if (block.type === "to_do") {
      node = document.createElement("p");
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.disabled = true; checkbox.checked = Boolean(block.checked); node.appendChild(checkbox);
    } else if (block.type === "toggle") {
      node = document.createElement("details");
      const summary = document.createElement("summary"); renderRichText(summary, block.richText); node.appendChild(summary);
      const body = document.createElement("div"); if (block.children?.length) renderBlocks(block.children, body); node.appendChild(body); parent.appendChild(node); index += 1; continue;
    } else if (block.type === "table") {
      node = document.createElement("table");
      for (const [rowIndex, row] of (block.children || []).entries()) {
        if (row.type !== "table_row") continue;
        const tr = document.createElement("tr");
        for (const cell of row.cells || []) {
          const cellNode = document.createElement(rowIndex === 0 && block.hasColumnHeader ? "th" : "td");
          renderRichText(cellNode, cell); tr.appendChild(cellNode);
        }
        node.appendChild(tr);
      }
    } else if (["image", "file", "pdf", "video", "audio", "bookmark", "embed", "link_preview", "child_page", "link_to_page", "child_database"].includes(block.type)) {
      node = document.createElement("p");
      const href = safeUrl(block.url);
      if (href) {
        const anchor = document.createElement("a"); anchor.href = href; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
        anchor.textContent = block.title || block.caption || "Abrir referência no Notion ↗"; node.appendChild(anchor);
      } else {
        node.textContent = block.caption || block.title || "Arquivo ou banco vinculado disponível na página original do Notion.";
      }
    } else if (block.type === "equation") {
      node = document.createElement("p"); const code = document.createElement("code"); code.textContent = block.expression || ""; node.appendChild(code);
    } else {
      node = document.createElement("p");
      if (block.caption) node.textContent = block.caption;
      else if (block.title) node.textContent = block.title;
    }
    if (["paragraph", "heading_1", "heading_2", "heading_3", "heading_4", "quote", "to_do"].includes(block.type)) renderRichText(node, block.richText);
    if (block.children?.length && block.type !== "table") renderBlocks(block.children, node);
    parent.appendChild(node);
    index += 1;
  }
}

export function blocksToText(blocks = []) {
  const parts = [];
  for (const block of blocks) {
    if (block.richText?.length) parts.push(block.richText.map(part => part.text).join(""));
    if (block.title) parts.push(block.title);
    if (block.caption) parts.push(block.caption);
    if (block.cells) parts.push(block.cells.flat().map(part => part.text).join(" "));
    if (block.children?.length) parts.push(blocksToText(block.children));
  }
  return parts.join("\n");
}

export function setLoadingError(root, message) {
  root.innerHTML = `<div class="page-wrap"><section class="empty-state"><div class="empty-icon">!</div><h2>O conteúdo do Notion ainda não chegou</h2><p>${escapeHtml(message)}</p><p>O app mantém o último snapshot válido quando a sincronização falha. Execute o workflow de conteúdo no GitHub depois de confirmar o compartilhamento de leitura.</p><a class="button button-primary" href="https://github.com/RodrigoRosaDantas/haba-study-os/actions/workflows/sync-notion.yml" target="_blank" rel="noopener noreferrer">Abrir sincronização do Notion ↗</a></section></div>`;
}
