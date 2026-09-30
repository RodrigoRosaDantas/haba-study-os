import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMentorAdvice, calculateAnalytics, calculateComposition, getNextMission,
  mergeRecords, scoreQuestionSet, upsertError
} from "../site/src/core.js";

test("70/30 composition uses the actual planned count", () => {
  assert.deepEqual(calculateComposition(12), { total: 12, main: 8, complementary: 4 });
  assert.deepEqual(calculateComposition(25), { total: 25, main: 18, complementary: 7 });
  assert.deepEqual(calculateComposition(0), { total: 0, main: 0, complementary: 0 });
});

test("the next mission follows editorial order rather than calendar time", () => {
  const days = [
    { code: "D01", order: 1, title: "D01", week: 1, questionCode: "Q01" },
    { code: "D02", order: 2, title: "D02", week: 1, questionCode: "Q02" }
  ];
  const reviews = [{ code: "R01", week: 1, title: "R01" }];
  assert.equal(getNextMission(days, reviews).code, "D01");
  assert.equal(getNextMission(days, reviews, [{ id: "D01", completedAt: "2026-09-30" }]).code, "Q01");
  assert.equal(getNextMission(days, reviews, [
    { id: "D01", completedAt: "2026-09-01" }, { id: "Q01", completedAt: "2026-09-02" },
    { id: "D02", completedAt: "2026-09-03" }, { id: "Q02", completedAt: "2026-09-04" }
  ]).code, "R01");
});

test("days with no usable source questions do not block the next editorial day", () => {
  const days = [
    { code: "D01", order: 1, title: "D01", week: 1, questionSet: { items: [] } },
    { code: "D02", order: 2, title: "D02", week: 1, questionSet: { items: [{ questionId: "q2" }] } }
  ];
  const reviews = [{ code: "R01", week: 1, title: "R01" }];
  const progress = [{ id: "D01", completedAt: "2026-09-01" }];
  assert.equal(getNextMission(days, reviews, progress).code, "D02");
  assert.equal(progress.some(row => row.id === "Q01"), false);
});

test("question scoring does not count unanswered questions as wrong", () => {
  const items = [{ questionId: "a", answerKey: "A" }, { questionId: "b", answerKey: "B" }, { questionId: "c", answerKey: "C" }];
  assert.deepEqual(scoreQuestionSet(items, { a: "A", b: "D" }), {
    total: 3, scoredTotal: 3, answered: 2, correct: 1, incorrect: 1, unanswered: 1, accuracy: 50
  });
  assert.equal(scoreQuestionSet(items, {}).accuracy, null);
});

test("Error Lab upserts by stable Question ID and preserves first-error data", () => {
  const first = upsertError(null, { questionId: "Q-123", setCode: "Q01", dayCode: "D01", answerKey: "B" }, "A", "2026-09-01T10:00:00Z");
  const repeated = upsertError(first, { questionId: "Q-123", setCode: "Q01", dayCode: "D01", answerKey: "B" }, "C", "2026-09-02T10:00:00Z");
  assert.equal(repeated.questionId, "Q-123");
  assert.equal(repeated.errorId, first.errorId);
  assert.equal(repeated.firstErrorAt, first.firstErrorAt);
  assert.equal(repeated.errorCount, 2);
  assert.equal(repeated.repeated, true);
  assert.equal(repeated.status, "REPEATED");
});

test("analytics represent no data as unknown and withhold thin trends", () => {
  const empty = calculateAnalytics([], [], [], [{ code: "D01" }], []);
  assert.equal(empty.questionCount, 0);
  assert.equal(empty.accuracy, null);
  assert.equal(empty.studyMinutes, 0);
  const small = calculateAnalytics([], [{ subject: "Redes", isCorrect: true }], [], [], []);
  assert.equal(small.subjects[0].accuracy, 100);
  assert.equal(small.subjects[0].trend, "insufficient-sample");
  const partial = calculateAnalytics([{ questionSet: "Q01", completedAt: "2026-09-01", coverageStatus: "partial" }], [], [], [], []);
  assert.equal(partial.completedQuestionSets, 0);
  assert.equal(partial.partialQuestionSets, 1);
});

test("mentor advice cites the basis and does not assert mastery", () => {
  const advice = buildMentorAdvice(null, calculateAnalytics([], [], [], [], []), [], []);
  assert.equal(typeof advice.action, "string");
  assert.equal(typeof advice.reason, "string");
  assert.equal(typeof advice.evidence, "string");
  assert.doesNotMatch(advice.reason, /domina|fraqueza/i);
});

test("backup merge uses the most recent record for the same key", () => {
  const merged = mergeRecords([{ id: "a", updatedAt: "2026-09-01" }, { id: "b", updatedAt: "2026-09-02" }], [{ id: "a", updatedAt: "2026-09-03" }, { id: "c", updatedAt: "2026-09-03" }]);
  assert.deepEqual(merged.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: "a", updatedAt: "2026-09-03" }, { id: "b", updatedAt: "2026-09-02" }, { id: "c", updatedAt: "2026-09-03" }
  ]);
});
