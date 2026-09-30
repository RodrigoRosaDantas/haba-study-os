import { createHash } from "node:crypto";

export const NOTION_API_VERSION = "2026-03-11";
export const SOURCE_IDS = Object.freeze({
  studyDays: "cccefaca-37e8-49cc-b646-e421398e3347",
  weeklyTrack: "31051e23-c9b4-41f4-aa6c-e5ba0afb3166",
  questions: "c5f7936a-f8ae-4787-afa8-51009d524499"
});

const API = "https://api.notion.com/v1";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let requestChain = Promise.resolve();
let lastRequestStart = 0;

function paceRequest() {
  const next = requestChain.then(async () => {
    const wait = Math.max(0, 350 - (Date.now() - lastRequestStart));
    if (wait) await pause(wait);
    lastRequestStart = Date.now();
  });
  requestChain = next.catch(() => {});
  return next;
}

export function plainRichText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(part => part?.plain_text ?? part?.text?.content ?? "").join("");
}

export function propertyValue(page, name) {
  const property = page?.properties?.[name];
  if (!property) return "";
  const type = property.type;
  const value = property[type];
  if (type === "title" || type === "rich_text") return plainRichText(value);
  if (type === "url") return value || "";
  if (type === "number") return value ?? null;
  if (type === "checkbox") return Boolean(value);
  if (type === "select") return value?.name || "";
  if (type === "status") return value?.name || "";
  if (type === "multi_select") return (value || []).map(item => item.name);
  if (type === "date") return value?.start || "";
  if (type === "people") return (value || []).map(item => item.name || item.id);
  if (type === "relation") return (value || []).map(item => item.id);
  return "";
}

export function pageTitle(page) {
  for (const [name, property] of Object.entries(page?.properties || {})) {
    if (property?.type === "title") return propertyValue(page, name);
  }
  return page?.title?.map(item => item.plain_text || "").join("") || "";
}

export function notionId(value) {
  const match = String(value || "").match(/[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f-]{27}/i);
  return match ? match[0].replaceAll("-", "") : "";
}

export function notionUrl(id) {
  return id ? `https://www.notion.so/${id.replaceAll("-", "")}` : "";
}

function richTextPart(part) {
  const text = part?.plain_text ?? part?.text?.content ?? "";
  const annotations = part?.annotations || {};
  let href = part?.href || part?.text?.link?.url || "";
  if (!href && part?.mention?.page?.id) href = notionUrl(part.mention.page.id);
  if (!href && part?.mention?.database?.id) href = notionUrl(part.mention.database.id);
  return { text, href, annotations: {
    bold: Boolean(annotations.bold), italic: Boolean(annotations.italic), code: Boolean(annotations.code),
    strikethrough: Boolean(annotations.strikethrough), underline: Boolean(annotations.underline), color: annotations.color || "default"
  } };
}

function imageHref(value) {
  if (value?.type === "external") return value.external?.url || "";
  return "";
}

export function normalizeBlock(block) {
  const type = block.type;
  const data = block[type] || {};
  const rich = data.rich_text || data.title || data.caption || [];
  const result = { id: block.id, type, richText: rich.map(richTextPart), children: [] };
  if (type === "to_do") result.checked = Boolean(data.checked);
  if (type === "callout") result.icon = data.icon?.emoji || data.icon?.external?.url || "";
  if (type === "code") result.language = data.language || "plain text";
  if (type === "equation") result.expression = data.expression || "";
  if (type === "image" || type === "file" || type === "pdf" || type === "video" || type === "audio") {
    const file = data.file || data.external;
    result.url = imageHref(file);
    result.caption = plainRichText(data.caption);
    result.hasNotionHostedFile = file?.type === "file";
  }
  if (type === "bookmark" || type === "embed" || type === "link_preview") {
    result.url = data.url || "";
    result.caption = plainRichText(data.caption);
  }
  if (type === "child_page" || type === "child_database") {
    result.title = data.title || "";
    result.url = notionUrl(block.id);
  }
  if (type === "link_to_page") {
    const target = data.page_id || data.database_id || data.block_id;
    result.url = notionUrl(target);
    result.title = "Abrir página vinculada no Notion";
  }
  if (type === "table") result.hasColumnHeader = Boolean(data.has_column_header);
  if (type === "table_row") result.cells = (data.cells || []).map(cell => cell.map(richTextPart));
  if (type === "synced_block") result.syncedFrom = data.synced_from?.block_id || "";
  return result;
}

export function flattenBlockText(blocks = []) {
  const output = [];
  for (const block of blocks) {
    if (block.richText?.length) output.push(block.richText.map(part => part.text).join(""));
    if (block.title) output.push(block.title);
    if (block.caption) output.push(block.caption);
    if (block.cells) output.push(block.cells.map(cell => cell.map(part => part.text).join("")).join(" "));
    if (block.children?.length) output.push(flattenBlockText(block.children));
  }
  return output.join("\n");
}

export function parseOptions(summary) {
  const chunks = String(summary || "")
    .replace(/\s+(?=[A-E]\s*[).:-]\s*)/gi, "\n")
    .split(/\s*(?:\||;|\n)+\s*/).filter(Boolean);
  const parsed = [];
  for (const chunk of chunks) {
    const match = chunk.match(/^\s*([A-E])(?:\s*[).:-]|\s+)\s*(.*?)\s*$/i);
    if (match) parsed.push({ key: match[1].toUpperCase(), text: match[2] || `Alternativa ${match[1].toUpperCase()}` });
  }
  const unique = new Map(parsed.map(item => [item.key, item]));
  return [...unique.values()];
}

export function parseComposition(text, goal) {
  const normalized = String(text || "").replace(/\s+/g, " ");
  let match = normalized.match(/Bateria\s+montada\s*:\s*(\d+)\s*principais\s*\+\s*(\d+)\s*complementares\s*=\s*(\d+)/i);
  if (match) return { main: Number(match[1]), complementary: Number(match[2]), total: Number(match[3]), source: "notion" };
  match = normalized.match(/Meta\s+do\s+dia\s*:?\s*(\d+)\s*quest[õo]es[\s\S]{0,180}?(\d+)\s*principais\s*\+\s*(\d+)\s*complementares/i);
  if (match) return { total: Number(match[1]), main: Number(match[2]), complementary: Number(match[3]), source: "notion" };
  const total = Math.max(0, Number(goal) || 0);
  const main = Math.round(total * 0.7);
  return { total, main, complementary: total - main, source: "regra-70-30" };
}

export function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function notionRequest(path, { token = process.env.HABA_STUDY_OS_LEITURA, method = "GET", body } = {}) {
  if (!token) throw new Error("O segredo HABA_STUDY_OS_LEITURA não está disponível no workflow.");
  const url = path.startsWith("http") ? path : `${API}${path}`;
  let attempt = 0;
  while (attempt < 6) {
    await paceRequest();
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_API_VERSION, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(45000)
      });
    } catch (error) {
      attempt += 1;
      if (attempt >= 6) throw new Error(`Falha de rede ao consultar o Notion: ${error.message}`);
      await pause(500 * (2 ** attempt));
      continue;
    }
    if (response.ok) return response.json();
    const text = await response.text();
    if (response.status === 429 || response.status >= 500) {
      attempt += 1;
      if (attempt >= 6) throw new Error(`Notion API ${response.status}: ${text.slice(0, 500)}`);
      const retryAfter = Number(response.headers.get("retry-after")) * 1000;
      await pause(retryAfter || 500 * (2 ** attempt));
      continue;
    }
    throw new Error(`Notion API ${response.status}: ${text.slice(0, 700)}`);
  }
  throw new Error("O limite de novas tentativas do Notion foi atingido.");
}

export async function queryDataSource(dataSourceId) {
  const results = [];
  let startCursor;
  do {
    const page = await notionRequest(`/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: { page_size: 100, ...(startCursor ? { start_cursor: startCursor } : {}) }
    });
    results.push(...(page.results || []));
    startCursor = page.has_more ? page.next_cursor : null;
  } while (startCursor);
  return results;
}

export async function getBlocks(blockId) {
  const blocks = [];
  let startCursor;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (startCursor) query.set("start_cursor", startCursor);
    const response = await notionRequest(`/blocks/${blockId}/children?${query.toString()}`);
    for (const raw of response.results || []) {
      const normalized = normalizeBlock(raw);
      if (raw.has_children) normalized.children = await getBlocks(raw.id);
      blocks.push(normalized);
    }
    startCursor = response.has_more ? response.next_cursor : null;
  } while (startCursor);
  return blocks;
}

export async function fetchPageBundle(pageId) {
  const [page, blocks] = await Promise.all([
    notionRequest(`/pages/${pageId}`),
    getBlocks(pageId)
  ]);
  return { pageId: page.id, title: pageTitle(page), updatedAt: page.last_edited_time || "", blocks };
}

export function versionEntity(entity, previous) {
  const { revision: _revision, contentHash: _hash, ...payload } = entity;
  const contentHash = sha256(payload);
  const revision = previous ? (previous.contentHash === contentHash ? previous.revision || 1 : (previous.revision || 1) + 1) : 1;
  return { ...payload, revision, contentHash };
}

export function makeQuestionItem(page, setCode, ordinal) {
  const title = propertyValue(page, "Questão") || pageTitle(page);
  const questionId = propertyValue(page, "ID original") || `notion-${notionId(page.id)}`;
  const answerText = propertyValue(page, "Gabarito");
  const answerKey = answerText.match(/^\s*([A-E])(?:\b|\s|[-—:])/i)?.[1]?.toUpperCase() || "";
  const optionsSummary = propertyValue(page, "Alternativas resumidas");
  const item = {
    questionId,
    occurrenceId: `${setCode}-${String(ordinal).padStart(3, "0")}`,
    ordinal,
    notionPageId: page.id,
    setCode,
    title,
    subject: propertyValue(page, "Disciplina"),
    topic: propertyValue(page, "Assunto"),
    exam: propertyValue(page, "Prova"),
    board: "Cesgranrio",
    year: propertyValue(page, "Ano"),
    stem: propertyValue(page, "Enunciado parafraseado"),
    optionsSummary,
    options: parseOptions(optionsSummary),
    answerText,
    answerKey,
    commentary: propertyValue(page, "Comentário"),
    sourceUrl: propertyValue(page, "URL original"),
    sourceValidated: propertyValue(page, "Fonte validada") === true,
    status: propertyValue(page, "Status"),
    updatedAt: page.last_edited_time || ""
  };
  item.revision = 1;
  item.contentHash = sha256(item);
  return item;
}

export function assertSnapshot(snapshot) {
  const fail = message => { throw new Error(`Validação do snapshot falhou: ${message}`); };
  if (!Array.isArray(snapshot.studyDays) || snapshot.studyDays.length !== 75) fail(`esperados 75 dias; recebidos ${snapshot.studyDays?.length ?? 0}`);
  for (let index = 0; index < 75; index += 1) {
    const day = snapshot.studyDays[index];
    const expected = `D${String(index + 1).padStart(2, "0")}`;
    if (day.code !== expected || Number(day.order) !== index + 1) fail(`sequência de estudo fora de ordem em ${expected}`);
    if (!day.material?.blocks?.length) fail(`${expected} está sem material disponível`);
    if (!day.questionSet?.pageId || !day.questionSet?.items?.length) fail(`${expected} está sem página/bateria de questões`);
    if (day.questionSet.items.length !== Number(day.questionGoal)) fail(`${day.questionSet.code} tem ${day.questionSet.items.length} itens, mas a meta real é ${day.questionGoal}`);
    if (day.questionSet.items.some(item => !item.answerKey || !item.stem)) fail(`${day.questionSet.code} contém item sem enunciado ou gabarito utilizável`);
    if (day.questionSet.items.some(item => !Array.isArray(item.options) || item.options.length < 2 || !item.options.some(option => option.key === item.answerKey))) fail(`${day.questionSet.code} contém questão sem alternativas/gabarito correspondentes`);
    if (new Set(day.questionSet.items.map(item => item.questionId)).size !== day.questionSet.items.length) fail(`${day.questionSet.code} contém IDs originais duplicados`);
    if (day.questionSet.composition.total !== Number(day.questionGoal)) fail(`${day.questionSet.code} tem composição que não fecha com a meta do Notion`);
    if (day.questionSet.composition.main + day.questionSet.composition.complementary !== Number(day.questionGoal)) fail(`${day.questionSet.code} não fecha a divisão principal/complementar`);
  }
  if (snapshot.reviews.length !== 15) fail(`esperadas 15 revisões; recebidas ${snapshot.reviews.length}`);
  if (snapshot.restDays.length !== 15) fail(`esperados 15 domingos de descanso; recebidos ${snapshot.restDays.length}`);
  if (snapshot.cycles.length !== 5 || snapshot.cycles.map(item => item.code).join(",") !== "C01,C02,C03,C04,C05") fail("os ciclos C01–C05 estão incompletos ou fora da sequência");
  if (snapshot.reviews.some(review => !review.blocks?.length)) fail("há uma revisão oficial sem conteúdo acessível");
  if (snapshot.reviews.some((review, index) => review.code !== `R${String(index + 1).padStart(2, "0")}`)) fail("as revisões R01–R15 estão fora da sequência oficial");
  if (snapshot.restDays.some(day => !/^REST-W\d{2}$/.test(day.code))) fail("há dia de descanso sem identificador estável");
  return true;
}
