export async function loadContent() {
  const response = await fetch("./data/content.json", { cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 404 ? "Ainda não há conteúdo sincronizado do Notion." : `A leitura do conteúdo falhou (${response.status}).`);
  const content = await response.json();
  validateContentSnapshot(content);
  return content;
}

export function validateContentSnapshot(content) {
  const fail = message => { throw new Error(`O snapshot do Notion não passou pela validação local: ${message}.`); };
  if (content?.schemaVersion !== 2) fail("versão de schema incompatível");
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
    if (!set?.pageId || !Array.isArray(set.items) || !Array.isArray(set.unavailableItems)) fail(`${day.code} sem o registro de disponibilidade da bateria`);
    const goal = Number(day.questionGoal);
    const sourceRows = Number(set.sourceRowCount);
    if (!Number.isInteger(goal) || goal < 0 || !Number.isInteger(sourceRows) || sourceRows < 0) fail(`${set.code} tem contagem inválida`);
    if (set.items.length + set.unavailableItems.length !== sourceRows) fail(`${set.code} não contabiliza todas as linhas da fonte`);
    if (set.missingCount !== Math.max(0, goal - sourceRows) || set.extraCount !== Math.max(0, sourceRows - goal)) fail(`${set.code} tem lacunas de contagem inconsistentes`);
    const expectedStatus = set.items.length === goal && sourceRows === goal && set.unavailableItems.length === 0 ? "complete" : set.items.length ? "partial" : "unavailable";
    if (set.sourceStatus !== expectedStatus || set.availableCount !== set.items.length) fail(`${set.code} tem status de disponibilidade inconsistente`);
    if (set.items.some(item => !item.questionId || !item.stem || !/^[A-E]$/.test(item.answerKey) || item.sourceValidated !== true || item.status !== "Pronta para estudo" || !Array.isArray(item.options) || item.options.length < 2 || !item.options.some(option => option.key === item.answerKey))) fail(`${set.code} contém questão incompleta no player`);
    if (set.composition?.total !== Number(day.questionGoal) || set.composition.main + set.composition.complementary !== set.composition.total) fail(`${set.code} tem composição inconsistente`);
  }
  for (let index = 0; index < content.reviews.length; index += 1) {
    if (content.reviews[index].code !== `R${String(index + 1).padStart(2, "0")}` || !content.reviews[index].blocks?.length) fail(`revisão R${String(index + 1).padStart(2, "0")} ausente`);
  }
  if (content.cycles.map(cycle => cycle.code).join(",") !== "C01,C02,C03,C04,C05") fail("ciclos fora da sequência oficial");
  if (!content.meta?.generatedAt || !content.meta?.contentVersion) fail("metadados de sincronização incompletos");
  const coverage = content.meta.questionCoverage;
  const completeSets = content.studyDays.filter(day => day.questionSet.sourceStatus === "complete").length;
  const partialSets = content.studyDays.filter(day => day.questionSet.sourceStatus === "partial").length;
  const unavailableSets = content.studyDays.filter(day => day.questionSet.sourceStatus === "unavailable").length;
  const usableQuestions = content.studyDays.reduce((sum, day) => sum + day.questionSet.items.length, 0);
  const plannedQuestions = content.studyDays.reduce((sum, day) => sum + Number(day.questionGoal || 0), 0);
  const excludedRows = content.studyDays.reduce((sum, day) => sum + day.questionSet.unavailableItems.length, 0);
  const missingRows = content.studyDays.reduce((sum, day) => sum + day.questionSet.missingCount, 0);
  if (!coverage || coverage.status !== (completeSets === 75 ? "complete" : "partial") || coverage.completeSets !== completeSets || coverage.partialSets !== partialSets || coverage.unavailableSets !== unavailableSets || coverage.totalSets !== 75 || coverage.usableQuestions !== usableQuestions || coverage.plannedQuestions !== plannedQuestions || coverage.excludedRows !== excludedRows || coverage.missingRows !== missingRows) fail("resumo de disponibilidade de questões inconsistente");
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
