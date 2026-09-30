import test from "node:test";
import assert from "node:assert/strict";
import { validateBackup } from "../site/src/backup.js";
import { STORE_KEYS } from "../site/src/storage.js";

const emptyStores = () => Object.fromEntries(Object.keys(STORE_KEYS).map(name => [name, []]));

test("backup accepts the current schema and all operational stores", () => {
  const value = { kind: "haba-study-os-backup", schemaVersion: 1, exportedAt: "2026-09-30T00:00:00Z", stores: emptyStores(), preferences: { theme: "dark" } };
  assert.equal(validateBackup(value), value);
});

test("backup rejects unsupported versions and records without stable keys", () => {
  assert.throws(() => validateBackup({ kind: "haba-study-os-backup", schemaVersion: 2, stores: {} }), /compatível/);
  const value = { kind: "haba-study-os-backup", schemaVersion: 1, stores: emptyStores() };
  value.stores.errors.push({ note: "sem questionId" });
  assert.throws(() => validateBackup(value), /registros inválidos em errors/);
});
