/**
 * 工作区：让「用户图谱」成为 Akyuu 的地盘。
 *
 *  - 图谱信息：logseq.App.getCurrentGraph()（拿不到就退回设置里的图谱名）
 *  - 会话落盘：优先 logseq.Assets.makeSandboxStorage()（写在图谱目录内的插件存储里），
 *    其次 logseq.FileStorage（同样是图谱内的宿主存储），最后才退回 localStorage。
 *  - 每个会话写两份：`akyuu-session-<id>.json`（机器读）+ `.md`（人读，直接当笔记看）。
 *
 * 说明：插件不能自选绝对路径 —— 文件存哪个目录由 Logseq 宿主决定，
 * 我们只能保证它在图谱目录内部，并把「目录名」如实告诉用户。
 */
(function (global) {
  const CP = (global.CP = global.CP || {});
  const ls = () => global.logseq;

  const PREFIX = "akyuu-session-";
  const DIR = "sessions/"; // Logseq 允许 key 带 /，宿主会真的建子目录
  const INDEX_KEY = DIR + "index.json";
  const MAX_SESSIONS = 100;
  const VERSION = 1;
  const PLUGIN_ID = "logseq-akyuu";

  let rid = 0;

  /* ------------------------------ 后端存储 ------------------------------ */

  let backendPromise = null;

  async function backend() {
    if (backendPromise) return backendPromise;
    backendPromise = (async () => {
      const A = ls() && ls().Assets;
      if (A && typeof A.makeSandboxStorage === "function") {
        try {
          const st = await A.makeSandboxStorage();
          if (st && typeof st.setItem === "function" && typeof st.getItem === "function") {
            return { kind: "assets", label: "图谱 assets 存储", storage: st };
          }
        } catch (e) {
          /* 老版本没有沙箱存储，往下退 */
        }
      }
      const fs = ls() && ls().FileStorage;
      if (fs && typeof fs.setItem === "function" && typeof fs.getItem === "function") {
        return { kind: "plugin", label: "图谱插件存储", storage: fs };
      }
      return { kind: "local", label: "浏览器本地存储（未落盘到图谱）", storage: null };
    })();
    return backendPromise;
  }

  async function kvGet(key) {
    const b = await backend();
    if (b.storage) {
      try {
        const raw = await b.storage.getItem(key);
        if (raw == null) return null;
        if (typeof raw === "string") {
          try {
            return JSON.parse(raw);
          } catch (e) {
            return raw;
          }
        }
        return raw;
      } catch (e) {
        /* fall through */
      }
    }
    try {
      const raw = global.localStorage && global.localStorage.getItem("akyuu:" + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 写文件。返回 "file"（真的落到磁盘）/ "local"（退回浏览器存储）/ false。
   * 区分这两者很重要：用户想要的是「会话在图谱目录里」，而不是「在浏览器缓存里」。
   */
  async function kvWrite(key, raw) {
    const b = await backend();
    if (b.storage) {
      try {
        await b.storage.setItem(key, raw);
        return "file";
      } catch (e) {
        /* 写盘失败：退回本地存储，但要让上层知道 */
      }
    }
    try {
      global.localStorage.setItem("akyuu:" + key, raw);
      return "local";
    } catch (e) {
      return false;
    }
  }

  function kvSet(key, value) {
    return kvWrite(key, JSON.stringify(value));
  }

  /** 原样写文本（给 .md 用：JSON.stringify 会把换行转义成 \n，人就没法读了） */
  function kvSetRaw(key, text) {
    return kvWrite(key, String(text == null ? "" : text));
  }

  async function kvRemove(key) {
    const b = await backend();
    if (b.storage && typeof b.storage.removeItem === "function") {
      try {
        await b.storage.removeItem(key);
      } catch (e) {
        /* ignore */
      }
    }
    try {
      global.localStorage.removeItem("akyuu:" + key);
    } catch (e) {
      /* ignore */
    }
  }

  async function allKeys() {
    const b = await backend();
    if (b.storage && typeof b.storage.allKeys === "function") {
      try {
        const keys = await b.storage.allKeys();
        return Array.isArray(keys) ? keys : [];
      } catch (e) {
        /* ignore */
      }
    }
    return [];
  }

  /* ------------------------------ 图谱信息 ------------------------------ */

  let graphCache = null;

  async function graph() {
    if (graphCache) return graphCache;
    let g = null;
    try {
      if (ls() && ls().App && typeof ls().App.getCurrentGraph === "function") {
        g = await ls().App.getCurrentGraph();
      }
    } catch (e) {
      g = null;
    }
    const name = (g && (g.name || g.graph)) || "";
    const path = (g && (g.path || g.url)) || "";
    graphCache = { name: name || "未命名图谱", path: path || "", raw: g || null };
    return graphCache;
  }

  /**
   * 给用户看的「工作区在哪」。
   * 依据 Logseq 宿主实现（src/main/logseq/api/plugin.cljs）：
   *   assets 存储 → <图谱>/assets/storages/<插件 id>/<key>
   *   普通 FileStorage → ~/.logseq/storages/<插件 id>/<key>（不在图谱里，所以只作为兜底）
   */
  async function folder() {
    const b = await backend();
    const g = await graph();
    const rel =
      b.kind === "assets" ? "assets/storages/" + PLUGIN_ID + "/sessions" : b.kind === "plugin" ? "storages/" + PLUGIN_ID + "/sessions" : "";
    const base = b.kind === "plugin" ? "~/.logseq" : g.path;
    return {
      kind: b.kind,
      label: b.label,
      graph: g.name,
      path: g.path,
      dir: rel ? (base ? joinPath(base, rel) : rel) : "",
      hint:
        b.kind === "local"
          ? "会话只存在浏览器里（这个 Logseq 版本不允许插件写图谱文件）"
          : b.kind === "plugin"
          ? "注意：这台 Logseq 的沙箱存储不可用，会话落在 ~/.logseq 下（所有图谱共用），不在本图谱目录里"
          : "会话就写在图谱目录内的这个文件夹里",
      files: "akyuu-session-*.json（机器读）/ .md（人读）",
    };
  }

  function joinPath(a, b) {
    const left = String(a || "").replace(/[\\/]+$/, "");
    const right = String(b || "").replace(/^[\\/]+/, "");
    if (!left) return right;
    if (!right) return left;
    const win = left.indexOf("\\") >= 0 || /^[a-zA-Z]:/.test(left);
    const norm = win ? right.replace(/\//g, "\\") : right.replace(/\\/g, "/");
    return left + (win ? "\\" : "/") + norm;
  }

  /* ------------------------------ 会话读写 ------------------------------ */

  function newId() {
    rid++;
    const d = new Date();
    const p = (n, w) => String(n).padStart(w || 2, "0");
    return (
      d.getFullYear() +
      p(d.getMonth() + 1) +
      p(d.getDate()) +
      "-" +
      p(d.getHours()) +
      p(d.getMinutes()) +
      p(d.getSeconds()) +
      "-" +
      p(rid, 2)
    );
  }

  function sessionFile(id) {
    return DIR + PREFIX + id + ".json";
  }

  function markdownFile(id) {
    return DIR + PREFIX + id + ".md";
  }

  function normalizeSession(raw) {
    if (!raw || typeof raw !== "object") return null;
    const messages = (raw.messages || []).map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: String(m.content == null ? "" : m.content),
      reasoning: m.reasoning || "",
      error: m.error || "",
      sources: Array.isArray(m.sources) ? m.sources : [],
      kind: m.kind || "",
      ts: m.ts || 0,
    }));
    return {
      version: VERSION,
      id: String(raw.id || newId()),
      title: String(raw.title || titleOf(messages) || "新对话").slice(0, 80),
      created: raw.created || Date.now(),
      updated: raw.updated || Date.now(),
      graph: raw.graph || "",
      model: raw.model || "",
      provider: raw.provider || "",
      messages: messages,
    };
  }

  function titleOf(messages) {
    const first = (messages || []).find((m) => m.role === "user" && m.content);
    return first ? String(first.content).replace(/\s+/g, " ").trim().slice(0, 60) : "";
  }

  function toMarkdown(sess) {
    const s = normalizeSession(sess);
    if (!s) return "";
    const when = new Date(s.updated || Date.now());
    const head = [
      "# " + s.title,
      "",
      "- 会话 id：" + s.id,
      "- 时间：" + when.toLocaleString(),
      "- 图谱：" + (s.graph || (graphCache && graphCache.name) || "-"),
      "- 模型：" + [s.provider, s.model].filter(Boolean).join(" / "),
      "",
      "---",
      "",
    ];
    const body = s.messages.map((m) => {
      const who = m.role === "user" ? "🧑 我" : "✦ Akyuu";
      const meta = m.ts ? " · " + new Date(m.ts).toLocaleTimeString() : "";
      const err = m.error ? "\n\n> ⚠️ 请求失败：" + m.error : "";
      return "### " + who + meta + "\n\n" + (m.content || "（空）") + err;
    });
    return head.concat(body).join("\n\n").trim() + "\n";
  }

  async function readIndex() {
    const idx = await kvGet(INDEX_KEY);
    if (idx && Array.isArray(idx.sessions)) return idx;
    return { version: VERSION, updated: 0, sessions: [] };
  }

  /** 索引丢了也能靠 allKeys() 把会话找回来 */
  async function rebuildIndex() {
    const keys = await allKeys();
    const ids = keys
      .map((k) => {
        const name = String(k || "").split(/[\\/]/).pop();
        const m = /^akyuu-session-(.+)\.json$/.exec(name);
        return m ? m[1] : null;
      })
      .filter(Boolean);
    const list = [];
    for (const id of ids.slice(0, MAX_SESSIONS)) {
      const s = await kvGet(sessionFile(id));
      if (!s) continue;
      list.push({ id: id, title: s.title || "新对话", updated: s.updated || 0, count: (s.messages || []).length });
    }
    list.sort((a, b) => b.updated - a.updated);
    return { version: VERSION, updated: Date.now(), sessions: list };
  }

  async function saveSession(raw) {
    const sess = normalizeSession(raw);
    if (!sess) throw new Error("会话格式不对");
    const g = await graph();
    sess.graph = g.name;
    sess.updated = Date.now();
    if (!sess.created) sess.created = sess.updated;
    if (!sess.title) sess.title = titleOf(sess.messages) || "新对话";

    const stored = await kvSet(sessionFile(sess.id), sess);
    await kvSetRaw(markdownFile(sess.id), toMarkdown(sess));

    const idx = await readIndex();
    const rest = idx.sessions.filter((s) => s.id !== sess.id);
    const entry = {
      id: sess.id,
      title: sess.title,
      updated: sess.updated,
      count: sess.messages.length,
      model: sess.model,
    };
    idx.sessions = [entry].concat(rest).slice(0, MAX_SESSIONS);
    idx.updated = sess.updated;
    idx.version = VERSION;
    await kvSet(INDEX_KEY, idx);

    // 超出上限的老会话顺手删掉，别让图谱里堆垃圾
    rest.slice(MAX_SESSIONS - 1).forEach((s) => {
      kvRemove(sessionFile(s.id));
      kvRemove(markdownFile(s.id));
    });

    return { ok: stored === "file", stored: stored, id: sess.id, session: sess };
  }

  async function listSessions() {
    const idx = await readIndex();
    if (idx.sessions.length) {
      return idx.sessions.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
    }
    const rebuilt = await rebuildIndex();
    if (rebuilt.sessions.length) await kvSet(INDEX_KEY, rebuilt);
    return rebuilt.sessions;
  }

  async function loadSession(id) {
    if (!id) return null;
    const s = await kvGet(sessionFile(String(id)));
    return s ? normalizeSession(s) : null;
  }

  async function removeSession(id) {
    if (!id) return false;
    await kvRemove(sessionFile(String(id)));
    await kvRemove(markdownFile(String(id)));
    const idx = await readIndex();
    idx.sessions = idx.sessions.filter((s) => s.id !== id);
    idx.updated = Date.now();
    await kvSet(INDEX_KEY, idx);
    return true;
  }

  async function latest() {
    const list = await listSessions();
    if (list.length) return loadSession(list[0].id);
    return null;
  }

  /** 老版本存在 localStorage 的 sessions 数组 → 迁移成文件 */
  async function migrateLegacy() {
    const legacy = await CP.store.get("sessions");
    if (!Array.isArray(legacy) || !legacy.length) return 0;
    let n = 0;
    for (const s of legacy) {
      if (!s || !Array.isArray(s.messages) || !s.messages.length) continue;
      try {
        await saveSession({
          id: String(s.id || newId()),
          title: s.title,
          created: s.ts,
          updated: s.ts,
          messages: s.messages,
        });
        n++;
      } catch (e) {
        /* 单条失败不影响其它 */
      }
    }
    if (n) await CP.store.remove("sessions");
    return n;
  }

  async function stats() {
    const b = await backend();
    const list = await listSessions();
    return {
      backend: b.kind,
      label: b.label,
      count: list.length,
      latest: list[0] ? list[0].title : "",
      dir: (await folder()).dir,
    };
  }

  CP.ws = {
    backend: backend,
    graph: graph,
    folder: folder,
    saveSession: saveSession,
    listSessions: listSessions,
    loadSession: loadSession,
    removeSession: removeSession,
    latest: latest,
    migrateLegacy: migrateLegacy,
    toMarkdown: toMarkdown,
    normalizeSession: normalizeSession,
    stats: stats,
    newId: newId,
    PREFIX: PREFIX,
  };
})(typeof window !== "undefined" ? window : globalThis);
