/**
 * 轻量持久化：优先用 Logseq 的 FileStorage，退回 localStorage。
 * 所有调用都做防御式包装，任何一个 API 不存在都不会把插件带崩。
 */
(function (global) {
  const CP = (global.CP = global.CP || {});
  const PREFIX = "akyuu:";

  function fileStorage() {
    try {
      const fs = global.logseq && global.logseq.FileStorage;
      if (fs && typeof fs.getItem === "function" && typeof fs.setItem === "function") return fs;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  async function get(key) {
    const k = PREFIX + key;
    const fs = fileStorage();
    if (fs) {
      try {
        const raw = await fs.getItem(k);
        if (raw != null) return typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch (e) {
        /* fall through */
      }
    }
    try {
      const raw = global.localStorage && global.localStorage.getItem(k);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  async function set(key, value) {
    const k = PREFIX + key;
    const raw = JSON.stringify(value);
    const fs = fileStorage();
    if (fs) {
      try {
        await fs.setItem(k, raw);
        return true;
      } catch (e) {
        /* fall through */
      }
    }
    try {
      global.localStorage.setItem(k, raw);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function remove(key) {
    const k = PREFIX + key;
    const fs = fileStorage();
    if (fs && typeof fs.removeItem === "function") {
      try {
        await fs.removeItem(k);
      } catch (e) {
        /* ignore */
      }
    }
    try {
      global.localStorage.removeItem(k);
    } catch (e) {
      /* ignore */
    }
  }

  CP.store = { get: get, set: set, remove: remove };
})(typeof window !== "undefined" ? window : globalThis);
