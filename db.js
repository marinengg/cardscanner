// Tiny IndexedDB wrapper for storing scanned business cards locally on this device.
const DB_NAME = "cardscanner-db";
const DB_VERSION = 1;
const STORE = "cards";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = fn(store);
    tx.oncomplete = () => resolve(result && result.__result !== undefined ? result.__result : result);
    tx.onerror = () => reject(tx.error);
  });
}

const CardDB = {
  async getAll() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = req.result || [];
        rows.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async get(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async put(card) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(card);
      tx.oncomplete = () => resolve(card);
      tx.onerror = () => reject(tx.error);
    });
  },

  async delete(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  },

  // Adds cards from an import, skipping any id already present. Returns {added, skipped}.
  async importMany(cards) {
    const existing = await this.getAll();
    const existingIds = new Set(existing.map((c) => c.id));
    let added = 0, skipped = 0;
    for (const card of cards) {
      if (!card || !card.id) { skipped++; continue; }
      if (existingIds.has(card.id)) { skipped++; continue; }
      await this.put(card);
      existingIds.add(card.id);
      added++;
    }
    return { added, skipped };
  }
};
