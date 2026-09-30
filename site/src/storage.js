export const DB_NAME = "haba-study-os";
export const DB_VERSION = 2;

export const STORE_KEYS = Object.freeze({
  study_sessions: "sessionId",
  question_attempts: "attemptId",
  question_answers: "answerId",
  errors: "questionId",
  revisions: "revisionId",
  progress: "id",
  reading_progress: "pageId",
  content_versions: "entityId",
  backups: "backupId"
});

let databasePromise;

export function openDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("Este navegador não disponibiliza IndexedDB."));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;
      if (db.objectStoreNames.contains("sync_queue")) db.deleteObjectStore("sync_queue");
      for (const [name, keyPath] of Object.entries(STORE_KEYS)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
      if (tx && tx.objectStoreNames.contains("question_answers")) {
        const answers = tx.objectStore("question_answers");
        if (!answers.indexNames.contains("attemptId")) answers.createIndex("attemptId", "attemptId", { unique: false });
        if (!answers.indexNames.contains("questionId")) answers.createIndex("questionId", "questionId", { unique: false });
      }
      if (tx && tx.objectStoreNames.contains("question_attempts")) {
        const attempts = tx.objectStore("question_attempts");
        if (!attempts.indexNames.contains("questionSet")) attempts.createIndex("questionSet", "questionSet", { unique: false });
      }
      if (tx && tx.objectStoreNames.contains("errors")) {
        const errors = tx.objectStore("errors");
        if (!errors.indexNames.contains("status")) errors.createIndex("status", "status", { unique: false });
        if (!errors.indexNames.contains("nextReviewAt")) errors.createIndex("nextReviewAt", "nextReviewAt", { unique: false });
        const cursorRequest = errors.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const value = cursor.value;
          for (const field of ["syncStatus", "notionPageId", "notionUpdatedAt", "questionRevision"]) delete value[field];
          cursor.update(value);
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error || new Error("Não foi possível abrir o banco local."));
    };
    request.onblocked = () => reject(new Error("Feche outra aba do HABA Study OS para concluir a atualização local."));
  });
  return databasePromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Falha ao acessar o banco local."));
  });
}

export async function getRecord(storeName, key) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readonly");
  return requestResult(tx.objectStore(storeName).get(key));
}

export async function getAllRecords(storeName) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readonly");
  return requestResult(tx.objectStore(storeName).getAll());
}

export async function putRecord(storeName, record) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readwrite");
  const request = tx.objectStore(storeName).put(record);
  const key = await requestResult(request);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("Falha ao salvar no banco local."));
    tx.onabort = () => reject(tx.error || new Error("A gravação local foi cancelada."));
  });
  return key;
}

export async function deleteRecord(storeName, key) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).delete(key);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("Falha ao remover o registro local."));
    tx.onabort = () => reject(tx.error || new Error("A remoção local foi cancelada."));
  });
}

export async function updateErrorRecord(questionId, updater) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("errors", "readwrite");
    const store = tx.objectStore("errors");
    let updated;
    const request = store.get(questionId);
    request.onsuccess = () => {
      try {
        updated = updater(request.result || null);
        store.put(updated);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    request.onerror = () => reject(request.error || new Error("Falha ao ler o erro local."));
    tx.oncomplete = () => resolve(updated);
    tx.onerror = () => reject(tx.error || new Error("Falha ao atualizar o Error Lab."));
    tx.onabort = () => reject(tx.error || new Error("A atualização do Error Lab foi cancelada."));
  });
}

export async function exportStores() {
  const db = await openDatabase();
  const names = Object.keys(STORE_KEYS);
  const tx = db.transaction(names, "readonly");
  const requests = Object.fromEntries(names.map(name => [name, requestResult(tx.objectStore(name).getAll())]));
  const values = await Promise.all(Object.values(requests));
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

function timestampOf(record) {
  const value = record?.updatedAt || record?.finishedAt || record?.createdAt || record?.exportedAt || "";
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

export async function mergeIntoStores(stores) {
  const names = Object.keys(STORE_KEYS).filter(name => Array.isArray(stores?.[name]));
  if (!names.length) return 0;
  const db = await openDatabase();
  let merged = 0;
  const tx = db.transaction(names, "readwrite");
  for (const name of names) {
    const keyPath = STORE_KEYS[name];
    const store = tx.objectStore(name);
    for (const incoming of stores[name]) {
      if (!incoming || incoming[keyPath] === undefined || incoming[keyPath] === null) continue;
      const getRequest = store.get(incoming[keyPath]);
      getRequest.onsuccess = () => {
        const current = getRequest.result;
        if (!current || timestampOf(incoming) >= timestampOf(current)) {
          store.put(incoming);
          merged += 1;
        }
      };
    }
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("Falha ao mesclar o backup."));
    tx.onabort = () => reject(tx.error || new Error("A mesclagem do backup foi cancelada."));
  });
  return merged;
}
