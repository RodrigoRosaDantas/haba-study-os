const API = "https://api.notion.com/v1";
const API_VERSION = "2026-03-11";
const MAX_BODY_BYTES = 96 * 1024;
const MAX_OPERATIONS = 10;
const MAX_REMOTE_ROWS = 2_000;
const PAUSE_MS = 360;
let lastNotionRequest = 0;
let notionRequestChain = Promise.resolve();

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function json(value, status, origin = "") {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(origin ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin"
      } : {})
    }
  });
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  let mismatch = a.length ^ b.length;
  const size = Math.max(a.length, b.length);
  for (let index = 0; index < size; index += 1) mismatch |= (a[index % (a.length || 1)] || 0) ^ (b[index % (b.length || 1)] || 0);
  return mismatch === 0;
}

function textProperty(value) {
  const text = String(value ?? "").trim();
  if (!text) return { rich_text: [] };
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += 1_900) chunks.push({ type: "text", text: { content: text.slice(offset, offset + 1_900) } });
  return { rich_text: chunks };
}

function titleProperty(value) {
  const text = String(value || "").trim().slice(0, 180);
  return { title: [{ type: "text", text: { content: text } }] };
}

function normalizedStatus(error) {
  if (error.status === "MASTERED") return "Corrigido";
  if (["UNDER_REVIEW", "STABILIZING"].includes(error.status)) return "Revisar";
  return "Aberto";
}

const REASON_OPTIONS = new Set(["Conteúdo", "Interpretação", "Distração", "Cálculo", "Confusão conceitual", "Chute"]);
const BOARD_OPTIONS = new Set(["Cesgranrio", "Cebraspe", "FGV", "FCC", "IADES", "Outra"]);
const CYCLE_OPTIONS = new Set(["C01", "C02", "C03", "C04", "C05"]);

function errorProperties(error) {
  const questionId = String(error.questionId || "").trim();
  const reasonCategory = REASON_OPTIONS.has(error.reasonCategory) ? error.reasonCategory : "Conteúdo";
  const board = BOARD_OPTIONS.has(error.board) ? error.board : "Cesgranrio";
  const cycle = CYCLE_OPTIONS.has(error.cycle) ? error.cycle : null;
  const observations = [
    error.selected ? `Resposta marcada: ${String(error.selected).slice(0, 5)}` : "",
    error.answerKey ? `Resposta correta: ${String(error.answerKey).slice(0, 5)}` : "",
    error.lastErrorAt ? `Último erro: ${String(error.lastErrorAt).slice(0, 40)}` : "",
    error.reason ? `Motivo: ${String(error.reason).slice(0, 2_000)}` : "",
    error.note ? `Observação: ${String(error.note).slice(0, 2_000)}` : ""
  ].filter(Boolean).join("\n");
  const properties = {
    "Erro": titleProperty(questionId),
    "Matéria": textProperty(error.subject),
    "Assunto": textProperty(error.topic),
    "Banca": { select: { name: board } },
    "Motivo do erro": { select: { name: reasonCategory } },
    "Observações": textProperty(observations),
    "Correção": textProperty(error.mnemonic),
    "Origem": textProperty("HABA Study OS · execução local"),
    "Origem D/R": textProperty([error.dayCode, error.setCode].filter(Boolean).join(" · ")),
    "Status": { status: { name: normalizedStatus(error) } },
    "Reincidência": { number: Math.max(1, Number(error.errorCount) || 1) },
    "Entrar no sábado": { checkbox: Boolean(error.repeated || Number(error.errorCount) > 1) },
    "Revisão alvo": textProperty(error.nextReviewAt || "")
  };
  if (cycle) properties.Ciclo = { select: { name: cycle } };
  if (Number(error.week) > 0) properties.Semana = { number: Number(error.week) };
  if (error.firstErrorAt) properties.Data = { date: { start: new Date(error.firstErrorAt).toISOString() } };
  if (error.lastReviewedAt) properties["Última revisão"] = { date: { start: new Date(error.lastReviewedAt).toISOString() } };
  return properties;
}

function propertyText(page, name) {
  const property = page?.properties?.[name];
  if (!property) return "";
  const value = property[property.type];
  if (property.type === "title" || property.type === "rich_text") return (value || []).map(part => part.plain_text || part.text?.content || "").join("");
  if (property.type === "select" || property.type === "status") return value?.name || "";
  if (property.type === "date") return value?.start || "";
  if (property.type === "number") return value ?? null;
  if (property.type === "checkbox") return Boolean(value);
  return "";
}

function mapRemoteError(page) {
  const title = propertyText(page, "Erro");
  const observations = propertyText(page, "Observações");
  const match = observations.match(/(?:^|\n)Motivo:\s*([^\n]*)(?:\nObservação:\s*([\s\S]*))?/);
  const note = observations.match(/(?:^|\n)Observação:\s*([\s\S]*)/)?.[1];
  const statusValue = propertyText(page, "Status");
  const status = statusValue === "Corrigido" ? "MASTERED" : statusValue === "Revisar" ? "UNDER_REVIEW" : "NEW_ERROR";
  const count = Math.max(1, Number(propertyText(page, "Reincidência")) || 1);
  const origin = propertyText(page, "Origem D/R").split("·").map(value => value.trim());
  const selected = observations.match(/(?:^|\n)Resposta marcada:\s*([A-E])/i)?.[1]?.toUpperCase() || "";
  const answerKey = observations.match(/(?:^|\n)Resposta correta:\s*([A-E])/i)?.[1]?.toUpperCase() || "";
  const lastErrorAt = observations.match(/(?:^|\n)Último erro:\s*([^\n]+)/)?.[1] || page.last_edited_time || propertyText(page, "Data");
  return {
    questionId: title,
    errorId: `ERR-${title}`,
    dayCode: origin.find(value => /^D\d{2}$/.test(value)) || "",
    setCode: origin.find(value => /^Q\d{2}$/.test(value)) || "",
    subject: propertyText(page, "Matéria"),
    topic: propertyText(page, "Assunto"),
    board: propertyText(page, "Banca"),
    reasonCategory: propertyText(page, "Motivo do erro") || "Conteúdo",
    reason: match?.[1] || propertyText(page, "Motivo do erro"),
    note: note || (match ? "" : observations),
    mnemonic: propertyText(page, "Correção"),
    status: status === "MASTERED" ? "MASTERED" : count > 1 ? "REPEATED" : status,
    statusLabel: status === "MASTERED" ? "Consolidado" : count > 1 ? "Reincidente" : statusValue === "Revisar" ? "Em revisão" : "Novo erro",
    selected,
    answerKey,
    errorCount: count,
    repeated: count > 1,
    firstErrorAt: propertyText(page, "Data"),
    lastErrorAt,
    lastReviewedAt: propertyText(page, "Última revisão"),
    nextReviewAt: propertyText(page, "Revisão alvo") || null,
    source: propertyText(page, "Origem") || "Caderno de erros — Notion",
    notionPageId: page.id,
    notionUpdatedAt: page.last_edited_time || "",
    createdAt: page.created_time || "",
    updatedAt: page.last_edited_time || "",
    syncStatus: "SYNCED"
  };
}

async function notionRequest(env, path, method = "GET", body) {
  const pacing = notionRequestChain.then(async () => {
    const wait = Math.max(0, PAUSE_MS - (Date.now() - lastNotionRequest));
    if (wait) await pause(wait);
    lastNotionRequest = Date.now();
  });
  notionRequestChain = pacing.catch(() => {});
  await pacing;
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.HABA_STUDY_OS_NOTION_WRITE}`,
      "Notion-Version": API_VERSION,
      "Content-Type": "application/json"
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 600);
    throw new Error(`Notion API ${response.status}: ${detail}`);
  }
  return response.json();
}

async function existingByQuestionId(env, questionId) {
  const result = await notionRequest(env, `/data_sources/${env.HABA_ERROR_DATA_SOURCE_ID}/query`, "POST", {
    page_size: 2,
    filter: { property: "Erro", title: { equals: questionId } }
  });
  if ((result.results || []).length > 1) throw new Error(`Há títulos duplicados no Caderno de erros para ${questionId}; nenhuma página foi alterada.`);
  return result.results?.[0] || null;
}

async function upsertNotionError(env, error) {
  const existing = await existingByQuestionId(env, error.questionId);
  let candidate = error;
  if (existing) {
    const remote = mapRemoteError(existing);
    const remoteTime = Date.parse(remote.notionUpdatedAt || "") || 0;
    const localTime = Date.parse(error.updatedAt || error.lastErrorAt || "") || 0;
    if (remoteTime > localTime) {
      candidate = {
        ...error,
        errorCount: Math.max(Number(error.errorCount) || 1, Number(remote.errorCount) || 1),
        reasonCategory: remote.reasonCategory,
        reason: remote.reason,
        note: remote.note,
        mnemonic: remote.mnemonic,
        nextReviewAt: remote.nextReviewAt,
        lastReviewedAt: remote.lastReviewedAt,
        status: remote.status,
        updatedAt: remote.notionUpdatedAt
      };
    }
  }
  const properties = errorProperties(candidate);
  if (existing) {
    return notionRequest(env, `/pages/${existing.id}`, "PATCH", { properties });
  }
  return notionRequest(env, "/pages", "POST", {
    parent: { data_source_id: env.HABA_ERROR_DATA_SOURCE_ID },
    properties
  });
}

async function allRemoteErrors(env) {
  const rows = [];
  let cursor;
  do {
    const result = await notionRequest(env, `/data_sources/${env.HABA_ERROR_DATA_SOURCE_ID}/query`, "POST", {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {})
    });
    rows.push(...(result.results || []));
    if (rows.length > MAX_REMOTE_ROWS) throw new Error(`Caderno de erros excede o limite de sincronização (${MAX_REMOTE_ROWS}).`);
    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);
  return rows.map(mapRemoteError).filter(row => row.questionId);
}

async function applyRateLimit(env, request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const id = env.RATE_LIMITER.idFromName(ip);
  const response = await env.RATE_LIMITER.get(id).fetch("https://rate-limit/check");
  return response.status === 429;
}

function validError(error) {
  return error && typeof error === "object"
    && typeof error.questionId === "string" && error.questionId.trim().length > 0 && error.questionId.length <= 120
    && /^[^\u0000-\u001f<>]{1,120}$/.test(error.questionId)
    && typeof error.errorCount === "number" && Number.isFinite(error.errorCount)
    && ["NEW_ERROR", "REPEATED", "UNDER_REVIEW", "STABILIZING", "MASTERED"].includes(error.status);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = Boolean(env.ALLOWED_ORIGIN) && origin === env.ALLOWED_ORIGIN;
    if (!allowed) return json({ error: "origin_not_allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
      "Vary": "Origin"
    } });
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/api/errors/sync") return json({ error: "not_found" }, 404, origin);
    if (!env.HABA_STUDY_OS_SYNC_ACCESS_KEY || !env.HABA_STUDY_OS_NOTION_WRITE || !env.HABA_ERROR_DATA_SOURCE_ID || !env.RATE_LIMITER) {
      return json({ error: "backend_not_configured" }, 503, origin);
    }
    if (await applyRateLimit(env, request)) return json({ error: "rate_limited" }, 429, origin);
    const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
    if (!constantTimeEqual(supplied, env.HABA_STUDY_OS_SYNC_ACCESS_KEY)) return json({ error: "unauthorized" }, 401, origin);
    const declaredLength = Number(request.headers.get("Content-Length") || 0);
    if (declaredLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413, origin);
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413, origin);
    let body;
    try { body = JSON.parse(rawBody); } catch { return json({ error: "invalid_json" }, 400, origin); }
    const operations = body?.operations;
    if (!Array.isArray(operations) || operations.length > MAX_OPERATIONS || operations.some(item => item?.action !== "upsert" || typeof item.operationId !== "string" || !item.operationId || item.operationId.length > 180 || !validError(item.error))) {
      return json({ error: "invalid_operations", limit: MAX_OPERATIONS }, 400, origin);
    }
    const results = [];
    for (const operation of operations) {
      try {
        const page = await upsertNotionError(env, operation.error);
        results.push({ operationId: String(operation.operationId || "").slice(0, 180), status: "SYNCED", notionPageId: page.id, notionUpdatedAt: page.last_edited_time || "" });
      } catch (error) {
        results.push({ operationId: String(operation.operationId || "").slice(0, 180), status: "FAILED", message: error.message });
      }
    }
    let records = [];
    let readWarning = "";
    try { records = await allRemoteErrors(env); }
    catch (error) { readWarning = error.message; }
    return json({ results, records, readWarning, syncedAt: new Date().toISOString() }, results.some(item => item.status === "FAILED") ? 207 : 200, origin);
  }
};

export class RateLimiter {
  constructor(state) { this.state = state; }
  async fetch() {
    const now = Date.now();
    const current = await this.state.storage.get("window");
    const active = current && current.expiresAt > now ? current : { count: 0, expiresAt: now + 60_000 };
    if (active.count >= 60) return new Response("rate limited", { status: 429 });
    active.count += 1;
    await this.state.storage.put("window", active);
    return new Response("ok", { status: 200 });
  }
}
