import { exportStores, mergeIntoStores, STORE_KEYS } from "./storage.js";
import { preferenceBackup, restorePreferences } from "./preferences.js";

export const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

export async function createBackup(now = new Date().toISOString()) {
  return {
    kind: "haba-study-os-backup",
    schemaVersion: BACKUP_VERSION,
    exportedAt: now,
    stores: await exportStores(),
    preferences: preferenceBackup()
  };
}

export function validateBackup(value) {
  if (!value || value.kind !== "haba-study-os-backup" || value.schemaVersion !== BACKUP_VERSION || !value.stores || typeof value.stores !== "object") {
    throw new Error("Esse arquivo não corresponde a um backup HABA Study OS compatível.");
  }
  for (const [store, keyPath] of Object.entries(STORE_KEYS)) {
    const rows = value.stores[store];
    if (rows !== undefined && (!Array.isArray(rows) || rows.some(row => !row || row[keyPath] == null))) {
      throw new Error(`O backup tem registros inválidos em ${store}.`);
    }
  }
  if (value.preferences && typeof value.preferences !== "object") throw new Error("As preferências do backup são inválidas.");
  return value;
}

export async function restoreBackupText(text) {
  const rawText = String(text || "");
  if (new Blob([rawText]).size > MAX_BACKUP_BYTES) throw new Error("O arquivo excede o limite de 20 MB.");
  let decoded;
  try { decoded = JSON.parse(rawText); } catch { throw new Error("O arquivo selecionado não contém JSON válido."); }
  const backup = validateBackup(decoded);
  const merged = await mergeIntoStores(backup.stores);
  if (backup.preferences) restorePreferences(backup.preferences);
  return { merged, exportedAt: backup.exportedAt };
}

export async function downloadBackup() {
  const backup = await createBackup();
  const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `haba-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return backup;
}
