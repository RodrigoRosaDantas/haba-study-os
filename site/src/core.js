export function calculateComposition(goal) {
  const total = Math.max(0, Number(goal) || 0);
  const main = Math.round(total * 0.7);
  return { total, main, complementary: total - main };
}

export function getNextMission(studyDays, reviewRows, progressRows = []) {
  const days = [...(studyDays || [])].sort((a, b) => Number(a.order) - Number(b.order));
  const reviews = [...(reviewRows || [])].filter(row => /^R\d{2}$/.test(row.code)).sort((a, b) => Number(a.week) - Number(b.week));
  const progress = new Map((progressRows || []).map(record => [record.id, record]));
  for (let index = 0; index < days.length; index += 1) {
    const day = days[index];
    const dayState = progress.get(day.code);
    if (!dayState?.completedAt) return { type: "study", code: day.code, title: day.title, day };
    const questionCode = day.questionCode || day.code.replace(/^D/, "Q");
    const questionsUnavailable = Array.isArray(day.questionSet?.items) && day.questionSet.items.length === 0;
    if (!questionsUnavailable && !progress.get(questionCode)?.completedAt) return { type: "questions", code: questionCode, title: day.title, day };
    const nextDay = days[index + 1];
    const weekFinished = !nextDay || Number(nextDay.week) !== Number(day.week);
    if (weekFinished) {
      const review = reviews.find(row => Number(row.week) === Number(day.week));
      if (review && !progress.get(review.code)?.completedAt) return { type: "review", code: review.code, title: review.title, review };
    }
  }
  return { type: "complete", code: "DONE", title: "Trilha concluída" };
}

export function scoreQuestionSet(items, answers = {}) {
  const scored = (items || []).filter(item => /^[A-E]$/i.test(String(item.answerKey || "")));
  const correct = scored.filter(item => String(answers[item.questionId] || "").toUpperCase() === String(item.answerKey).toUpperCase()).length;
  const answered = scored.filter(item => answers[item.questionId]).length;
  const incorrect = Math.max(0, answered - correct);
  return {
    total: (items || []).length,
    scoredTotal: scored.length,
    answered,
    correct,
    incorrect,
    unanswered: Math.max(0, (items || []).length - answered),
    accuracy: answered ? Math.round((correct / answered) * 1000) / 10 : null
  };
}

export function upsertError(current, question, selected, now = new Date().toISOString(), attemptId = "") {
  const attemptIds = Array.isArray(current?.attemptIds) ? [...new Set(current.attemptIds.map(String).filter(Boolean))] : [];
  const hasAttemptId = typeof attemptId === "string" && attemptId.length > 0;
  const firstErrorInAttempt = hasAttemptId && !attemptIds.includes(attemptId);
  if (firstErrorInAttempt) attemptIds.push(attemptId);
  const count = (Number(current?.errorCount) || 0) + (hasAttemptId ? Number(firstErrorInAttempt) : 1);
  const repeated = count > 1;
  return {
    questionId: question.questionId,
    errorId: current?.errorId || "ERR-" + question.questionId,
    dayCode: question.dayCode,
    setCode: question.setCode,
    subject: question.subject || "",
    topic: question.topic || "",
    board: question.board || "Cesgranrio",
    cycle: question.cycle || "",
    week: Number(question.week) || 0,
    title: question.title || "",
    selected: String(selected || "").toUpperCase(),
    answerKey: String(question.answerKey || "").toUpperCase(),
    firstErrorAt: current?.firstErrorAt || now,
    lastErrorAt: now,
    errorCount: count,
    attemptIds,
    repeated,
    status: repeated ? "REPEATED" : (current?.status || "NEW_ERROR"),
    statusLabel: repeated ? "Reincidente" : (current?.statusLabel || "Novo erro"),
    reasonCategory: current?.reasonCategory || "Conteúdo",
    reason: current?.reason || "",
    note: current?.note || "",
    mnemonic: current?.mnemonic || "",
    nextReviewAt: current?.nextReviewAt || null,
    lastReviewedAt: current?.lastReviewedAt || null,
    source: "HABA Study OS · execução local",
    createdAt: current?.createdAt || now,
    updatedAt: now
  };
}
export function createQuestionSetSnapshot(day, contentVersion, now = new Date().toISOString()) {
  const questionSet = JSON.parse(JSON.stringify(day.questionSet));
  const questionVersion = String(questionSet.contentHash || contentVersion || "");
  if (!questionSet.code || !questionVersion) throw new Error("Não foi possível identificar a versão desta bateria.");
  return {
    entityId: "question-set:" + questionSet.code + ":" + questionVersion,
    questionSetCode: questionSet.code,
    questionVersion,
    questionSet,
    daySnapshot: {
      code: day.code,
      title: day.title || "",
      focus: day.focus || "",
      complementary: day.complementary || "",
      cycle: day.cycle || "",
      week: Number(day.week) || 0,
      weekday: day.weekday || "",
      questionGoal: Number(day.questionGoal) || 0
    },
    createdAt: now,
    updatedAt: now
  };
}

export function calculateAnalytics(attempts = [], answers = [], sessions = [], studyDays = [], progress = []) {
  const totalAnswers = answers.length;
  const correct = answers.filter(answer => answer.isCorrect === true).length;
  const subjectMap = new Map();
  for (const answer of answers) {
    const subject = answer.subject || "Sem classificação";
    const current = subjectMap.get(subject) || { subject, total: 0, correct: 0 };
    current.total += 1;
    if (answer.isCorrect === true) current.correct += 1;
    subjectMap.set(subject, current);
  }
  const subjects = [...subjectMap.values()].map(item => ({
    ...item,
    accuracy: item.total ? Math.round((item.correct / item.total) * 1000) / 10 : null,
    trend: item.total >= 10 ? "supported" : "insufficient-sample"
  })).sort((a, b) => b.total - a.total);
  const completedDays = progress.filter(item => /^D\d{2}$/.test(item.id) && item.completedAt).length;
  const completedQuestionSets = attempts.filter(item => item.completedAt && item.coverageStatus !== "partial").length;
  const partialQuestionSets = attempts.filter(item => item.completedAt && item.coverageStatus === "partial").length;
  const minutes = sessions.reduce((sum, session) => sum + Math.max(0, Number(session.durationMinutes) || 0), 0);
  return {
    questionCount: totalAnswers,
    correct,
    incorrect: Math.max(0, totalAnswers - correct),
    accuracy: totalAnswers ? Math.round((correct / totalAnswers) * 1000) / 10 : null,
    studyMinutes: minutes,
    studyHours: Math.round((minutes / 60) * 10) / 10,
    completedDays,
    totalDays: studyDays.length,
    completedQuestionSets,
    partialQuestionSets,
    subjects,
    sampleSize: totalAnswers
  };
}

export function buildMentorAdvice(mission, analytics, errors = [], reviews = []) {
  const pendingErrors = errors.filter(error => error.status !== "MASTERED");
  if (mission?.type === "study") return {
    action: `Abrir ${mission.code} e avançar na leitura`,
    reason: "A sequência local-first aponta esse conteúdo como a próxima unidade ainda não concluída.",
    evidence: `Próxima unidade pela Ordem editorial: ${mission.code}.`,
    confidence: "Alta · sequência editorial"
  };
  if (mission?.type === "questions") return {
    action: `Resolver ${mission.code}`,
    reason: "O material do dia já foi concluído e a bateria correspondente continua pendente.",
    evidence: `${mission.code} está ligado ao material ${mission.day?.code || "do dia"}.`,
    confidence: "Alta · progresso local"
  };
  if (mission?.type === "review") return {
    action: `Fazer ${mission.code} antes da próxima semana`,
    reason: "A revisão oficial de sábado fecha o bloco de cinco dias antes do avanço da trilha.",
    evidence: `${mission.code} cobre a semana ${mission.review?.week || "atual"} conforme o Notion.`,
    confidence: "Alta · trilha oficial"
  };
  if (pendingErrors.length) return {
    action: "Revisar o Error Lab",
    reason: "Há erros locais ainda sem marcação como consolidados.",
    evidence: `${pendingErrors.length} questão(ões) no Error Lab; a amostra de desempenho geral é ${analytics.questionCount ? `${analytics.questionCount} respostas` : "insuficiente"}.`,
    confidence: analytics.questionCount >= 10 ? "Média · dados locais" : "Baixa · poucos dados"
  };
  return {
    action: "Escolher uma revisão ou consultar o histórico",
    reason: "A sequência oficial foi concluída e ainda não há pendências locais registradas.",
    evidence: analytics.questionCount ? `${analytics.questionCount} resposta(s) registradas.` : "Ainda não há respostas registradas.",
    confidence: "Baixa · sem próxima missão"
  };
}

export function getQuestionKey(answer) {
  const match = String(answer || "").trim().match(/^([A-E])(?:\b|\s|[-—:])/i);
  return match ? match[1].toUpperCase() : "";
}

export function mergeRecords(currentRecords = [], incomingRecords = [], keyField = "id") {
  const map = new Map(currentRecords.map(record => [record[keyField], record]));
  const timestamp = record => Date.parse(record?.updatedAt || record?.createdAt || record?.exportedAt || "") || 0;
  for (const incoming of incomingRecords) {
    if (!incoming || incoming[keyField] == null) continue;
    const current = map.get(incoming[keyField]);
    if (!current || timestamp(incoming) >= timestamp(current)) map.set(incoming[keyField], incoming);
  }
  return [...map.values()];
}
