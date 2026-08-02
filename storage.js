/**
 * storage.js
 * ------------------------------------------------------------------
 * データ永続化層（Repository / Storage Adapter パターン）
 *
 * 画面側（app.js）は、この StorageAdapter が定義するメソッドのみを呼び出す。
 * 将来 IndexedDB から Supabase 等へ移行する場合は、
 * このファイルの実装（IndexedDBAdapter）を SupabaseAdapter に差し替えるだけで良い設計。
 * ------------------------------------------------------------------
 */

const DB_NAME = 'bottleKeepDB';
const DB_VERSION = 1;

const STORE_NAMES = {
  customers: 'customers',
  bottles: 'bottles',
  visits: 'visits',
  disposalHistory: 'disposalHistory',
  operationLogs: 'operationLogs',
  settings: 'settings',
};

/**
 * 抽象インターフェース。将来 SupabaseAdapter 等を作る際は
 * 同じメソッド名・シグネチャで実装すること。
 */
class StorageAdapter {
  async init() { throw new Error('not implemented'); }

  // customers
  async getAllCustomers() { throw new Error('not implemented'); }
  async getCustomer(id) { throw new Error('not implemented'); }
  async putCustomer(customer) { throw new Error('not implemented'); }
  async deleteCustomer(id) { throw new Error('not implemented'); }

  // bottles
  async getAllBottles() { throw new Error('not implemented'); }
  async getBottle(id) { throw new Error('not implemented'); }
  async putBottle(bottle) { throw new Error('not implemented'); }
  async deleteBottle(id) { throw new Error('not implemented'); }

  // visits
  async getAllVisits() { throw new Error('not implemented'); }
  async getVisitsByCustomer(customerId) { throw new Error('not implemented'); }
  async putVisit(visit) { throw new Error('not implemented'); }

  // disposalHistory
  async getAllDisposalHistory() { throw new Error('not implemented'); }
  async putDisposalHistory(entry) { throw new Error('not implemented'); }
  async deleteDisposalHistory(id) { throw new Error('not implemented'); }

  // operationLogs
  async getAllOperationLogs() { throw new Error('not implemented'); }
  async putOperationLog(log) { throw new Error('not implemented'); }
  async deleteOperationLog(id) { throw new Error('not implemented'); }

  // settings
  async getSettings() { throw new Error('not implemented'); }
  async putSettings(settings) { throw new Error('not implemented'); }

  // bulk (for backup / restore / CSV import)
  async exportAll() { throw new Error('not implemented'); }
  async importAll(data) { throw new Error('not implemented'); }
  async clearAll() { throw new Error('not implemented'); }
}

class IndexedDBAdapter extends StorageAdapter {
  constructor() {
    super();
    this.db = null;
  }

  init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(STORE_NAMES.customers)) {
          db.createObjectStore(STORE_NAMES.customers, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.bottles)) {
          const store = db.createObjectStore(STORE_NAMES.bottles, { keyPath: 'id' });
          store.createIndex('customerId', 'customerId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.visits)) {
          const store = db.createObjectStore(STORE_NAMES.visits, { keyPath: 'id' });
          store.createIndex('customerId', 'customerId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.disposalHistory)) {
          db.createObjectStore(STORE_NAMES.disposalHistory, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.operationLogs)) {
          db.createObjectStore(STORE_NAMES.operationLogs, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.settings)) {
          db.createObjectStore(STORE_NAMES.settings, { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  _tx(storeName, mode = 'readonly') {
    return this.db.transaction(storeName, mode).objectStore(storeName);
  }

  _getAll(storeName) {
    return new Promise((resolve, reject) => {
      const req = this._tx(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  _get(storeName, key) {
    return new Promise((resolve, reject) => {
      const req = this._tx(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  _put(storeName, value) {
    return new Promise((resolve, reject) => {
      const req = this._tx(storeName, 'readwrite').put(value);
      req.onsuccess = () => resolve(value);
      req.onerror = () => reject(req.error);
    });
  }

  _delete(storeName, key) {
    return new Promise((resolve, reject) => {
      const req = this._tx(storeName, 'readwrite').delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  _clear(storeName) {
    return new Promise((resolve, reject) => {
      const req = this._tx(storeName, 'readwrite').clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ---- customers ----
  getAllCustomers() { return this._getAll(STORE_NAMES.customers); }
  getCustomer(id) { return this._get(STORE_NAMES.customers, id); }
  putCustomer(customer) { return this._put(STORE_NAMES.customers, customer); }
  deleteCustomer(id) { return this._delete(STORE_NAMES.customers, id); }

  // ---- bottles ----
  getAllBottles() { return this._getAll(STORE_NAMES.bottles); }
  getBottle(id) { return this._get(STORE_NAMES.bottles, id); }
  putBottle(bottle) { return this._put(STORE_NAMES.bottles, bottle); }
  deleteBottle(id) { return this._delete(STORE_NAMES.bottles, id); }

  // ---- visits ----
  getAllVisits() { return this._getAll(STORE_NAMES.visits); }
  async getVisitsByCustomer(customerId) {
    const all = await this.getAllVisits();
    return all.filter(v => v.customerId === customerId);
  }
  putVisit(visit) { return this._put(STORE_NAMES.visits, visit); }

  // ---- disposalHistory ----
  getAllDisposalHistory() { return this._getAll(STORE_NAMES.disposalHistory); }
  putDisposalHistory(entry) { return this._put(STORE_NAMES.disposalHistory, entry); }
  deleteDisposalHistory(id) { return this._delete(STORE_NAMES.disposalHistory, id); }

  // ---- operationLogs ----
  getAllOperationLogs() { return this._getAll(STORE_NAMES.operationLogs); }
  putOperationLog(log) { return this._put(STORE_NAMES.operationLogs, log); }
  deleteOperationLog(id) { return this._delete(STORE_NAMES.operationLogs, id); }

  // ---- settings ----
  // settings は key-value 形式（key: 'main'）で1レコードにまとめて保持
  async getSettings() {
    const rec = await this._get(STORE_NAMES.settings, 'main');
    if (rec) return rec.value;
    return null;
  }
  putSettings(settings) {
    return this._put(STORE_NAMES.settings, { key: 'main', value: settings });
  }

  // ---- bulk ----
  async exportAll() {
    const [customers, bottles, visits, disposalHistory, operationLogs, settings] = await Promise.all([
      this.getAllCustomers(),
      this.getAllBottles(),
      this.getAllVisits(),
      this.getAllDisposalHistory(),
      this.getAllOperationLogs(),
      this.getSettings(),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      version: DB_VERSION,
      customers, bottles, visits, disposalHistory, operationLogs, settings,
    };
  }

  async importAll(data) {
    await this.clearAll();
    const stores = [
      ['customers', STORE_NAMES.customers],
      ['bottles', STORE_NAMES.bottles],
      ['visits', STORE_NAMES.visits],
      ['disposalHistory', STORE_NAMES.disposalHistory],
      ['operationLogs', STORE_NAMES.operationLogs],
    ];
    for (const [key, storeName] of stores) {
      const list = data[key] || [];
      for (const item of list) {
        await this._put(storeName, item);
      }
    }
    if (data.settings) {
      await this.putSettings(data.settings);
    }
  }

  async clearAll() {
    await Promise.all([
      this._clear(STORE_NAMES.customers),
      this._clear(STORE_NAMES.bottles),
      this._clear(STORE_NAMES.visits),
      this._clear(STORE_NAMES.disposalHistory),
      this._clear(STORE_NAMES.operationLogs),
      this._clear(STORE_NAMES.settings),
    ]);
  }
}

// グローバルに公開（app.js から参照）
window.BottleKeepStorage = {
  IndexedDBAdapter,
  STORE_NAMES,
};
