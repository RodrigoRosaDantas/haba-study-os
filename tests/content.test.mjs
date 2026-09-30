import test from "node:test";
import assert from "node:assert/strict";
import { validateContentSnapshot } from "../site/src/content.js";

function snapshotFixture() {
  const studyDays = Array.from({ length: 75 }, (_, index) => {
    const ordinal = index + 1;
    const code = `D${String(ordinal).padStart(2, "0")}`;
    const questionCode = `Q${String(ordinal).padStart(2, "0")}`;
    return {
      code, order: ordinal, week: Math.ceil(ordinal / 5), cycle: `C${String(Math.ceil(Math.ceil(ordinal / 5) / 3)).padStart(2, "0")}`,
      questionGoal: 1, material: { pageId: `page-${code}`, blocks: [{ type: "paragraph" }] },
      questionSet: { code: questionCode, pageId: `page-${questionCode}`, composition: { total: 1, main: 1, complementary: 0 }, sourceStatus: "complete", availableCount: 1, sourceRowCount: 1, missingCount: 0, extraCount: 0, unavailableItems: [], items: [{ questionId: `id-${ordinal}`, stem: "Enunciado", answerKey: "A", sourceValidated: true, status: "Pronta para estudo", options: [{ key: "A", text: "Correta" }, { key: "B", text: "Outra" }] }] }
    };
  });
  return {
    schemaVersion: 2,
    meta: { generatedAt: "2026-09-30T00:00:00Z", contentVersion: "abc", questionCoverage: { status: "complete", completeSets: 75, partialSets: 0, unavailableSets: 0, totalSets: 75, usableQuestions: 75, plannedQuestions: 75, excludedRows: 0, missingRows: 0 } },
    studyDays,
    reviews: Array.from({ length: 15 }, (_, index) => ({ code: `R${String(index + 1).padStart(2, "0")}`, blocks: [{ type: "paragraph" }] })),
    restDays: Array.from({ length: 15 }, (_, index) => ({ code: `REST-W${String(index + 1).padStart(2, "0")}` })),
    cycles: Array.from({ length: 5 }, (_, index) => ({ code: `C${String(index + 1).padStart(2, "0")}` }))
  };
}

test("content snapshot validation accepts a complete ordered source", () => {
  assert.equal(validateContentSnapshot(snapshotFixture()), true);
});

test("content snapshot validation rejects missing days and malformed answer keys", () => {
  const shortened = snapshotFixture();
  shortened.studyDays.pop();
  assert.throws(() => validateContentSnapshot(shortened), /75 dias/);
  const malformed = snapshotFixture();
  malformed.studyDays[0].questionSet.items[0].answerKey = "";
  assert.throws(() => validateContentSnapshot(malformed), /questão incompleta no player/);
});

test("content snapshot represents unavailable source batteries without inventing questions", () => {
  const partial = snapshotFixture();
  const set = partial.studyDays[0].questionSet;
  set.items = [];
  set.sourceStatus = "unavailable";
  set.availableCount = 0;
  set.sourceRowCount = 0;
  set.missingCount = 1;
  partial.meta.questionCoverage = { status: "partial", completeSets: 74, partialSets: 0, unavailableSets: 1, totalSets: 75, usableQuestions: 74, plannedQuestions: 75, excludedRows: 0, missingRows: 1 };
  assert.equal(validateContentSnapshot(partial), true);
  set.sourceStatus = "complete";
  assert.throws(() => validateContentSnapshot(partial), /status de disponibilidade inconsistente/);
});
