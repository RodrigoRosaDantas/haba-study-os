import test from "node:test";
import assert from "node:assert/strict";
import { validateBackup } from "../site/src/backup.js";
import { STORE_KEYS } from "../site/src/storage.js";
import { deduplicateRecords, mergeIntoStores } from "../site/src/storage.js";

const emptyStores = () => Object.fromEntries(Object.keys(STORE_KEYS).map(name => [name, []]));

test("backup accepts the current schema and all operational stores", () => {
  const value = { kind: "haba-study-os-backup", schemaVersion: 1, exportedAt: "2026-09-30T00:00:00Z", stores: emptyStores(), preferences: { theme: "dark" } };
  assert.equal(validateBackup(value), value);
  assert.equal(STORE_KEYS.errors, "questionId");
  assert.equal(STORE_KEYS.sync_queue, undefined);
});

test("backup remains compatible with legacy sync queue data without restoring that store", () => {
  const value = { kind: "haba-study-os-backup", schemaVersion: 1, stores: { ...emptyStores(), sync_queue: [{ operationId: "ERROR-Q01" }] } };
  assert.equal(validateBackup(value), value);
  assert.equal(Object.hasOwn(STORE_KEYS, "sync_queue"), false);
});

test("a backup containing only the retired queue is ignored safely", async () => {
  assert.equal(await mergeIntoStores({ sync_queue: [{ operationId: "ERROR-Q01" }] }), 0);
});

test("backup rejects unsupported versions and records without stable keys", () => {
  assert.throws(() => validateBackup({ kind: "haba-study-os-backup", schemaVersion: 2, stores: {} }), /compatível/);
  const value = { kind: "haba-study-os-backup", schemaVersion: 1, stores: emptyStores() };
  value.stores.errors.push({ note: "sem questionId" });
  assert.throws(() => validateBackup(value), /registros inválidos em errors/);
});

test("backup merge keeps the newest duplicate record regardless of file order", () => {
  const rows = [
    { questionId: "Q01-1", lastErrorAt: "2026-09-02T10:00:00Z", note: "mais recente" },
    { questionId: "Q01-1", lastErrorAt: "2026-09-01T10:00:00Z", note: "antigo" }
  ];
  assert.deepEqual(deduplicateRecords(rows, "questionId"), [rows[0]]);
  assert.deepEqual(deduplicateRecords([...rows].reverse(), "questionId"), [rows[0]]);
});
