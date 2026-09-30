export async function loadContent() {
  const response = await fetch("./data/content.json", { cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 404 ? "Ainda não há conteúdo sincronizado do Notion." : `A leitura do conteúdo falhou (${response.status}).`);
  const content = await response.json();
  validateContentSnapshot(content);
  return content;
}

export function validateContentSnapshot(content) {
  const fail = message => { throw new Error(`O snapshot do Notion não passou pela validação local: ${message}.`); };
  if (content?.schemaVersion !== 1) fail("versão de schema incompatível");
  if (!Array.isArray(content.studyDays) || content.studyDays.length !== 75) fail("a trilha não contém exatamente 75 dias");
  if (!Array.isArray(content.reviews) || content.reviews.length !== 15) fail("a trilha não contém exatamente 15 revisões");
  if (!Array.isArray(content.restDays) || content.restDays.length !== 15) fail("a trilha não contém exatamente 15 dias de descanso");
  if (!Array.isArray(content.cycles) || content.cycles.length !== 5) fail("a trilha não contém os cinco ciclos oficiais");
  for (let index = 0; index < content.studyDays.length; index += 1) {
    const day = content.studyDays[index];
    const expected = `D${String(index + 1).padStart(2, "0")}`;
    if (day.code !== expected || Number(day.order) !== index + 1) fail(`ordem inválida em ${expected}`);
    if (!day.material?.pageId || !Array.isArray(day.material.blocks) || !day.material.blocks.length) fail(`${expected} sem material carregado`);
    const set = day.questionSet;
    if (!set?.pageId || !Array.isArray(set.items) || set.items.length !== Number(day.questionGoal)) fail(`${day.code} sem a bateria completa`);
    if (set.items.some(item => !item.questionId || !item.stem || !/^[A-E]$/.test(item.answerKey) || !Array.isArray(item.options) || item.options.length < 2 || !item.options.some(option => option.key === item.answerKey))) fail(`${set.code} contém questão sem chave/alternativas utilizáveis`);
    if (set.composition?.total !== Number(day.questionGoal) || set.composition.main + set.composition.complementary !== set.composition.total) fail(`${set.code} tem composição inconsistente`);
  }
  for (let index = 0; index < content.reviews.length; index += 1) {
    if (content.reviews[index].code !== `R${String(index + 1).padStart(2, "0")}` || !content.reviews[index].blocks?.length) fail(`revisão R${String(index + 1).padStart(2, "0")} ausente`);
  }
  if (content.cycles.map(cycle => cycle.code).join(",") !== "C01,C02,C03,C04,C05") fail("ciclos fora da sequência oficial");
  if (!content.meta?.generatedAt || !content.meta?.contentVersion) fail("metadados de sincronização incompletos");
  return true;
}

export function contentStatus(meta, online = globalThis.navigator?.onLine !== false) {
  if (!online) return { code: "OFFLINE", label: "OFFLINE MODE", className: "tag-amber" };
  if (!meta?.generatedAt) return { code: "ERROR", label: "SEM SNAPSHOT", className: "tag-red" };
  const age = Date.now() - Date.parse(meta.generatedAt);
  if (!Number.isFinite(age)) return { code: "ERROR", label: "DATA INVÁLIDA", className: "tag-red" };
  if (age > 36 * 60 * 60 * 1000) return { code: "STALE", label: "SNAPSHOT ANTIGO", className: "tag-amber" };
  return { code: "SYNCED", label: "CONTEÚDO SINCRONIZADO", className: "tag-green" };
}
