import { loadContent, contentStatus } from "./content.js";
import { readPreferences, savePreferences } from "./preferences.js";
import { downloadBackup, restoreBackupText } from "./backup.js";
import { escapeHtml, formatDate, formatDuration, renderBlocks, safeUrl, setLoadingError, toast } from "./ui.js";
import {
  getAllRecords, getRecord, putRecord, deleteRecord, updateErrorRecord
} from "./storage.js";
import {
  buildMentorAdvice, calculateAnalytics, getNextMission, scoreQuestionSet, upsertError
} from "./core.js";
import { deferFailedOperation, isQueueItemDue, isSameSyncOperation, millisecondsUntilQueueDue } from "./sync-queue.js";

const root = document.getElementById("view-root");
const state = { content: null, route: "today", parameter: "", questionIndex: null, currentDay: null, currentAttempt: null, preferences: readPreferences(), activeSession: null, timer: null, error: null };
let deferredInstallPrompt = null;
let readingSaveTimer = null;
let errorSyncTimer = null;
let errorSyncPromise = null;
let errorSyncScheduleGeneration = 0;
let questionStartedAt = Date.now();
const byId = id => document.getElementById(id);
const e = value => escapeHtml(value ?? "");
const localDateValue = value => value ? new Date(value).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace(" ", "T").slice(0, 16) : "";
const progressWidthClass = value => `progress-width-${Math.round(Math.max(0, Math.min(100, Number(value) || 0)) / 5) * 5}`;
const missionDays = () => state.content?.studyDays || [];
const missionReviews = () => state.content?.reviews || [];

function routeFromHash() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  return { route: parts[0] || "today", parameter: parts[1] || "", questionIndex: parts[2] === undefined ? null : Number(parts[2]) };
}

function readSyncConfig() {
  try {
    const value = JSON.parse(sessionStorage.getItem("haba:sync-config") || "{}");
    return { endpoint: typeof value.endpoint === "string" ? value.endpoint : "", token: typeof value.token === "string" ? value.token : "" };
  } catch { return { endpoint: "", token: "" }; }
}

function normalizeSyncEndpoint(endpoint) {
  const parsed = new URL(endpoint);
  const localDevelopment = ["localhost", "127.0.0.1"].includes(parsed.hostname) && location.hostname === parsed.hostname;
  if (parsed.protocol !== "https:" && !(localDevelopment && parsed.protocol === "http:")) throw new Error("O endpoint deve usar HTTPS.");
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw new Error("Informe somente a URL base do Worker, sem credenciais, parâmetros ou caminho.");
  return parsed.href.replace(/\/+$/, "");
}

function saveSyncConfig(endpoint, token) {
  const normalizedEndpoint = normalizeSyncEndpoint(endpoint);
  if (!token || token.length < 24) throw new Error("A chave de acesso do backend precisa ter pelo menos 24 caracteres.");
  sessionStorage.setItem("haba:sync-config", JSON.stringify({ endpoint: normalizedEndpoint, token }));
}

function openRoute(route, parameter = "") {
  location.hash = parameter ? `#${route}/${encodeURIComponent(parameter)}` : `#${route}`;
}

function currentMission(progress = []) {
  return getNextMission(missionDays(), missionReviews(), progress);
}

function updateShell(progress = [], errors = []) {
  const mission = currentMission(progress);
  const cycle = mission.day?.cycle || mission.review?.cycle || missionDays()[0]?.cycle || "—";
  const cycleNode = byId("top-cycle");
  if (cycleNode) cycleNode.textContent = `CICLO ${cycle}`;
  const count = byId("error-count");
  if (count) count.textContent = String(errors.filter(error => error.status !== "MASTERED").length);
  const network = byId("network-status");
  if (network) {
    const online = navigator.onLine !== false;
    network.classList.toggle("is-offline", !online);
    network.lastElementChild.textContent = online ? "ONLINE" : "OFFLINE";
  }
  document.body.classList.toggle("focus-mode", Boolean(state.preferences.focusMode));
  document.body.classList.toggle("large-type", state.preferences.fontSize === "large");
  document.documentElement.dataset.theme = state.preferences.theme || "dark";
  document.documentElement.classList.toggle("reader-width-narrow", state.preferences.readerWidth === "narrow");
  for (const item of document.querySelectorAll("[data-route]")) {
    const target = item.dataset.route;
    item.classList.toggle("is-active", target === state.route || (state.route === "more" && target === "settings"));
  }
}

function heading(kicker, title, subtitle = "", action = "") {
  return `<header class="page-heading"><div><div class="eyebrow">${e(kicker)}</div><h1>${e(title)}</h1>${subtitle ? `<p>${e(subtitle)}</p>` : ""}</div>${action ? `<div class="heading-action">${action}</div>` : ""}</header>`;
}

function emptyState(title, text, link = "") {
  return `<div class="empty-state"><div class="empty-icon">◎</div><h2>${e(title)}</h2><p>${e(text)}</p>${link}</div>`;
}

function metric(label, value, note, icon = "◈") {
  return `<article class="metric-card"><div class="metric-top"><span>${e(label)}</span><span class="metric-icon">${icon}</span></div><div class="metric-value">${e(value)}</div><div class="metric-foot">${e(note)}</div></article>`;
}

function completionRatio(code, progress) {
  const row = progress.find(item => item.id === code);
  return row?.completedAt ? 100 : 0;
}

function getDay(code) { return missionDays().find(day => day.code === code); }
function dayForQuestion(code) { return missionDays().find(day => day.questionSet.code === code); }

function questionCoverageNotice(day) {
  const set = day?.questionSet;
  if (!set || set.sourceStatus === "complete") return "";
  const reasonLabels = {
    missing_id: "ID original ausente",
    missing_stem: "enunciado parafraseado ausente",
    missing_answer_key: "gabarito ausente",
    unusable_options: "alternativas ausentes ou incompatíveis com o gabarito",
    source_not_validated: "fonte ainda não validada",
    status_not_ready: "registro ainda não está pronto para estudo"
  };
  const links = (set.unavailableItems || []).map(item => {
    const id = String(item.notionPageId || "").replaceAll("-", "");
    const label = e(item.questionId || "registro sem ID");
    const link = /^[0-9a-f]{32}$/i.test(id) ? `<a href="https://www.notion.so/${e(id)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    const reasons = (item.reasons || []).map(reason => reasonLabels[reason] || reasonLabels.missing_answer_key).join("; ");
    return `<li>${link}: ${e(reasons)}</li>`;
  }).join("");
  const pageId = String(set.pageId || "").replaceAll("-", "");
  const notionLink = /^[0-9a-f]{32}$/i.test(pageId) ? `<a href="https://www.notion.so/${e(pageId)}" target="_blank" rel="noopener noreferrer">Abrir ${e(set.code)} no Notion ↗</a>` : "";
  const missing = Number(set.missingCount || 0);
  const excluded = (set.unavailableItems || []).length;
  return `<div class="notice notice-warning" role="status"><strong>${e(set.availableCount || 0)}/${e(day.questionGoal)} questões utilizáveis</strong><p>A interface só inclui registros com enunciado, alternativas, gabarito e fonte validados. O conteúdo ausente permanece sinalizado; nenhuma questão foi inventada.${missing ? ` ${missing} linha(s) planejada(s) ainda não estão mapeadas na fonte.` : ""}</p>${excluded ? `<details><summary>${excluded} registro(s) fora do player</summary><ul>${links}</ul></details>` : ""}${notionLink ? `<p>${notionLink}</p>` : ""}</div>`;
}

function questionCoverageSummary(meta) {
  const coverage = meta?.questionCoverage;
  if (!coverage || coverage.status === "complete") return "";
  const sourceUrl = safeUrl(meta.sourceRootUrl);
  return `<section class="notice notice-warning" role="status"><strong>Disponibilidade editorial de questões: parcial</strong><p>${e(coverage.completeSets)}/${e(coverage.totalSets)} baterias completas · ${e(coverage.usableQuestions)}/${e(coverage.plannedQuestions)} questões utilizáveis · ${e(coverage.excludedRows)} registros incompletos excluídos · ${e(coverage.missingRows)} sem mapeamento oficial.</p><p>Materiais, sequência, revisões e questões válidas continuam disponíveis. As lacunas aparecem em cada Qxx.</p>${sourceUrl ? `<a href="${e(sourceUrl)}" target="_blank" rel="noopener noreferrer">Abrir a fonte editorial no Notion ↗</a>` : ""}</section>`;
}

function blockHost(blocks, className = "reader-document") {
  const host = document.createElement("div");
  host.className = className;
  renderBlocks(blocks || [], host);
  return host.innerHTML;
}

function moduleCard(day, progress) {
  const complete = completionRatio(day.code, progress) === 100;
  const questionProgress = progress.find(item => item.id === day.questionSet.code);
  const answered = questionProgress?.completedAt;
  const questionMark = answered ? (questionProgress.coverageStatus === "partial" ? "Q ~" : "Q ✓") : e(day.questionSet.code);
  return `<button class="module-card" type="button" data-route="study" data-parameter="${e(day.code)}">
    <span class="module-code">${e(day.code)}</span><span class="module-copy"><strong>${e(day.title.replace(/^D\d{2}\s*[—–-]\s*/, ""))}</strong><small>${e(day.focus)} · ${e(day.weekday)}</small></span>
    <span class="module-trailing"><span class="tag ${complete ? "tag-green" : "tag-cyan"}">${complete ? "LIDO" : "ABRIR"}</span><span class="mono">${questionMark}</span></span>
  </button>`;
}

async function renderToday(progress, errors, attempts, sessions) {
  const mission = currentMission(progress);
  const analytics = calculateAnalytics(attempts, await getAllRecords("question_answers"), sessions, missionDays(), progress);
  const status = contentStatus(state.content.meta);
  const statusLine = `<span class="tag ${status.className}">${e(status.label)}</span><span class="tiny">Gerado ${e(formatDate(state.content.meta.generatedAt, true))} · fonte ${e(formatDate(state.content.meta.sourceUpdatedAt))}</span>`;
  let missionBody;
  if (mission.type === "study") {
    const day = mission.day;
    missionBody = `<div class="hero-topline"><span class="mission-chip">${e(day.cycle)} · SEMANA ${String(day.week).padStart(2, "0")}</span><span class="mission-chip">MISSÃO ${e(day.code)}</span></div>
      <h1 class="hero-title">${e(day.code)} <span>·</span> ${e(day.focus)}</h1><p class="hero-subtitle">${e(day.complementary)} · meta de ${e(day.questionGoal)} questões em ${e(day.questionSet.composition.main)} principais + ${e(day.questionSet.composition.complementary)} complementares; ${e(day.questionSet.items.length)} utilizáveis nesta sincronização.</p>
      <div class="hero-actions"><button class="button button-primary" data-route="study" data-parameter="${e(day.code)}">Abrir material <span aria-hidden="true">→</span></button><button class="button button-quiet" data-route="questions" data-parameter="${e(day.questionSet.code)}">Ir às questões</button></div>`;
  } else if (mission.type === "questions") {
    missionBody = `<div class="hero-topline"><span class="mission-chip">${e(mission.day.cycle)} · ${e(mission.day.code)} CONCLUÍDO</span><span class="mission-chip">BATERIA ${e(mission.code)}</span></div><h1 class="hero-title">Material fechado.<br><span>Agora é hora de praticar.</span></h1><p class="hero-subtitle">${e(mission.day.questionSet.items.length)} de ${e(mission.day.questionGoal)} questões utilizáveis em ${e(mission.day.code)}. O histórico fica salvo neste dispositivo.</p><div class="hero-actions"><button class="button button-primary" data-route="questions" data-parameter="${e(mission.code)}">Abrir ${e(mission.code)} →</button></div>`;
  } else if (mission.type === "review") {
    missionBody = `<div class="hero-topline"><span class="mission-chip">SEMANA ${String(mission.review.week).padStart(2, "0")}</span><span class="mission-chip">REVISÃO OFICIAL</span></div><h1 class="hero-title">${e(mission.code)} <span>·</span> Revisão de sábado</h1><p class="hero-subtitle">${e(mission.review.focus || mission.review.title)}. O ciclo continua pela sequência pedagógica, sem pular dias.</p><div class="hero-actions"><button class="button button-primary" data-route="reviews" data-parameter="${e(mission.code)}">Abrir revisão →</button></div>`;
  } else {
    missionBody = `<div class="hero-topline"><span class="mission-chip">TRILHA CONCLUÍDA</span></div><h1 class="hero-title">75 dias concluídos.<br><span>Use as revisões e o histórico.</span></h1><p class="hero-subtitle">A trilha oficial terminou. Seu progresso e os registros deste dispositivo continuam disponíveis.</p><div class="hero-actions"><button class="button button-primary" data-route="reviews">Abrir Revision Engine</button></div>`;
  }
  const lastSync = state.content.meta.generatedAt ? formatDate(state.content.meta.generatedAt, true) : "Sem sincronização";
  root.innerHTML = `<div class="page-wrap">
    <section class="hero-grid"><div class="hero-panel"><div class="hero-content">${missionBody}</div></div><aside class="hero-side">
      <div class="panel"><div class="panel-kicker">STATUS DE CONTEÚDO</div><div class="sync-line">${statusLine}</div><div class="sync-line"><span class="tiny">Última sincronização</span><strong>${e(lastSync)}</strong></div><a class="inline-link" href="https://github.com/RodrigoRosaDantas/haba-study-os/actions/workflows/sync-notion.yml" target="_blank" rel="noopener noreferrer">Atualizar conteúdo no GitHub ↗</a></div>
      <div class="panel"><div class="panel-kicker">SESSÃO DE ESTUDO</div>${state.activeSession ? `<p class="session-running"><span class="live-dot"></span> <span class="session-clock" data-session-started="${e(state.activeSession.startedAt)}">${e(formatDuration(Math.floor((Date.now() - Date.parse(state.activeSession.startedAt)) / 1000)))}</span> · ${e(state.activeSession.dayCode || "Estudo livre")}</p><button class="button button-danger button-small" data-action="stop-session">Encerrar sessão</button>` : `<p class="muted">O tempo só conta depois de iniciar uma sessão.</p><button class="button button-primary button-small" data-action="start-session" data-day="${e(mission.day?.code || "")}">Iniciar sessão</button>`}</div>
    </aside></section>
    ${questionCoverageSummary(state.content.meta)}
    <section class="metric-grid">${metric("QUESTÕES", analytics.questionCount || "—", analytics.questionCount ? `${analytics.correct} acertos · ${analytics.incorrect} erros` : "Sem respostas registradas", "⌘")}${metric("PRECISÃO", analytics.accuracy == null ? "—" : `${analytics.accuracy}%`, analytics.accuracy == null ? "Aguardando respostas" : `${analytics.sampleSize} respostas`, "◎")}${metric("TEMPO REAL", analytics.studyMinutes ? `${analytics.studyHours} h` : "—", analytics.studyMinutes ? `${analytics.studyMinutes} min registrados` : "Sem sessões concluídas", "◷")}${metric("TRILHA", `${analytics.completedDays}/75`, `${analytics.completedQuestionSets} baterias completas · ${analytics.partialQuestionSets} parciais`, "▤")}</section>
    <div class="two-column"><section><div class="section-head"><div><div class="eyebrow">SEQUÊNCIA EDITORIAL</div><h2>Próximas unidades</h2></div><button class="button button-quiet button-small" data-route="study">Ver trilha</button></div><div class="module-list">${missionDays().filter(day => day.order >= (mission.day?.order || missionDays()[0]?.order || 1)).slice(0, 4).map(day => moduleCard(day, progress)).join("")}</div></section>
    <aside class="panel"><div class="panel-kicker">PENDÊNCIAS LOCAIS</div><div class="task-list"><button class="task-row" data-route="errors"><span class="task-icon">⌁</span><span class="task-copy"><strong>${errors.filter(error => error.status !== "MASTERED").length} erros para revisar</strong><small>Salvos neste dispositivo</small></span><span class="task-time">Abrir →</span></button><button class="task-row" data-route="reviews"><span class="task-icon">⟳</span><span class="task-copy"><strong>Revisões R01–R15</strong><small>Conforme a trilha oficial</small></span><span class="task-time">Abrir →</span></button></div></aside></div>
  </div>`;
}

async function renderStudy(progress) {
  const code = state.parameter.startsWith("D") ? state.parameter : currentMission(progress).day?.code || missionDays().find(day => !progress.some(item => item.id === day.code && item.completedAt))?.code;
  const day = getDay(code);
  if (!day) {
    root.innerHTML = `<div class="page-wrap">${heading("STUDY ENGINE", "Trilha oficial", "75 unidades na ordem editorial do Notion.") }<div class="module-list">${missionDays().map(item => moduleCard(item, progress)).join("")}</div></div>`;
    return;
  }
  state.currentDay = day;
  const pageId = day.material.pageId;
  const resume = await getRecord("reading_progress", pageId);
  const done = progress.find(item => item.id === day.code)?.completedAt;
  const percent = Math.min(100, Math.max(0, Math.round(Number(resume?.scrollRatio || 0) * 100)));
  root.innerHTML = `<div class="page-wrap">${heading(`${day.cycle} · SEMANA ${String(day.week).padStart(2, "0")}`, day.code, `${day.focus} · complementar: ${day.complementary}`, `<button class="button button-quiet button-small" data-route="questions" data-parameter="${e(day.questionSet.code)}">Abrir ${e(day.questionSet.code)} →</button>`)}
      <div class="reader-layout"><article class="reader-main"><div class="reader-toolbar"><div class="reader-toolbar-group"><span class="tag tag-cyan">MATERIAL DO NOTION</span><span class="tiny">Rev. ${e(day.revision)} · ${e(formatDate(day.material.updatedAt))}</span></div><div class="reader-toolbar-group">${state.activeSession ? `<span class="tag tag-green">SESSÃO <span class="session-clock" data-session-started="${e(state.activeSession.startedAt)}">${e(formatDuration(Math.floor((Date.now() - Date.parse(state.activeSession.startedAt)) / 1000)))}</span></span>` : `<button class="button button-quiet button-small" data-action="start-session" data-day="${e(day.code)}">Iniciar sessão</button>`}</div></div>
      ${resume?.scrollY > 100 ? `<button class="resume-reading" data-action="resume-reading" data-scroll="${e(resume.scrollY)}">Continuar de onde parei <span>${percent}%</span></button>` : ""}
      <div class="reader-document" id="reader-document" data-reader-page="${e(pageId)}">${blockHost(day.material.blocks)}</div>
      <div class="study-complete-row"><button class="button ${done ? "button-quiet" : "button-primary"}" data-action="complete-day" data-day="${e(day.code)}">${done ? "Unidade concluída ✓" : "Concluir unidade"}</button><span class="tiny">Leitura retomável · posição salva localmente</span></div>
    </article><aside class="reader-aside"><div class="panel"><h3>PROGRESSO DE LEITURA</h3><div class="reader-progress"><span>${percent}% lido</span><span>${done ? "Concluído" : "Em andamento"}</span></div><div class="progress-track"><span class="progress-fill ${progressWidthClass(percent)}"></span></div><p>O progresso da leitura é salvo neste navegador. Iniciar uma sessão registra o tempo de estudo explicitamente.</p></div><div class="panel"><h3>OBJETIVO DO DIA</h3><p><strong>${e(day.focus)}</strong></p><p>Complementar: ${e(day.complementary)}</p><p>Meta ${e(day.questionGoal)} · ${e(day.questionSet.items.length)} questões utilizáveis · ${e(day.questionSet.composition.main)} principais + ${e(day.questionSet.composition.complementary)} complementares.</p><button class="button button-primary button-small" data-route="questions" data-parameter="${e(day.questionSet.code)}">Abrir ${e(day.questionSet.code)}</button>${questionCoverageNotice(day)}</div><div class="panel"><h3>FONTE EDITORIAL</h3><p>${e(day.material.title)}</p><a href="https://www.notion.so/${e(pageId.replaceAll("-", ""))}" target="_blank" rel="noopener noreferrer">Abrir no Notion ↗</a></div></aside></div></div>`;
  scheduleReadingSave();
}

async function getAttemptAndAnswers(day) {
  const key = `active-attempt:${day.questionSet.code}`;
  const pointer = await getRecord("progress", key);
  if (pointer?.attemptId) {
    const attempt = await getRecord("question_attempts", pointer.attemptId);
    if (attempt && !attempt.completedAt) return { attempt, answers: (await getAllRecords("question_answers")).filter(row => row.attemptId === attempt.attemptId) };
  }
  const completed = (await getAllRecords("question_attempts"))
    .filter(row => row.questionSet === day.questionSet.code && row.completedAt)
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))[0];
  if (completed) return { attempt: completed, answers: (await getAllRecords("question_answers")).filter(row => row.attemptId === completed.attemptId) };
  const attempts = (await getAllRecords("question_attempts")).filter(row => row.questionSet === day.questionSet.code);
  const attemptNumber = attempts.length + 1;
  const attemptId = `${day.questionSet.code}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const attempt = { attemptId, questionSet: day.questionSet.code, dayCode: day.code, attemptNumber, startedAt: new Date().toISOString(), completedAt: null, questionVersion: day.questionSet.contentHash || "", availableQuestionCount: day.questionSet.items.length, plannedQuestionCount: day.questionGoal, coverageStatus: day.questionSet.sourceStatus, status: "IN_PROGRESS" };
  await putRecord("question_attempts", attempt);
  await putRecord("progress", { id: key, attemptId, updatedAt: attempt.startedAt });
  return { attempt, answers: [] };
}

function resultByField(items, answers, key) {
  const map = new Map();
  for (const item of items) {
    const answer = answers.find(row => row.questionId === item.questionId);
    if (!answer) continue;
    const name = item[key] || "Sem classificação";
    const row = map.get(name) || { name, total: 0, correct: 0 };
    row.total += 1;
    if (answer.isCorrect) row.correct += 1;
    map.set(name, row);
  }
  return [...map.values()].map(row => ({ ...row, accuracy: Math.round(row.correct / row.total * 100) }));
}

async function renderQuestions(progress = []) {
  const code = state.parameter.startsWith("Q") ? state.parameter : currentMission(progress).day?.questionSet.code || missionDays().find(day => !progress.some(item => item.id === day.questionSet.code && item.completedAt))?.questionSet.code;
  const day = dayForQuestion(code);
  if (!day) {
    root.innerHTML = `<div class="page-wrap">${heading("QUESTION ENGINE", "Questões oficiais", "As baterias são carregadas das páginas vinculadas ao Dxx.")}${questionCoverageSummary(state.content.meta)}<div class="module-list">${missionDays().map(item => `<button class="module-card" data-route="questions" data-parameter="${e(item.questionSet.code)}"><span class="module-code">${e(item.questionSet.code)}</span><span class="module-copy"><strong>${e(item.focus)}</strong><small>${e(item.questionSet.items.length)}/${e(item.questionGoal)} questões utilizáveis · vinculada a ${e(item.code)}</small></span><span class="module-trailing"><span class="tag ${item.questionSet.sourceStatus === "complete" ? "tag-green" : "tag-amber"}">${item.questionSet.sourceStatus === "complete" ? "COMPLETA" : item.questionSet.sourceStatus === "partial" ? "PARCIAL" : "INDISPONÍVEL"}</span></span></button>`).join("")}</div></div>`;
    return;
  }
  const set = day.questionSet;
  if (!set.items?.length) {
    root.innerHTML = `<div class="page-wrap">${heading("QUESTION ENGINE", code, day.focus)}${questionCoverageNotice(day)}${emptyState("Nenhuma questão utilizável", "A fonte oficial ainda não tem questões completas para esta bateria.")}</div>`;
    return;
  }
  const session = await getAttemptAndAnswers(day);
  state.currentDay = day;
  state.currentAttempt = session.attempt;
  const answeredMap = Object.fromEntries(session.answers.map(answer => [answer.questionId, answer.selected]));
  const completed = session.attempt.completedAt;
  if (completed) {
    const score = session.attempt.score || scoreQuestionSet(set.items, answeredMap);
    const subjects = resultByField(set.items, session.answers, "subject");
    const topics = resultByField(set.items, session.answers, "topic");
    root.innerHTML = `<div class="page-wrap">${heading(`${day.code} · ${day.cycle}`, `${code} · Resultado`, `${session.attempt.attemptNumber}ª tentativa · ${e(formatDate(session.attempt.completedAt, true))}`)}${questionCoverageNotice(day)}
      <section class="result-banner"><div class="result-score">${score.accuracy == null ? "—" : `${score.accuracy}%`}</div><p>${score.correct} acertos · ${score.incorrect} erros · ${score.unanswered} sem resposta · ${score.total} questões</p></section>
      <div class="result-grid"><div><span class="tiny">ACERTOS</span><strong>${score.correct}</strong></div><div><span class="tiny">ERROS</span><strong>${score.incorrect}</strong></div><div><span class="tiny">TEMPO</span><strong>${e(formatDuration(session.attempt.durationSeconds || 0))}</strong></div></div>
      <div class="two-column"><section class="panel"><h2>Por matéria</h2>${subjects.length ? subjects.map(item => `<div class="result-breakdown"><span>${e(item.name)}</span><span>${item.correct}/${item.total} · ${item.accuracy}%</span></div>`).join("") : `<p class="muted">Sem respostas para analisar.</p>`}</section><section class="panel"><h2>Por assunto</h2>${topics.length ? topics.map(item => `<div class="result-breakdown"><span>${e(item.name)}</span><span>${item.correct}/${item.total} · ${item.accuracy}%</span></div>`).join("") : `<p class="muted">Sem respostas para analisar.</p>`}</section></div>
      <div class="hero-actions"><button class="button button-primary" data-action="retry-set" data-set="${e(code)}">Iniciar nova tentativa</button><button class="button button-quiet" data-route="errors">Ver Error Lab</button><button class="button button-quiet" data-route="study" data-parameter="${e(day.code)}">Voltar ao material</button></div></div>`;
    return;
  }
  const answered = new Set(session.answers.map(answer => answer.questionId));
  const firstUnanswered = set.items.findIndex(item => !answered.has(item.questionId));
  let index = Number(state.questionIndex);
  if (state.questionIndex === null || !Number.isFinite(index) || index < 0 || index >= set.items.length) index = firstUnanswered >= 0 ? firstUnanswered : 0;
  const item = set.items[index];
  const answer = session.answers.find(row => row.questionId === item.questionId);
  const duration = Math.max(0, Math.floor((Date.now() - Date.parse(session.attempt.startedAt)) / 1000));
  root.innerHTML = `<div class="page-wrap">${heading(`${day.code} · ${day.cycle}`, code, `${day.focus} + ${day.complementary}`, `<button class="button button-quiet button-small" data-route="study" data-parameter="${e(day.code)}">Voltar ao material</button>`)}
    ${questionCoverageNotice(day)}<section class="question-shell"><div class="question-head"><span class="question-counter">QUESTÃO ${String(index + 1).padStart(2, "0")} / ${String(set.items.length).padStart(2, "0")}</span><span class="tag tag-cyan">${answered.size}/${set.items.length} respondidas</span><span class="tag">${e(formatDuration(duration))}</span></div>
      <article class="question-card"><div class="question-context"><span class="tag tag-cyan">${e(item.board || "Cesgranrio")}</span><span class="tag">${e(item.subject || "Matéria não classificada")}</span><span class="tag">${e(item.topic || "Assunto não classificado")}</span>${item.year ? `<span class="tag">${e(item.year)}</span>` : ""}</div>
        <div class="question-stem">${e(item.stem || item.title)}</div>
        <div class="question-note">Enunciado parafraseado para estudo; consulte a fonte original para a redação integral. ${safeUrl(item.sourceUrl) ? `<a href="${e(safeUrl(item.sourceUrl))}" target="_blank" rel="noopener noreferrer">Fonte da questão ↗</a>` : ""}</div>
        <div class="answer-list">${(item.options || []).map(option => `<button type="button" class="answer-option ${answer?.selected === option.key ? "is-selected" : ""}" data-action="select-answer" data-question="${e(item.questionId)}" data-option="${e(option.key)}" aria-pressed="${answer?.selected === option.key}"><span class="answer-letter">${e(option.key)}</span><span>${e(option.text)}</span></button>`).join("") || `<p class="muted">As alternativas resumidas não puderam ser separadas. Consulte a fonte original para responder.</p>`}</div>
        ${answer ? `<div class="${answer.isCorrect ? "notice notice-success" : "notice notice-warning"}"><strong>${answer.isCorrect ? "Resposta correta" : `Resposta incorreta · gabarito ${e(item.answerKey)}`}</strong><p>${e(item.commentary || item.answerText || "Confira o comentário editorial disponível na fonte vinculada.")}</p></div>` : ""}
        <div class="question-actions"><button class="button button-quiet" data-action="previous-question" data-index="${index}" ${index === 0 ? "disabled" : ""}>← Anterior</button>${index === set.items.length - 1 ? `<button class="button button-primary" data-action="finish-set" data-set="${e(code)}">Finalizar bateria</button>` : `<button class="button button-primary" data-action="next-question" data-index="${index}">Próxima questão →</button>`}</div>
      </article><p class="tiny question-footnote">Tentativa ${session.attempt.attemptNumber} · versão editorial ${e(session.attempt.questionVersion.slice(0, 10) || "indisponível")} · respostas salvas localmente.</p></section></div>`;
  questionStartedAt = Date.now();
}

async function renderReviews(progress, errors) {
  const code = state.parameter.startsWith("R") ? state.parameter : "";
  if (code) {
    const review = missionReviews().find(item => item.code === code);
    if (!review) { root.innerHTML = `<div class="page-wrap">${heading("REVISION ENGINE", code)}${emptyState("Revisão indisponível", "Não foi encontrada no snapshot oficial.")}</div>`; return; }
    const done = progress.find(item => item.id === code)?.completedAt;
    root.innerHTML = `<div class="page-wrap">${heading(`SEMANA ${String(review.week).padStart(2, "0")} · ${review.cycle}`, `${review.code} · Revisão oficial`, review.focus || review.title, `<button class="button button-quiet button-small" data-route="reviews">Todas as revisões</button>`)}<div class="reader-layout"><article class="reader-document panel">${blockHost(review.blocks)}</article><aside class="reader-aside"><div class="panel"><h3>FOCO</h3><p>${e(review.focus)}</p><p>${e(review.complementary)}</p><p>Questões planejadas: ${e(review.questionsGoal || "—")}</p></div><div class="panel"><h3>COBERTURA ACUMULADA</h3><p>${e(review.cumulativeCoverage || "Conforme a página oficial no Notion.")}</p><button class="button ${done ? "button-quiet" : "button-primary"}" data-action="complete-review" data-review="${e(code)}">${done ? "Revisão registrada ✓" : "Registrar revisão concluída"}</button></div><div class="panel"><h3>ERROS PESSOAIS</h3><p>${errors.filter(error => error.status !== "MASTERED").length} erros locais aguardam revisão.</p><button class="button button-quiet button-small" data-route="errors">Abrir Error Lab →</button></div></aside></div></div>`;
    return;
  }
  const cards = missionReviews().map(review => {
    const done = progress.some(item => item.id === review.code && item.completedAt);
    return `<article class="review-card"><span class="tag ${done ? "tag-green" : "tag-cyan"}">${e(review.code)} · ${done ? "CONCLUÍDA" : `SEMANA ${String(review.week).padStart(2, "0")}`}</span><h3>${e(review.focus || review.title)}</h3><p>${e(review.cumulativeCoverage || review.complementary || "Revisão semanal oficial.")}</p><button class="button button-quiet button-small" data-route="reviews" data-parameter="${e(review.code)}">Abrir revisão →</button></article>`;
  }).join("");
  const currentErrors = errors.filter(error => error.status !== "MASTERED").sort((a, b) => Date.parse(a.nextReviewAt || a.lastErrorAt) - Date.parse(b.nextReviewAt || b.lastErrorAt));
  root.innerHTML = `<div class="page-wrap">${heading("REVISION ENGINE", "Revisões oficiais + erros", "R01–R15 mantidas na sequência do Notion. Erros e reincidências continuam locais.")}<div class="review-calendar">${cards}</div><section class="panel revision-error-panel"><div class="section-head"><div><div class="eyebrow">ERROR LAB</div><h2>Erros para revisar</h2></div><button class="button button-quiet button-small" data-route="errors">Abrir caderno</button></div>${currentErrors.length ? currentErrors.slice(0, 8).map(error => `<div class="result-breakdown"><span>${e(error.questionId)} · ${e(error.topic || error.subject)}</span><span>${e(error.statusLabel || error.status)} <button class="inline-button" data-action="review-error" data-id="${e(error.questionId)}">Marcar em revisão</button></span></div>`).join("") : `<p class="muted">Nenhum erro local pendente.</p>`}</section></div>`;
}

function errorCard(error, queueItem = null) {
  const statuses = ["NEW_ERROR", "REPEATED", "UNDER_REVIEW", "STABILIZING", "MASTERED"];
  const labels = { NEW_ERROR: "Novo erro", REPEATED: "Reincidente", UNDER_REVIEW: "Em revisão", STABILIZING: "Em consolidação", MASTERED: "Consolidado" };
  const queueState = error.syncStatus === "SYNCED" && !queueItem
    ? "sincronizado"
    : queueItem?.attempts
      ? `${queueItem.attempts} tentativa(s) · próxima em ${formatDate(queueItem.nextAttemptAt, true)}`
      : "pendente · aguardando envio seguro";
  const queueError = queueItem?.lastError ? ` · ${queueItem.lastError}` : "";
  return `<article class="error-card"><div class="error-card-top"><span class="tag ${error.status === "MASTERED" ? "tag-green" : error.repeated ? "tag-red" : "tag-amber"}">${e(labels[error.status] || error.statusLabel || "Novo erro")}</span><span class="mono">${e(error.questionId)}</span></div><h3>${e(error.title || error.topic || "Questão")}</h3><p>${e(error.dayCode)} · ${e(error.setCode)} · ${e(error.subject)} · ${e(error.topic)}</p><p>Marcada: <strong>${e(error.selected || "—")}</strong> · gabarito: <strong>${e(error.answerKey || "—")}</strong> · ${Number(error.errorCount || 0)} erro(s)</p>
    <form class="error-edit-form" data-error-form="${e(error.questionId)}"><div class="error-card-grid"><div class="form-row"><label for="status-${e(error.questionId)}">Status</label><select class="field" id="status-${e(error.questionId)}" name="status">${statuses.map(status => `<option value="${status}" ${error.status === status ? "selected" : ""}>${labels[status]}</option>`).join("")}</select></div><div class="form-row"><label for="category-${e(error.questionId)}">Categoria</label><select class="field" id="category-${e(error.questionId)}" name="reasonCategory">${["Conteúdo", "Interpretação", "Distração", "Cálculo", "Confusão conceitual", "Chute"].map(value => `<option value="${e(value)}" ${error.reasonCategory === value ? "selected" : ""}>${e(value)}</option>`).join("")}</select></div></div><div class="error-card-grid"><div class="form-row"><label for="reason-${e(error.questionId)}">Motivo</label><textarea class="field" id="reason-${e(error.questionId)}" name="reason">${e(error.reason)}</textarea></div><div class="form-row"><label for="mnemonic-${e(error.questionId)}">Macete / correção</label><textarea class="field" id="mnemonic-${e(error.questionId)}" name="mnemonic">${e(error.mnemonic)}</textarea></div></div><div class="form-row"><label for="note-${e(error.questionId)}">Observação pessoal</label><textarea class="field" id="note-${e(error.questionId)}" name="note">${e(error.note)}</textarea></div><div class="form-row"><label for="next-review-${e(error.questionId)}">Próxima revisão</label><input class="field" id="next-review-${e(error.questionId)}" name="nextReviewAt" type="datetime-local" value="${e(localDateValue(error.nextReviewAt))}"></div><div class="error-card-actions"><span class="tiny">Primeiro erro ${e(formatDate(error.firstErrorAt))} · último ${e(formatDate(error.lastErrorAt))}</span><button class="button button-quiet button-small" type="submit">Salvar no dispositivo</button></div></form>
    <div class="tiny sync-queue-state">Fila local: ${e(queueState)}${e(queueError)}</div></article>`;
}

async function renderErrors(errors) {
  const sorted = [...errors].sort((a, b) => Date.parse(b.lastErrorAt || b.updatedAt) - Date.parse(a.lastErrorAt || a.updatedAt));
  const sync = readSyncConfig();
  const queue = (await getAllRecords("sync_queue")).filter(item => item.status === "PENDING");
  const queueByQuestion = new Map(queue.map(item => [item.entityId, item]));
  const pending = queue.length;
  const syncControl = sync.endpoint && sync.token
    ? `<button class="button button-primary button-small" data-action="sync-errors">Sincronizar ${pending} pendência(s)</button>`
    : `<span class="tag tag-amber">BACKEND NÃO CONFIGURADO</span>`;
  root.innerHTML = `<div class="page-wrap">${heading("ERROR LAB", "Caderno de erros", "Um erro por Question ID. Tentativas, contadores e notas são salvos localmente.", syncControl)}<div class="notice notice-warning"><strong>${sync.token ? "Acesso de sincronização disponível nesta sessão." : "Sincronização com Notion ainda não conectada."}</strong><p>Erros e edições entram na fila local. O token de escrita do Notion permanece no backend; o navegador só envia operações ao endpoint HTTPS configurado. Sem endpoint e chave de sessão, nenhum dado sai deste dispositivo.</p><p>${pending} operação(ões) aguardam confirmação. A fila tenta novamente sozinha quando a conexão estiver disponível; você também pode pedir uma tentativa imediata.</p></div><div class="error-card-grid">${sorted.map(error => errorCard(error, queueByQuestion.get(error.questionId))).join("") || emptyState("Ainda não há erros", "Respostas incorretas entrarão automaticamente neste caderno.")}</div></div>`;
}

async function renderAnalytics(progress, errors, attempts, sessions, answers) {
  const analytics = calculateAnalytics(attempts, answers, sessions, missionDays(), progress);
  const subjects = analytics.subjects;
  root.innerHTML = `<div class="page-wrap">${heading("ANALYTICS", "Desempenho local", "Métricas derivadas das respostas e sessões registradas neste dispositivo.")}
    <section class="metric-grid">${metric("RESPOSTAS", analytics.questionCount || "—", analytics.questionCount ? `${analytics.correct} acertos` : "Sem amostra", "⌘")}${metric("PRECISÃO", analytics.accuracy == null ? "—" : `${analytics.accuracy}%`, analytics.sampleSize < 10 && analytics.questionCount ? `Amostra pequena: ${analytics.sampleSize}` : analytics.questionCount ? `${analytics.sampleSize} respostas` : "Sem dados", "◎")}${metric("HORAS", analytics.studyMinutes ? `${analytics.studyHours} h` : "—", analytics.studyMinutes ? `${analytics.studyMinutes} minutos de sessões` : "Sem sessões", "◷")}${metric("PROGRESSO", `${analytics.completedDays}/75`, `${analytics.completedQuestionSets} completas · ${analytics.partialQuestionSets} parciais`, "▤")}</section>
    <div class="two-column"><section class="panel"><div class="panel-kicker">DESEMPENHO POR MATÉRIA</div>${subjects.length ? subjects.map(item => `<div class="subject-bar"><div class="subject-bar-label"><strong>${e(item.subject)}</strong><span>${item.correct}/${item.total}${item.accuracy == null ? "" : ` · ${item.accuracy}%`}</span></div><div class="progress-track"><span class="progress-fill ${progressWidthClass(item.accuracy || 0)}"></span></div><small>${item.total >= 10 ? "Amostra suficiente para leitura descritiva" : `Amostra pequena (${item.total}); sem tendência`}</small></div>`).join("") : `<p class="muted">Ainda não há respostas suficientes para mostrar desempenho por matéria.</p>`}</section><section class="panel"><div class="panel-kicker">ATIVIDADE REGISTRADA</div><p>${attempts.filter(item => item.completedAt).length} tentativas concluídas.</p><p>${sessions.length} sessões de estudo registradas explicitamente.</p><p>${errors.filter(item => item.repeated).length} questões reincidentes no Error Lab.</p><p class="tiny">Ausência de respostas aparece como —; nenhum percentual é inferido sem amostra.</p></section></div>
  </div>`;
}

async function renderMentor(progress, errors, attempts, sessions, answers) {
  const analytics = calculateAnalytics(attempts, answers, sessions, missionDays(), progress);
  const advice = buildMentorAdvice(currentMission(progress), analytics, errors, missionReviews());
  root.innerHTML = `<div class="page-wrap">${heading("DECISION ENGINE", "Próxima decisão", "Sugestões explicáveis a partir da ordem pedagógica e dos seus dados locais.")}
    <article class="mentor-card"><span class="tag tag-cyan">AÇÃO SUGERIDA</span><h3>${e(advice.action)}</h3><p>${e(advice.reason)}</p><p><strong>Evidência:</strong> ${e(advice.evidence)}</p><span class="mentor-confidence">CONFIANÇA ${e(advice.confidence)}</span><div class="hero-actions">${currentMission(progress).type === "study" ? `<button class="button button-primary" data-route="study" data-parameter="${e(currentMission(progress).code)}">Abrir material</button>` : currentMission(progress).type === "questions" ? `<button class="button button-primary" data-route="questions" data-parameter="${e(currentMission(progress).code)}">Abrir bateria</button>` : currentMission(progress).type === "review" ? `<button class="button button-primary" data-route="reviews" data-parameter="${e(currentMission(progress).code)}">Abrir revisão</button>` : `<button class="button button-primary" data-route="history">Abrir histórico</button>`}</div></article>
    <section class="panel mentor-limit"><div class="panel-kicker">BASE DA LEITURA</div><p>Respostas: ${analytics.questionCount || "sem amostra"} · sessões: ${sessions.length} · erros pendentes: ${errors.filter(error => error.status !== "MASTERED").length} · sequência atual: ${e(currentMission(progress).code || "concluída")}.</p><p>O mentor não declara domínio quando não há amostra suficiente. Desempenho por matéria só aparece após respostas classificadas.</p></section></div>`;
}

async function renderHistory(attempts, answers, sessions, progress) {
  const orderedAttempts = [...attempts].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const orderedSessions = [...sessions].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  root.innerHTML = `<div class="page-wrap">${heading("HISTÓRICO", "Atividade deste dispositivo", "Tentativas, unidades e sessões explicitamente iniciadas.", `<button class="button button-quiet button-small" data-action="export-backup">Exportar backup</button>`)}
    <section class="panel"><div class="section-head"><div><div class="eyebrow">SESSÕES</div><h2>Tempo estudado</h2></div></div>${orderedSessions.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Início</th><th>Unidade</th><th>Duração</th><th>Ajustar minutos</th></tr></thead><tbody>${orderedSessions.map(session => `<tr><td>${e(formatDate(session.startedAt, true))}</td><td><strong>${e(session.dayCode || "Livre")}</strong></td><td>${e(session.status === "IN_PROGRESS" ? "Em andamento" : formatDuration(session.durationSeconds || 0))}</td><td>${session.status === "IN_PROGRESS" ? "—" : `<form class="inline-form" data-adjust-session="${e(session.sessionId)}"><input class="field" name="minutes" type="number" min="0" max="1440" step="1" value="${Math.round(session.durationMinutes || 0)}" aria-label="Minutos ajustados"><button class="button button-quiet button-small">Salvar</button></form>`}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Nenhuma sessão foi registrada. Inicie pelo Command Center ou material.</p>`}</section>
    <div class="two-column"><section class="panel"><div class="panel-kicker">TENTATIVAS DE QUESTÕES</div>${orderedAttempts.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Bateria</th><th>Tentativa</th><th>Resultado</th><th>Data</th></tr></thead><tbody>${orderedAttempts.map(attempt => { const rows = answers.filter(answer => answer.attemptId === attempt.attemptId); const score = attempt.score || scoreQuestionSet([], {}); const coverage = attempt.coverageStatus === "partial" ? ` · ${score.total}/${attempt.plannedQuestionCount || score.total} disponíveis` : ""; return `<tr><td><strong>${e(attempt.questionSet)}</strong></td><td>${attempt.attemptNumber}</td><td>${attempt.completedAt ? `${score.correct ?? 0}/${score.total ?? rows.length}${coverage}` : "Em andamento"}</td><td>${e(formatDate(attempt.startedAt, true))}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="muted">Nenhuma tentativa registrada.</p>`}</section><section class="panel"><div class="panel-kicker">PROGRESSO EDITORIAL</div><p>${progress.filter(item => /^D\d{2}$/.test(item.id) && item.completedAt).length} unidades concluídas.</p><p>${progress.filter(item => /^R\d{2}$/.test(item.id) && item.completedAt).length} revisões registradas.</p><p>Próximo passo: ${e(currentMission(progress).code || "trilha concluída")}.</p></section></div></div>`;
}

async function renderSettings() {
  const prefs = state.preferences;
  const sync = readSyncConfig();
  const queueCount = (await getAllRecords("sync_queue")).filter(item => item.status === "PENDING").length;
  root.innerHTML = `<div class="page-wrap">${heading("CONFIGURAÇÕES", "Preferências e continuidade", "Preferências leves no localStorage; dados de estudo no IndexedDB.")}
    <div class="two-column"><section class="panel"><div class="panel-kicker">INTERFACE</div><form id="preferences-form"><div class="form-row"><label for="pref-theme">Tema</label><select class="field" id="pref-theme" name="theme"><option value="dark" ${prefs.theme === "dark" ? "selected" : ""}>Escuro</option><option value="light" ${prefs.theme === "light" ? "selected" : ""}>Claro</option></select></div><div class="form-row"><label for="pref-font">Tamanho de leitura</label><select class="field" id="pref-font" name="fontSize"><option value="normal" ${prefs.fontSize === "normal" ? "selected" : ""}>Normal</option><option value="large" ${prefs.fontSize === "large" ? "selected" : ""}>Grande</option></select></div><div class="form-row"><label for="pref-width">Largura de leitura</label><select class="field" id="pref-width" name="readerWidth"><option value="wide" ${prefs.readerWidth === "wide" ? "selected" : ""}>Ampla</option><option value="narrow" ${prefs.readerWidth === "narrow" ? "selected" : ""}>Estreita</option></select></div><label class="check-row"><input type="checkbox" name="focusMode" ${prefs.focusMode ? "checked" : ""}> Modo foco</label><button class="button button-primary" type="submit">Salvar preferências</button></form></section>
    <section class="panel"><div class="panel-kicker">BACKUP LOCAL</div><p>Exportar ou mesclar sessões, respostas, progresso, erros, revisões e preferências. Os registros mais recentes vencem quando o mesmo ID aparece nos dois arquivos.</p><div class="settings-actions"><button class="button button-primary" data-action="export-backup">Exportar backup</button><label class="button button-quiet file-button">Restaurar backup<input type="file" id="backup-file" accept="application/json,.json" hidden></label></div><p class="tiny">Backup JSON · até 20 MB · compatibilidade schema ${1}</p></section>
    <section class="panel"><div class="panel-kicker">SINCRONIZAÇÃO EDITORIAL</div><p>Fonte: Notion · snapshot versionado: <code>${e(state.content.meta.contentVersion.slice(0, 12))}</code></p><p>Gerado ${e(formatDate(state.content.meta.generatedAt, true))} · fonte alterada ${e(formatDate(state.content.meta.sourceUpdatedAt, true))}</p><a class="button button-quiet" href="https://github.com/RodrigoRosaDantas/haba-study-os/actions/workflows/sync-notion.yml" target="_blank" rel="noopener noreferrer">Executar sincronização do Notion ↗</a></section>
    <section class="panel"><div class="panel-kicker">SYNC DE ERROS · NOTION</div><p>Fila pendente: ${queueCount} operação(ões). A chave do navegador não é a credencial Notion; o backend precisa guardar uma integração separada com escrita.</p><form id="sync-config-form"><div class="form-row"><label for="sync-endpoint">Endpoint HTTPS do Worker</label><input class="field" id="sync-endpoint" name="endpoint" type="url" inputmode="url" autocomplete="url" placeholder="https://seu-worker.workers.dev" value="${e(sync.endpoint)}" required></div><div class="form-row"><label for="sync-token">Chave de acesso do backend ${sync.token ? "(deixe vazio para manter nesta sessão)" : ""}</label><input class="field" id="sync-token" name="token" type="password" autocomplete="new-password" placeholder="Não é o token do Notion" ${sync.token ? "" : "required"}></div><div class="settings-actions"><button class="button button-primary" type="submit">Salvar e sincronizar</button><button class="button button-quiet" type="button" data-action="clear-sync-config">Desconectar</button></div></form><p class="tiny">A chave fica no sessionStorage desta aba e não entra em backup nem localStorage. Se ainda não implantou o Worker, veja <code>backend/README.md</code>.</p><button class="button button-quiet" data-route="errors">Abrir Error Lab</button></section></div></div>`;
}

function renderMore() {
  root.innerHTML = `<div class="page-wrap">${heading("WORKSPACE", "Mais áreas", "Escolha uma área do HABA Study OS.")}<div class="module-list">${[["errors","Error Lab","Caderno local de erros"],["analytics","Analytics","Desempenho e amostra"],["mentor","Decision Engine","Próxima ação explicável"],["history","Histórico","Sessões e tentativas"],["settings","Configurações","Preferências e backup"]].map(row => `<button class="module-card" data-route="${row[0]}"><span class="module-code">→</span><span class="module-copy"><strong>${row[1]}</strong><small>${row[2]}</small></span></button>`).join("")}</div></div>`;
}

async function renderRoute() {
  ({ route: state.route, parameter: state.parameter, questionIndex: state.questionIndex } = routeFromHash());
  try {
    const [progress, errors, attempts, sessions, answers] = await Promise.all([
      getAllRecords("progress"), getAllRecords("errors"), getAllRecords("question_attempts"), getAllRecords("study_sessions"), getAllRecords("question_answers")
    ]);
    updateShell(progress, errors);
    if (state.route === "today") await renderToday(progress, errors, attempts, sessions);
    else if (state.route === "study") await renderStudy(progress);
    else if (state.route === "questions") await renderQuestions(progress);
    else if (state.route === "reviews") await renderReviews(progress, errors);
    else if (state.route === "errors") await renderErrors(errors);
    else if (state.route === "analytics") await renderAnalytics(progress, errors, attempts, sessions, answers);
    else if (state.route === "mentor") await renderMentor(progress, errors, attempts, sessions, answers);
    else if (state.route === "history") await renderHistory(attempts, answers, sessions, progress);
    else if (state.route === "settings") await renderSettings();
    else if (state.route === "more") renderMore();
    else { state.route = "today"; openRoute("today"); }
    root.focus({ preventScroll: true });
  } catch (error) {
    root.innerHTML = `<div class="page-wrap">${emptyState("Não foi possível abrir esta área", error.message || "Falha no banco local. Seus dados não foram apagados.")}</div>`;
  }
}

function scheduleReadingSave() {
  clearTimeout(readingSaveTimer);
  readingSaveTimer = setTimeout(async () => {
    const reader = byId("reader-document");
    if (!reader || !reader.dataset.readerPage) return;
    const scrollY = window.scrollY;
    const scrollMax = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    try {
      await putRecord("reading_progress", { pageId: reader.dataset.readerPage, scrollY, scrollRatio: Math.min(1, scrollY / scrollMax), updatedAt: new Date().toISOString() });
      const node = document.querySelector(".reader-progress span:first-child");
      if (node) node.textContent = `${Math.min(100, Math.round(scrollY / scrollMax * 100))}% lido`;
      const bar = document.querySelector(".reader-progress + .progress-track .progress-fill");
      if (bar) {
        bar.className = `progress-fill ${progressWidthClass(Math.round(scrollY / scrollMax * 100))}`;
      }
    } catch { /* A posição é uma ajuda; falha de gravação não interrompe leitura. */ }
  }, 550);
}

window.addEventListener("scroll", () => { if (state.route === "study") scheduleReadingSave(); }, { passive: true });

function startSessionClock() {
  if (state.timer) return;
  state.timer = window.setInterval(() => {
    for (const node of document.querySelectorAll(".session-clock[data-session-started]")) {
      node.textContent = formatDuration(Math.floor((Date.now() - Date.parse(node.dataset.sessionStarted)) / 1000));
    }
  }, 1_000);
}

async function startStudySession(dayCode = state.currentDay?.code || "") {
  if (state.activeSession) { toast("Já há uma sessão em andamento."); return; }
  const session = { sessionId: `SESSION-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, dayCode, startedAt: new Date().toISOString(), finishedAt: null, durationSeconds: 0, durationMinutes: 0, status: "IN_PROGRESS", createdAt: new Date().toISOString() };
  await putRecord("study_sessions", session);
  state.activeSession = session;
  startSessionClock();
  toast("Sessão iniciada. O tempo só será registrado até você encerrar.");
  await renderRoute();
}

async function stopStudySession() {
  if (!state.activeSession) return;
  const finishedAt = new Date().toISOString();
  const durationSeconds = Math.max(0, Math.floor((Date.parse(finishedAt) - Date.parse(state.activeSession.startedAt)) / 1000));
  const saved = { ...state.activeSession, finishedAt, durationSeconds, durationMinutes: Math.round(durationSeconds / 6) / 10, status: "COMPLETED", updatedAt: finishedAt };
  await putRecord("study_sessions", saved);
  state.activeSession = null;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  toast(`Sessão encerrada: ${formatDuration(durationSeconds)}.`);
  await renderRoute();
}

async function enqueueErrorSync(error) {
  const operationId = `ERROR-${error.questionId}`;
  const previous = await getRecord("sync_queue", operationId);
  const updatedAt = error.updatedAt || new Date().toISOString();
  await putRecord("sync_queue", { operationId, entityId: error.questionId, entityType: "error", action: "upsert", payload: error, status: "PENDING", createdAt: previous?.createdAt || error.createdAt || updatedAt, updatedAt, attempts: 0, lastAttemptAt: null, lastError: "", nextAttemptAt: null });
  scheduleErrorSync();
}

async function recordError(question, selected) {
  const current = await getRecord("errors", question.questionId);
  let error = upsertError(current, question, selected);
  error = { ...error, questionRevision: question.contentHash || "", notionPageId: question.notionPageId || "", syncStatus: "PENDING" };
  await putRecord("errors", error);
  await enqueueErrorSync(error);
  return error;
}

async function scheduleErrorSync() {
  const generation = ++errorSyncScheduleGeneration;
  clearTimeout(errorSyncTimer);
  const config = readSyncConfig();
  if (!config.endpoint || !config.token || navigator.onLine === false) return;
  const queue = await getAllRecords("sync_queue");
  if (generation !== errorSyncScheduleGeneration) return;
  const delay = millisecondsUntilQueueDue(queue);
  if (delay === null) return;
  errorSyncTimer = setTimeout(() => syncErrors({ quiet: true }), delay === 0 ? 1_200 : delay);
}

async function deferQueueOperation(attempted, reason) {
  const current = await getRecord("sync_queue", attempted.operationId);
  if (!isSameSyncOperation(current, attempted)) return;
  await putRecord("sync_queue", deferFailedOperation(current, reason));
}

async function acknowledgeQueueOperation(attempted, operation) {
  const queued = await getRecord("sync_queue", attempted.operationId);
  if (queued && isSameSyncOperation(queued, attempted)) await deleteRecord("sync_queue", attempted.operationId);
  const latestQueue = await getRecord("sync_queue", attempted.operationId);
  const current = await getRecord("errors", attempted.entityId);
  if (current && !latestQueue && current.updatedAt === attempted.payload?.updatedAt) {
    await putRecord("errors", { ...current, syncStatus: "SYNCED", notionPageId: operation.notionPageId, notionUpdatedAt: operation.notionUpdatedAt, updatedAt: current.updatedAt });
  }
  return !latestQueue;
}

async function mergeRemoteErrors(records = []) {
  for (const remote of records) {
    if (!remote?.questionId) continue;
    const local = await getRecord("errors", remote.questionId);
    if (!local) {
      await putRecord("errors", { ...remote, syncStatus: "SYNCED" });
      continue;
    }
    const queueId = `ERROR-${remote.questionId}`;
    const queued = await getRecord("sync_queue", queueId);
    const remoteTime = Date.parse(remote.notionUpdatedAt || remote.updatedAt || "") || 0;
    const localTime = Date.parse(local.updatedAt || local.lastErrorAt || "") || 0;
    const localWins = Boolean(queued) || localTime > remoteTime;
    const personal = localWins ? local : remote;
    const count = Math.max(1, Number(local.errorCount) || Number(remote.errorCount) || 1);
    const mastered = personal.status === "MASTERED";
    const status = mastered ? "MASTERED" : count > 1 ? "REPEATED" : (personal.status || "NEW_ERROR");
    const labels = { NEW_ERROR: "Novo erro", REPEATED: "Reincidente", UNDER_REVIEW: "Em revisão", STABILIZING: "Em consolidação", MASTERED: "Consolidado" };
    const merged = {
      ...remote,
      ...local,
      questionId: remote.questionId,
      errorId: local.errorId || remote.errorId || `ERR-${remote.questionId}`,
      subject: remote.subject || local.subject,
      topic: remote.topic || local.topic,
      board: remote.board || local.board,
      dayCode: remote.dayCode || local.dayCode,
      setCode: remote.setCode || local.setCode,
      errorCount: local.errorCount || remote.errorCount || 1,
      repeated: count > 1,
      firstErrorAt: local.firstErrorAt || remote.firstErrorAt,
      lastErrorAt: local.lastErrorAt || remote.lastErrorAt,
      reasonCategory: personal.reasonCategory || "Conteúdo",
      reason: personal.reason || "",
      note: personal.note || "",
      mnemonic: personal.mnemonic || "",
      nextReviewAt: personal.nextReviewAt || null,
      lastReviewedAt: personal.lastReviewedAt || remote.lastReviewedAt || null,
      status,
      statusLabel: labels[status] || personal.statusLabel || status,
      updatedAt: localWins ? local.updatedAt : remote.updatedAt,
      notionPageId: remote.notionPageId,
      notionUpdatedAt: remote.notionUpdatedAt,
      syncStatus: queued ? "PENDING" : "SYNCED"
    };
    await putRecord("errors", merged);
  }
}

async function syncErrors({ quiet = false, force = false } = {}) {
  if (errorSyncPromise) return errorSyncPromise;
  errorSyncPromise = (async () => {
    const config = readSyncConfig();
    if (!config.endpoint || !config.token) {
      if (!quiet) toast("Configure o endpoint HTTPS e a chave de acesso do backend em Configurações.");
      return false;
    }
    if (navigator.onLine === false) {
      if (!quiet) toast("Sem conexão. As operações continuam na fila local.");
      return false;
    }
    let activeBatch = [];
    try {
      config.endpoint = normalizeSyncEndpoint(config.endpoint);
      const now = Date.now();
      const queue = (await getAllRecords("sync_queue")).filter(item => force ? item.status === "PENDING" : isQueueItemDue(item, now));
      const batches = [];
      for (let index = 0; index < queue.length; index += 10) batches.push(queue.slice(index, index + 10));
      if (!batches.length) batches.push([]);
      let remoteRecords = [];
      let failed = 0;
      let readWarning = "";
      for (const batch of batches) {
        activeBatch = batch;
        const response = await fetch(`${config.endpoint}/api/errors/sync`, {
          method: "POST",
          mode: "cors",
          credentials: "omit",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
          body: JSON.stringify({ operations: batch.map(item => ({ operationId: item.operationId, action: "upsert", error: item.payload })) }),
          signal: AbortSignal.timeout(25_000)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `Backend respondeu ${response.status}.`);
        const results = new Map((result.results || []).map(operation => [operation.operationId, operation]));
        for (const item of batch) {
          const operation = results.get(item.operationId);
          if (operation?.status === "SYNCED") {
            if (!await acknowledgeQueueOperation(item, operation)) failed += 1;
          } else {
            await deferQueueOperation(item, operation?.status || "confirmação ausente");
            failed += 1;
          }
        }
        if (Array.isArray(result.records)) remoteRecords = result.records;
        if (result.readWarning) readWarning = String(result.readWarning).slice(0, 180);
        activeBatch = [];
      }
      await mergeRemoteErrors(remoteRecords);
      if (!quiet) toast(failed ? `Sync parcial: ${failed} item(ns) aguardam nova tentativa.` : readWarning ? `Erros enviados; não foi possível atualizar a lista remota agora.` : `Sync concluído: ${remoteRecords.length} registro(s) recebidos do Notion.`);
      await renderRoute();
      scheduleErrorSync();
      return failed === 0 && !readWarning;
    } catch (error) {
      for (const item of activeBatch) await deferQueueOperation(item, error.message || "falha de conexão");
      if (!quiet) toast(`Sync pendente: ${error.message || "falha de conexão"}. A fila foi preservada.`);
      scheduleErrorSync();
      return false;
    }
  })();
  try { return await errorSyncPromise; }
  finally { errorSyncPromise = null; }
}

async function selectAnswer(questionId, selected) {
  const day = state.currentDay;
  const attempt = state.currentAttempt;
  const question = day?.questionSet.items.find(item => item.questionId === questionId);
  if (!attempt || !question) return;
  const answerId = `${attempt.attemptId}::${question.questionId}`;
  const previous = await getRecord("question_answers", answerId);
  const now = new Date().toISOString();
  const history = previous?.selected && previous.selected !== selected
    ? [...(previous.history || []), { selected: previous.selected, recordedAt: previous.updatedAt || now }]
    : previous?.history || [];
  const isCorrect = selected === question.answerKey;
  const response = {
    answerId, attemptId: attempt.attemptId, questionId: question.questionId, questionVersion: question.contentHash || "",
    questionSet: question.setCode, dayCode: day.code, selected, answerKey: question.answerKey, isCorrect,
    subject: question.subject || "", topic: question.topic || "", board: question.board || "", year: question.year || "",
    durationSeconds: previous?.durationSeconds || Math.max(0, Math.floor((Date.now() - questionStartedAt) / 1000)),
    history, answeredAt: now, updatedAt: now, attemptNumber: attempt.attemptNumber
  };
  await putRecord("question_answers", response);
  if (!isCorrect) await recordError({ ...question, dayCode: day.code, setCode: question.setCode, cycle: day.cycle, week: day.week }, selected);
  const questionIndex = day.questionSet.items.findIndex(item => item.questionId === questionId);
  state.questionIndex = questionIndex;
  history.replaceState(null, "", `#questions/${encodeURIComponent(day.questionSet.code)}/${questionIndex}`);
  toast(isCorrect ? "Resposta correta." : "Erro adicionado automaticamente ao Error Lab.");
  await renderRoute();
}

async function finishQuestionSet(setCode) {
  const day = dayForQuestion(setCode);
  const attempt = state.currentAttempt;
  if (!attempt || !day) return;
  const answers = (await getAllRecords("question_answers")).filter(row => row.attemptId === attempt.attemptId);
  const answersByQuestion = Object.fromEntries(answers.map(answer => [answer.questionId, answer.selected]));
  const score = scoreQuestionSet(day.questionSet.items, answersByQuestion);
  const completedAt = new Date().toISOString();
  const durationSeconds = Math.max(0, Math.floor((Date.parse(completedAt) - Date.parse(attempt.startedAt)) / 1000));
  const coverageStatus = day.questionSet.sourceStatus === "complete" ? "complete" : "partial";
  const finished = { ...attempt, completedAt, durationSeconds, score, coverageStatus, availableQuestionCount: day.questionSet.items.length, plannedQuestionCount: day.questionGoal, status: "COMPLETED", updatedAt: completedAt };
  await putRecord("question_attempts", finished);
  await putRecord("progress", { id: setCode, completedAt, updatedAt: completedAt, attemptId: attempt.attemptId, score, coverageStatus, availableQuestionCount: day.questionSet.items.length, plannedQuestionCount: day.questionGoal });
  state.currentAttempt = finished;
  toast(coverageStatus === "complete" ? `Bateria concluída: ${score.correct}/${score.answered} acertos respondidos.` : `Bateria parcial: ${score.correct}/${score.answered} acertos em ${day.questionSet.items.length}/${day.questionGoal} questões utilizáveis.`);
  await renderRoute();
}

async function completeDay(dayCode) {
  const current = await getRecord("progress", dayCode);
  const completedAt = current?.completedAt || new Date().toISOString();
  await putRecord("progress", { ...current, id: dayCode, completedAt, updatedAt: new Date().toISOString() });
  toast(`${dayCode} registrado como concluído.`);
  await renderRoute();
}

async function completeReview(code) {
  const completedAt = new Date().toISOString();
  await putRecord("progress", { id: code, completedAt, updatedAt: completedAt });
  await putRecord("revisions", { revisionId: `${code}-${completedAt}`, code, type: "OFFICIAL_REVIEW", completedAt, source: "Notion · revisão oficial" });
  toast(`${code} registrada no progresso local.`);
  await renderRoute();
}

async function reviewError(questionId) {
  const now = new Date().toISOString();
  const updated = await updateErrorRecord(questionId, current => ({ ...current, status: "UNDER_REVIEW", statusLabel: "Em revisão", lastReviewedAt: now, updatedAt: now, syncStatus: "PENDING" }));
  await enqueueErrorSync(updated);
  toast("Erro movido para Em revisão.");
  await renderRoute();
}

async function saveErrorForm(form) {
  const questionId = form.dataset.errorForm;
  const values = new FormData(form);
  const now = new Date().toISOString();
  const updated = await updateErrorRecord(questionId, current => {
    if (!current) throw new Error("O erro não existe mais no banco local.");
    const status = String(values.get("status") || current.status);
    const labels = { NEW_ERROR: "Novo erro", REPEATED: "Reincidente", UNDER_REVIEW: "Em revisão", STABILIZING: "Em consolidação", MASTERED: "Consolidado" };
    const reviewInput = String(values.get("nextReviewAt") || "");
    return { ...current, status, statusLabel: labels[status] || status, reasonCategory: String(values.get("reasonCategory") || "Conteúdo"), reason: String(values.get("reason") || ""), mnemonic: String(values.get("mnemonic") || ""), note: String(values.get("note") || ""), nextReviewAt: reviewInput ? new Date(reviewInput).toISOString() : null, updatedAt: now, syncStatus: "PENDING" };
  });
  await enqueueErrorSync(updated);
  toast("Alterações salvas no dispositivo e na fila local.");
  await renderRoute();
}

async function retryQuestionSet(code) {
  const day = dayForQuestion(code);
  if (!day) return;
  const attempts = (await getAllRecords("question_attempts")).filter(row => row.questionSet === code);
  const attemptNumber = attempts.length + 1;
  const startedAt = new Date().toISOString();
  const attemptId = `${code}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const attempt = { attemptId, questionSet: code, dayCode: day.code, attemptNumber, startedAt, completedAt: null, questionVersion: day.questionSet.contentHash || "", availableQuestionCount: day.questionSet.items.length, plannedQuestionCount: day.questionGoal, coverageStatus: day.questionSet.sourceStatus, status: "IN_PROGRESS" };
  await putRecord("question_attempts", attempt);
  await putRecord("progress", { id: `active-attempt:${code}`, attemptId, updatedAt: startedAt });
  openRoute("questions", code);
}

async function exportBackup() {
  await downloadBackup();
  toast("Backup exportado.");
}

async function onClick(event) {
  const routeButton = event.target.closest("[data-route]");
  if (routeButton) {
    event.preventDefault();
    const route = routeButton.dataset.route;
    const parameter = routeButton.dataset.parameter || "";
    if (route === "study" && !parameter) {
      const mission = currentMission(await getAllRecords("progress"));
      openRoute("study", mission.day?.code || "");
    } else openRoute(route, parameter);
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === "start-session") await startStudySession(button.dataset.day || "");
    else if (action === "stop-session") await stopStudySession();
    else if (action === "complete-day") await completeDay(button.dataset.day);
    else if (action === "complete-review") await completeReview(button.dataset.review);
    else if (action === "select-answer") await selectAnswer(button.dataset.question, button.dataset.option);
    else if (action === "finish-set") await finishQuestionSet(button.dataset.set);
    else if (action === "next-question" || action === "previous-question") {
      const index = Number(button.dataset.index) + (action === "next-question" ? 1 : -1);
      const code = state.currentDay.questionSet.code;
      history.replaceState(null, "", `#questions/${encodeURIComponent(code)}/${index}`);
      await renderRoute();
    } else if (action === "retry-set") await retryQuestionSet(button.dataset.set);
    else if (action === "review-error") await reviewError(button.dataset.id);
    else if (action === "resume-reading") window.scrollTo({ top: Number(button.dataset.scroll) || 0, behavior: "smooth" });
    else if (action === "export-backup") await exportBackup();
    else if (action === "sync-errors") await syncErrors({ force: true });
    else if (action === "clear-sync-config") { sessionStorage.removeItem("haba:sync-config"); ++errorSyncScheduleGeneration; clearTimeout(errorSyncTimer); toast("Conexão do backend removida desta sessão."); await renderRoute(); }
    else if (action === "set-focus") { state.preferences = savePreferences({ focusMode: !state.preferences.focusMode }); await renderRoute(); }
  } catch (error) { toast(error.message || "A ação não foi concluída."); }
}

async function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.id === "sync-config-form") {
    event.preventDefault();
    try {
      const values = new FormData(form);
      const token = String(values.get("token") || readSyncConfig().token);
      saveSyncConfig(String(values.get("endpoint") || ""), token);
      toast("Endpoint e chave salvos nesta sessão.");
      await syncErrors({ force: true });
    } catch (error) { toast(error.message || "Configuração de sincronização inválida."); }
  } else if (form.id === "preferences-form") {
    event.preventDefault();
    const values = new FormData(form);
    state.preferences = savePreferences({ theme: values.get("theme"), fontSize: values.get("fontSize"), readerWidth: values.get("readerWidth"), focusMode: values.get("focusMode") === "on" });
    toast("Preferências salvas.");
    await renderRoute();
  } else if (form.matches("[data-error-form]")) {
    event.preventDefault();
    try { await saveErrorForm(form); } catch (error) { toast(error.message); }
  } else if (form.matches("[data-adjust-session]")) {
    event.preventDefault();
    const sessionId = form.dataset.adjustSession;
    const minutes = Math.max(0, Number(new FormData(form).get("minutes")) || 0);
    const session = await getRecord("study_sessions", sessionId);
    if (!session) return;
    await putRecord("study_sessions", { ...session, durationMinutes: minutes, durationSeconds: minutes * 60, adjustedManually: true, adjustedAt: new Date().toISOString() });
    toast("Duração ajustada explicitamente.");
    await renderRoute();
  }
}

async function onChange(event) {
  if (event.target.id === "backup-file" && event.target.files?.[0]) {
    try {
      const result = await restoreBackupText(await event.target.files[0].text());
      state.preferences = readPreferences();
      toast(`Backup mesclado: ${result.merged} registro(s) atualizados.`);
      await renderRoute();
    } catch (error) { toast(error.message || "Não foi possível restaurar o backup."); }
  }
}

document.addEventListener("click", onClick);
document.addEventListener("submit", onSubmit);
document.addEventListener("change", onChange);
window.addEventListener("hashchange", () => { renderRoute(); });
window.addEventListener("online", () => { renderRoute(); scheduleErrorSync(); });
window.addEventListener("offline", () => renderRoute());

async function initialize() {
  const installButton = byId("quick-install");
  window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); deferredInstallPrompt = event; if (installButton) installButton.hidden = false; });
  installButton?.addEventListener("click", async () => { if (!deferredInstallPrompt) return; await deferredInstallPrompt.prompt(); deferredInstallPrompt = null; installButton.hidden = true; });
  byId("apply-update")?.addEventListener("click", () => { if (window.waitingServiceWorker) window.waitingServiceWorker.postMessage({ type: "SKIP_WAITING" }); });
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js");
      const showUpdate = () => { const banner = byId("update-banner"); if (banner) banner.hidden = false; };
      if (registration.waiting) { window.waitingServiceWorker = registration.waiting; showUpdate(); }
      registration.addEventListener("updatefound", () => registration.installing?.addEventListener("statechange", event => {
        if (event.target.state === "installed" && navigator.serviceWorker.controller) { window.waitingServiceWorker = registration.waiting; showUpdate(); }
      }));
      navigator.serviceWorker.addEventListener("controllerchange", () => location.reload());
    } catch { /* PWA opcional em preview local. */ }
  }
  try {
    state.content = await loadContent();
    const sessions = await getAllRecords("study_sessions");
    state.activeSession = sessions.filter(item => item.status === "IN_PROGRESS").sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] || null;
    if (state.activeSession) startSessionClock();
    await renderRoute();
    scheduleErrorSync();
  } catch (error) {
    setLoadingError(root, error.message || "Falha ao carregar o snapshot de conteúdo.");
  }
}

initialize();
