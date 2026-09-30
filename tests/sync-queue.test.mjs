import test from "node:test";
import assert from "node:assert/strict";
import { deferFailedOperation, isQueueItemDue, isSameSyncOperation, millisecondsUntilQueueDue } from "../site/src/sync-queue.js";

const now = Date.parse("2026-09-30T12:00:00.000Z");

function operation(overrides = {}) {
  const payload = { questionId: "Q-123", updatedAt: "2026-09-30T11:59:00.000Z", note: "versão inicial" };
  return { operationId: "ERROR-Q-123", entityId: "Q-123", payload, updatedAt: payload.updatedAt, status: "PENDING", attempts: 0, ...overrides };
}

test("failed syncs use increasing retry delays and keep the operation pending", () => {
  const first = deferFailedOperation(operation(), "falha temporária", now);
  assert.equal(first.status, "PENDING");
  assert.equal(first.attempts, 1);
  assert.equal(first.nextAttemptAt, new Date(now + 15_000).toISOString());
  assert.equal(first.lastError, "falha temporária");
  const second = deferFailedOperation(first, "falha temporária", now);
  assert.equal(second.attempts, 2);
  assert.equal(second.nextAttemptAt, new Date(now + 60_000).toISOString());
});

test("queue scheduler selects the earliest pending retry and ignores acknowledged work", () => {
  const future = operation({ nextAttemptAt: new Date(now + 90_000).toISOString() });
  const due = operation({ operationId: "ERROR-Q-456", entityId: "Q-456" });
  const completed = operation({ operationId: "ERROR-Q-789", status: "SYNCED" });
  assert.equal(isQueueItemDue(future, now), false);
  assert.equal(isQueueItemDue(due, now), true);
  assert.equal(millisecondsUntilQueueDue([future, completed], now), 90_000);
  assert.equal(millisecondsUntilQueueDue([completed], now), null);
});

test("an in-flight acknowledgement cannot remove a newer queued edit", () => {
  const attempted = operation();
  const current = { ...attempted, updatedAt: "2026-09-30T12:00:01.000Z", payload: { ...attempted.payload, updatedAt: "2026-09-30T12:00:01.000Z", note: "edição mais recente" } };
  assert.equal(isSameSyncOperation(attempted, attempted), true);
  assert.equal(isSameSyncOperation(current, attempted), false);
});
