import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSnapshot, flattenBlockText, makeQuestionItem, notionId, parseComposition, parseOptions,
  normalizeBlock, plainRichText, propertyValue, questionItemIssues, versionEntity
} from "../scripts/notion-sync-lib.mjs";

test("Notion rich text properties normalize without losing plain text", () => {
  const page = { properties: { Name: { type: "title", title: [{ plain_text: "D01" }] }, Foco: { type: "rich_text", rich_text: [{ plain_text: "Lógica" }, { plain_text: " de programação" }] } } };
  assert.equal(propertyValue(page, "Name"), "D01");
  assert.equal(propertyValue(page, "Foco"), "Lógica de programação");
  assert.equal(plainRichText([{ plain_text: "texto" }]), "texto");
});

test("Notion page identifiers can be recovered from IDs and URLs", () => {
  assert.equal(notionId("3dfcf5a267318101ba23e9e801a54a2c"), "3dfcf5a267318101ba23e9e801a54a2c");
  assert.equal(notionId("https://app.notion.com/p/3dfcf5a267318101ba23e9e801a54a2c"), "3dfcf5a267318101ba23e9e801a54a2c");
});

test("battery composition and alternatives preserve the actual question plan", () => {
  assert.deepEqual(parseComposition("Meta do dia: 12 questões; Bateria montada: 8 principais + 4 complementares = 12", 12), { main: 8, complementary: 4, total: 12, source: "notion" });
  assert.deepEqual(parseOptions("A) uma | B) duas | C) três"), [
    { key: "A", text: "uma" }, { key: "B", text: "duas" }, { key: "C", text: "três" }
  ]);
});

test("page normalization flattens nested block text for official composition checks", () => {
  assert.match(flattenBlockText([{ richText: [{ text: "Bateria montada:" }], children: [{ richText: [{ text: "8 principais + 4 complementares = 12" }] }] }]), /8 principais \+ 4 complementares/);
});

test("child page titles remain intact when the Notion API returns a plain string", () => {
  const child = normalizeBlock({ id: "child-1", type: "child_page", child_page: { title: "Página interna" } });
  assert.equal(child.title, "Página interna");
  assert.deepEqual(child.richText, []);
});

test("stable entity revisions change only when editorial payload changes", () => {
  const first = versionEntity({ code: "D01", title: "Base" }, null);
  const same = versionEntity({ code: "D01", title: "Base" }, first);
  const revised = versionEntity({ code: "D01", title: "Base revista" }, same);
  assert.equal(first.revision, 1);
  assert.equal(same.revision, 1);
  assert.equal(same.contentHash, first.contentHash);
  assert.equal(revised.revision, 2);
  assert.notEqual(revised.contentHash, first.contentHash);
});

test("question items retain stable source IDs and the paraphrase label metadata", () => {
  const page = {
    id: "notion-page",
    last_edited_time: "2026-09-30T00:00:00Z",
    properties: {
      "Questão": { type: "title", title: [{ plain_text: "Q1" }] },
      "ID original": { type: "rich_text", rich_text: [{ plain_text: "ORIG-01" }] },
      "Gabarito": { type: "rich_text", rich_text: [{ plain_text: "B" }] },
      "Alternativas resumidas": { type: "rich_text", rich_text: [{ plain_text: "A) uma | B) duas" }] },
      "Enunciado parafraseado": { type: "rich_text", rich_text: [{ plain_text: "Pergunta resumida" }] }
    }
  };
  const item = makeQuestionItem(page, "Q01", 1);
  assert.equal(item.questionId, "ORIG-01");
  assert.equal(item.answerKey, "B");
  assert.equal(item.stem, "Pergunta resumida");
  assert.equal(item.options.length, 2);
});

test("incomplete Notion questions are excluded with an explicit reason", () => {
  const issueList = questionItemIssues({ questionId: "Q-2", stem: "Resumo", answerKey: "A", options: [], sourceValidated: true, status: "Pronta para estudo" });
  assert.deepEqual(issueList, ["unusable_options"]);
  assert.ok(questionItemIssues({ questionId: "Q-3", stem: "", answerKey: "", options: [], sourceValidated: false, status: "Revisar gabarito" }).includes("missing_stem"));
});

test("snapshot validator rejects truncated source material", () => {
  assert.throws(() => assertSnapshot({ studyDays: [], reviews: [], restDays: [], cycles: [] }), /esperados 75 dias/);
});


test("option parsing preserves semicolons inside code and accepts semicolon separators", () => {
  assert.deepEqual(parseOptions('A) if (saldo < retirada) { aviso("Saldo insuficiente."); } | B) if (outro < limite) { aviso("Outro."); }'), [
    { key: "A", text: 'if (saldo < retirada) { aviso("Saldo insuficiente."); }' },
    { key: "B", text: 'if (outro < limite) { aviso("Outro."); }' }
  ]);
  assert.deepEqual(parseOptions("A) primeira; B) segunda;C) terceira"), [
    { key: "A", text: "primeira" },
    { key: "B", text: "segunda" },
    { key: "C", text: "terceira" }
  ]);
});
