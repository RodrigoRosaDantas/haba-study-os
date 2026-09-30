const KEY = "haba:preferences";
const DEFAULTS = Object.freeze({ theme: "dark", fontSize: "normal", readerWidth: "wide", focusMode: false, filters: {}, lastRoute: "today", lastModule: "" });

export function readPreferences(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) || "{}");
    return { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePreferences(patch, storage = globalThis.localStorage, now = new Date().toISOString()) {
  const next = { ...readPreferences(storage), ...patch, updatedAt: now };
  storage?.setItem(KEY, JSON.stringify(next));
  return next;
}

export function preferenceBackup(storage = globalThis.localStorage) {
  return readPreferences(storage);
}

export function restorePreferences(incoming, storage = globalThis.localStorage) {
  const current = readPreferences(storage);
  const currentTime = Date.parse(current.updatedAt || "") || 0;
  const incomingTime = Date.parse(incoming?.updatedAt || "") || 0;
  const selected = incomingTime >= currentTime ? { ...DEFAULTS, ...incoming } : current;
  storage?.setItem(KEY, JSON.stringify(selected));
  return selected;
}
