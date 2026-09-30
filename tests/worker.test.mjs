import test from "node:test";
import assert from "node:assert/strict";
import worker from "../backend/worker.mjs";

const ORIGIN = "https://rodrigorosadantas.github.io";
const ACCESS_KEY = "access-key-for-worker-testing-only-32chars";

function environment() {
  const requests = [];
  const env = {
    ALLOWED_ORIGIN: ORIGIN,
    HABA_STUDY_OS_SYNC_ACCESS_KEY: ACCESS_KEY,
    HABA_STUDY_OS_NOTION_WRITE: "worker-secret-is-never-returned",
    HABA_ERROR_DATA_SOURCE_ID: "7cdc74b5-d395-4286-9337-4b2457771be5",
    RATE_LIMITER: { idFromName: key => key, get: () => ({ fetch: async () => new Response("ok") }) }
  };
  return { env, requests };
}

function request(body, { origin = ORIGIN, token = ACCESS_KEY } = {}) {
  return new Request("https://worker.example/api/errors/sync", {
    method: "POST",
    headers: { Origin: origin, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("worker rejects a non-allowlisted origin before Notion access", async () => {
  const { env } = environment();
  const response = await worker.fetch(request({ operations: [] }, { origin: "https://attacker.example" }), env);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "origin_not_allowed" });
});

test("worker requires the per-user backend access key", async () => {
  const { env } = environment();
  const response = await worker.fetch(request({ operations: [] }, { token: "wrong" }), env);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});

test("worker validates request shape before calling Notion", async () => {
  const { env } = environment();
  const response = await worker.fetch(request({ operations: [{ action: "delete" }] }), env);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_operations", limit: 10 });
});

test("worker upserts an Error by the stable title ID and returns a confirmation", async () => {
  const { env, requests } = environment();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null, headers: options.headers });
    if (String(url).includes("/data_sources/") && options.body) return Response.json({ results: [], has_more: false });
    if (String(url).endsWith("/pages")) return Response.json({ id: "notion-page-id", last_edited_time: "2026-09-30T12:00:00.000Z" });
    throw new Error(`Unexpected Notion URL: ${url}`);
  };
  try {
    const response = await worker.fetch(request({ operations: [{
      operationId: "ERROR-ORIG-123",
      action: "upsert",
      error: { questionId: "ORIG-123", errorCount: 2, status: "REPEATED", subject: "Redes", topic: "TCP/IP", selected: "A", answerKey: "B", firstErrorAt: "2026-09-29T10:00:00.000Z", reasonCategory: "Conteúdo" }
    }] }), env);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.results[0].status, "SYNCED");
    assert.equal(result.results[0].notionPageId, "notion-page-id");
    assert.equal(requests[0].body.filter.property, "Erro");
    assert.equal(requests[1].body.parent.data_source_id, env.HABA_ERROR_DATA_SOURCE_ID);
    assert.equal(requests[1].body.properties.Erro.title[0].text.content, "ORIG-123");
    assert.equal(requests[1].body.properties.Reincidência.number, 2);
    assert.equal(JSON.stringify(result).includes(env.HABA_STUDY_OS_NOTION_WRITE), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("worker preserves a newer Notion note when a stale local queue arrives", async () => {
  const { env, requests } = environment();
  const originalFetch = globalThis.fetch;
  const remotePage = {
    id: "notion-existing-id",
    created_time: "2026-09-20T10:00:00.000Z",
    last_edited_time: "2026-09-30T14:00:00.000Z",
    properties: {
      "Erro": { type: "title", title: [{ plain_text: "ORIG-123" }] },
      "Status": { type: "status", status: { name: "Corrigido" } },
      "Reincidência": { type: "number", number: 1 },
      "Motivo do erro": { type: "select", select: { name: "Interpretação" } },
      "Observações": { type: "rich_text", rich_text: [{ plain_text: "Motivo: confusão de leitura\nObservação: nota mais recente no Notion" }] },
      "Correção": { type: "rich_text", rich_text: [{ plain_text: "macete remoto" }] },
      "Revisão alvo": { type: "rich_text", rich_text: [] },
      "Última revisão": { type: "date", date: { start: "2026-09-29T10:00:00.000Z" } },
      "Origem D/R": { type: "rich_text", rich_text: [{ plain_text: "D01 · Q01" }] },
      "Matéria": { type: "rich_text", rich_text: [{ plain_text: "Redes" }] },
      "Assunto": { type: "rich_text", rich_text: [{ plain_text: "TCP/IP" }] },
      "Banca": { type: "select", select: { name: "Cesgranrio" } },
      "Data": { type: "date", date: { start: "2026-09-20T10:00:00.000Z" } }
    }
  };
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url: String(url), method, body });
    if (String(url).includes("/data_sources/") && body?.filter) return Response.json({ results: [remotePage], has_more: false });
    if (String(url).endsWith("/pages/notion-existing-id")) return Response.json({ ...remotePage, last_edited_time: "2026-09-30T15:00:00.000Z" });
    if (String(url).includes("/data_sources/") && body) return Response.json({ results: [], has_more: false });
    throw new Error(`Unexpected Notion URL: ${url}`);
  };
  try {
    const response = await worker.fetch(request({ operations: [{
      operationId: "ERROR-ORIG-123", action: "upsert",
      error: { questionId: "ORIG-123", status: "REPEATED", errorCount: 2, updatedAt: "2026-09-30T11:00:00.000Z", reason: "local older text", note: "local stale note", mnemonic: "old", subject: "Redes", topic: "TCP/IP" }
    }] }), env);
    assert.equal(response.status, 200);
    const patchRequest = requests.find(item => item.method === "PATCH");
    assert.equal(patchRequest.body.properties.Status.status.name, "Corrigido");
    const observations = patchRequest.body.properties.Observações.rich_text.map(part => part.text.content).join("");
    assert.match(observations, /nota mais recente no Notion/);
    assert.doesNotMatch(observations, /local stale note/);
    assert.equal(patchRequest.body.properties.Correção.rich_text[0].text.content, "macete remoto");
  } finally { globalThis.fetch = originalFetch; }
});
