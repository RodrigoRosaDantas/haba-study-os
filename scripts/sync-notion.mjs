import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  SOURCE_IDS, assertSnapshot, fetchPageBundle, flattenBlockText, makeQuestionItem,
  notionId, parseComposition, propertyValue, queryDataSource, sha256, versionEntity
} from "./notion-sync-lib.mjs";

const OUTPUT = resolve("site/data/content.json");
const ROOT_PAGE_ID = "3dfcf5a2-6731-8119-9194-d4ab2ed5c26d";

function relationId(page, property) {
  const value = propertyValue(page, property);
  return Array.isArray(value) ? value[0] || "" : notionId(value);
}

function stringValue(page, property) {
  const value = propertyValue(page, property);
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

function numberValue(page, property, fallback = 0) {
  const value = Number(propertyValue(page, property));
  return Number.isFinite(value) ? value : fallback;
}

function dayCode(title) {
  return String(title || "").match(/\bD\d{2}\b/)?.[0] || "";
}

function reviewCode(title) {
  return String(title || "").match(/\bR\d{2}\b/)?.[0] || "";
}

function hasOfficialTag(value, code) {
  const tags = String(value || "").toUpperCase().match(/Q\d{2}-(?:BATERIA|RESERVA)/g) || [];
  return tags.includes(`${code}-BATERIA`) && !tags.includes(`${code}-RESERVA`);
}

function sortQuestionRows(rows) {
  return [...rows].sort((a, b) => {
    const orderOf = page => {
      for (const key of ["Ordem na bateria", "Ordem", "Posição", "Número", "Nº"]) {
        const value = Number(propertyValue(page, key));
        if (Number.isFinite(value) && value > 0) return value;
      }
      const id = String(propertyValue(page, "ID original") || pageTitleSafe(page));
      const matches = [...id.matchAll(/\d+/g)];
      return matches.length ? Number(matches.at(-1)[0]) : Number.MAX_SAFE_INTEGER;
    };
    const byOrder = orderOf(a) - orderOf(b);
    return byOrder || String(propertyValue(a, "ID original")).localeCompare(String(propertyValue(b, "ID original")), "pt-BR", { numeric: true });
  });
}

function pageTitleSafe(page) {
  const titleProperty = Object.values(page?.properties || {}).find(property => property?.type === "title");
  const value = titleProperty?.title || [];
  return value.map(part => part.plain_text || "").join("");
}

function readPrevious() {
  return readFile(OUTPUT, "utf8").then(text => JSON.parse(text)).catch(() => null);
}

function entityMap(rows) {
  return new Map((Array.isArray(rows) ? rows : []).map(row => [row.code, row]));
}

function newestDate(...values) {
  return values.flat(Infinity).filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || "";
}

async function buildSnapshot(previous) {
  const [studyRows, trackRows, questionRows] = await Promise.all([
    queryDataSource(SOURCE_IDS.studyDays),
    queryDataSource(SOURCE_IDS.weeklyTrack),
    queryDataSource(SOURCE_IDS.questions)
  ]);
  const previousDays = entityMap(previous?.studyDays);
  const previousReviews = entityMap(previous?.reviews);
  const previousRestDays = entityMap(previous?.restDays);
  const previousCycles = entityMap(previous?.cycles);

  const dailyPages = studyRows
    .filter(row => stringValue(row, "Tipo").toLowerCase().includes("estudo"))
    .sort((a, b) => numberValue(a, "Ordem") - numberValue(b, "Ordem"));
  const weeklyPages = trackRows
    .filter(row => stringValue(row, "Tipo").toLowerCase().includes("revisão"))
    .sort((a, b) => numberValue(a, "Semana") - numberValue(b, "Semana"));
  const restPages = trackRows
    .filter(row => stringValue(row, "Tipo").toLowerCase().includes("descanso"))
    .sort((a, b) => numberValue(a, "Semana") - numberValue(b, "Semana"));

  const materials = new Map();
  const questionPageIds = new Set();
  const reviewPageIds = new Set();
  const daySources = dailyPages.map(page => {
    const title = stringValue(page, "Dia");
    const code = dayCode(title);
    const materialId = relationId(page, "Material do dia");
    const questionPageId = relationId(page, "Questões do dia");
    const reviewPageId = relationId(page, "Revisão da semana");
    if (materialId) materials.set(code, materialId);
    if (questionPageId) questionPageIds.add(questionPageId);
    if (reviewPageId) reviewPageIds.add(reviewPageId);
    return { page, code, title, materialId, questionPageId, reviewPageId };
  });

  const reviewPages = new Map(weeklyPages.map(page => [notionId(page.id), page]));
  for (const page of weeklyPages) reviewPageIds.add(notionId(page.id));

  const allReferencedPages = new Set([
    ...[...materials.values()], ...questionPageIds, ...reviewPageIds
  ]);
  const bundles = new Map();
  await Promise.all([...allReferencedPages].map(async pageId => {
    bundles.set(pageId, await fetchPageBundle(pageId));
  }));

  const reviewByWeek = new Map(weeklyPages.map(page => [numberValue(page, "Semana"), page]));
  const questionRowsBySet = new Map();
  for (let week = 1; week <= 15; week += 1) {
    const page = reviewByWeek.get(week);
    if (page?.id) reviewPageIds.add(page.id);
  }

  const sourceQuestionSets = new Map();
  for (let index = 1; index <= 75; index += 1) {
    const code = `Q${String(index).padStart(2, "0")}`;
    sourceQuestionSets.set(code, sortQuestionRows(questionRows.filter(row =>
      hasOfficialTag(propertyValue(row, "Uso na trilha oficial"), code)
      && stringValue(row, "Status").toLowerCase() === "pronta para estudo"
    )));
  }

  const sourceUpdatedAt = newestDate(
    studyRows.map(row => row.last_edited_time),
    trackRows.map(row => row.last_edited_time),
    questionRows.map(row => row.last_edited_time),
    [...bundles.values()].map(bundle => bundle.updatedAt)
  );

  const studyDays = [];
  for (const source of daySources) {
    const { page, code, title, materialId, questionPageId, reviewPageId } = source;
    if (!code) throw new Error(`Uma linha da trilha não tem código Dxx reconhecível: ${title || page.id}`);
    const materialBundle = bundles.get(materialId);
    const questionBundle = bundles.get(questionPageId);
    if (!materialBundle || !questionBundle) throw new Error(`${code} não aponta para página de material e bateria de questões.`);
    const goal = numberValue(page, "Meta de questões");
    const sourceQuestionRows = sourceQuestionSets.get(code.replace("D", "Q")) || [];
    const items = sourceQuestionRows.map((row, index) => makeQuestionItem(row, code.replace("D", "Q"), index + 1));
    const oldItems = new Map((previousDays.find(day => day.code === code)?.questionSet?.items || []).map(item => [item.questionId, item]));
    const versionedItems = items.map(item => versionEntity(item, oldItems.get(item.questionId)));
    const compositionText = [
      flattenBlockText(questionBundle.blocks),
      stringValue(page, "Observações"),
      flattenBlockText(materialBundle.blocks)
    ].join("\n");
    const composition = parseComposition(compositionText, goal);
    if (composition.total !== goal) throw new Error(`${code} tem meta ${goal}, mas a composição da bateria aponta ${composition.total}.`);
    const dayPayload = {
      code,
      order: numberValue(page, "Ordem"),
      title,
      pageId: page.id,
      week: numberValue(page, "Semana"),
      weekday: stringValue(page, "Dia da semana"),
      cycle: stringValue(page, "Ciclo"),
      focus: stringValue(page, "Foco"),
      complementary: stringValue(page, "Complementar"),
      questionGoal: goal,
      officialStatus: stringValue(page, "Status"),
      notionUpdatedAt: page.last_edited_time || "",
      material: { pageId: materialBundle.pageId, title: materialBundle.title, updatedAt: materialBundle.updatedAt, blocks: materialBundle.blocks },
      questionSet: {
        code: code.replace("D", "Q"),
        pageId: questionBundle.pageId,
        title: questionBundle.title,
        updatedAt: questionBundle.updatedAt,
        composition,
        items: versionedItems
      },
      reviewCode: reviewCode(stringValue(reviewPages.get(reviewPageId) || {}, "Dia")) || `R${String(numberValue(page, "Semana")).padStart(2, "0")}`,
      reviewPageId: reviewPageId || ""
    };
    const prior = previousDays.get(code);
    const versionedSet = versionEntity(dayPayload.questionSet, prior?.questionSet);
    dayPayload.questionSet = { ...dayPayload.questionSet, revision: versionedSet.revision, contentHash: versionedSet.contentHash };
    studyDays.push(versionEntity(dayPayload, prior));
  }

  const reviews = [];
  for (const page of weeklyPages) {
    const code = reviewCode(stringValue(page, "Dia"));
    const bundle = bundles.get(notionId(page.id)) || await fetchPageBundle(page.id);
    if (!code) throw new Error(`Revisão semanal sem identificador Rxx: ${stringValue(page, "Dia")}`);
    const payload = {
      code,
      order: numberValue(page, "Ordem"),
      week: numberValue(page, "Semana"),
      cycle: stringValue(page, "Ciclo"),
      title: stringValue(page, "Dia"),
      focus: stringValue(page, "Foco"),
      complementary: stringValue(page, "Complementar"),
      cumulativeCoverage: stringValue(page, "Revisão acumulada"),
      questionsGoal: numberValue(page, "Meta de questões"),
      pageId: page.id,
      updatedAt: bundle.updatedAt,
      blocks: bundle.blocks
    };
    reviews.push(versionEntity(payload, previousReviews.get(code)));
  }
  reviews.sort((a, b) => a.week - b.week);

  const restDays = restPages.map(page => {
    const week = numberValue(page, "Semana");
    const code = `REST-W${String(week).padStart(2, "0")}`;
    const payload = {
      code,
      week,
      order: numberValue(page, "Ordem"),
      cycle: stringValue(page, "Ciclo"),
      title: stringValue(page, "Dia"),
      weekday: stringValue(page, "Dia da semana"),
      focus: stringValue(page, "Foco"),
      note: stringValue(page, "Observações"),
      pageId: page.id,
      updatedAt: page.last_edited_time || ""
    };
    return versionEntity(payload, previousRestDays.get(code));
  });

  const cycleGroups = new Map();
  for (const day of studyDays) {
    const code = day.cycle || `C${String(Math.ceil(day.week / 3)).padStart(2, "0")}`;
    if (!cycleGroups.has(code)) cycleGroups.set(code, { code, weeks: new Set(), days: [] });
    cycleGroups.get(code).weeks.add(day.week);
    cycleGroups.get(code).days.push(day.code);
  }
  const cycles = [...cycleGroups.values()].sort((a, b) => a.code.localeCompare(b.code)).map(cycle => {
    const weeks = [...cycle.weeks].sort((a, b) => a - b);
    const payload = {
      code: cycle.code,
      weekStart: Math.min(...weeks),
      weekEnd: Math.max(...weeks),
      weeks,
      dayCodes: cycle.days,
      title: `${cycle.code} · semanas ${Math.min(...weeks)}–${Math.max(...weeks)}`
    };
    return versionEntity(payload, previousCycles.get(cycle.code));
  });

  const snapshot = {
    schemaVersion: 1,
    rootPageId: ROOT_PAGE_ID,
    meta: {
      generatedAt: new Date().toISOString(),
      sourceUpdatedAt,
      source: "Notion · HABA Study OS",
      sourceRootUrl: `https://www.notion.so/${ROOT_PAGE_ID.replaceAll("-", "")}`,
      contentVersion: "",
      counts: { studyDays: studyDays.length, reviews: reviews.length, restDays: restDays.length, cycles: cycles.length, questions: studyDays.reduce((sum, day) => sum + day.questionSet.items.length, 0) }
    },
    studyDays,
    reviews,
    restDays,
    cycles
  };
  snapshot.meta.contentVersion = sha256({ sourceUpdatedAt, counts: snapshot.meta.counts, studyDays, reviews, restDays, cycles });
  assertSnapshot(snapshot);
  return snapshot;
}

const previous = await readPrevious();
const snapshot = await buildSnapshot(previous);
const output = `${JSON.stringify(snapshot, null, 2)}\n`;
await mkdir(dirname(OUTPUT), { recursive: true });
const temporary = `${OUTPUT}.tmp`;
await writeFile(temporary, output, { encoding: "utf8", mode: 0o644 });
await rename(temporary, OUTPUT);
console.log(`Snapshot Notion validado: ${snapshot.meta.counts.studyDays} dias, ${snapshot.meta.counts.questions} questões, ${snapshot.meta.counts.reviews} revisões.`);
