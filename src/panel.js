/**
 * 聊天面板 UI。面板本身跑在插件自己的 iframe 里（Logseq 的 main UI），
 * 所以 DOM 完全自由，不需要往宿主页面注入节点。
 */
(function (global) {
  const CP = (global.CP = global.CP || {});

  const DEFAULT_SYSTEM = [
    "你是 Akyuu（插件名 Logseq Akyuu），一个嵌在用户 Logseq 笔记里的 AI 助手。",
    "被问到你是谁、叫什么时，回答「我是 Akyuu」；不要自称 Copilot、ChatGPT 或其他名字。",
    "你会收到用户当前页面/块的片段，把它当作背景知识；不要假装看到了没给你的内容。",
    "回答用 Markdown：简洁、结构化、可直接粘进笔记。引用页面时用 [[页面名]] 的形式。",
  ].join("\n");

  let seq = 0;

  const state = {
    open: false,
    busy: false,
    abort: null,
    messages: [],
    pinned: [],
    sessionId: null,
    sessionCreated: 0,
    usePage: true,
    useBlock: true,
    mode: "chat",
    current: { page: null, block: null, selected: [] },
    pages: null,
    workspace: null,
    confirm: null,
    toolAllow: {},
    mention: { open: false, query: "", items: [], index: 0, start: 0, end: 0, timer: null },
  };

  let el = {};
  const rafMap = new WeakMap();

  function toast(content, status) {
    try {
      if (global.logseq.UI && global.logseq.UI.showMsg) global.logseq.UI.showMsg(content, status || "success");
      else if (global.logseq.App && global.logseq.App.showMsg) global.logseq.App.showMsg(content, status || "success");
    } catch (e) {
      /* ignore */
    }
  }
  CP.toast = toast;

  function esc(s) {
    return CP.md.escapeHtml(s);
  }

  /* ------------------------------- 模板 ------------------------------- */

  function template() {
    return (
      '<div class="cp-root">' +
      '<header class="cp-head">' +
      '<div class="cp-brand"><span class="cp-logo">✦</span><span class="cp-title">Akyuu</span>' +
      '<span class="cp-model" id="cp-model">—</span></div>' +
      '<div class="cp-head-actions">' +
      '<button class="cp-icon" data-act="sessions" title="历史会话（存在图谱目录里）">🕘</button>' +
      '<button class="cp-icon" data-act="pin" title="把当前页面加入上下文">📌</button>' +
      '<button class="cp-icon" data-act="new" title="新对话">✚</button>' +
      '<button class="cp-icon" data-act="gear" title="插件设置">⚙</button>' +
      '<button class="cp-icon" data-act="close" title="关闭（Esc）">✕</button>' +
      "</div>" +
      "</header>" +
      '<div class="cp-ctx" id="cp-ctx"></div>' +
      '<main class="cp-msgs" id="cp-msgs"></main>' +
      '<div class="cp-bar">' +
      '<select id="cp-mode" class="cp-select" title="对话模式">' +
      '<option value="chat">💬 对话</option>' +
      '<option value="graph">📚 全图问答</option>' +
      "</select>" +
      '<button class="cp-ghost" id="cp-prompt" title="提示词">📚 提示词</button>' +
      '<button class="cp-ghost" id="cp-tools" title="AI 能否直接改笔记">✋ 需确认</button>' +
      '<div class="cp-bar-spacer"></div>' +
      '<span class="cp-hint">Enter 发送 · Shift+Enter 换行</span>' +
      "</div>" +
      '<footer class="cp-compose">' +
      '<textarea id="cp-input" rows="1" placeholder="问点什么；输入 @ 可引用页面或块…"></textarea>' +
      '<div class="cp-compose-actions"><span class="cp-status" id="cp-status"></span>' +
      '<button class="cp-send" id="cp-send">发送</button></div>' +
      "</footer>" +
      '<div class="cp-pop cp-mention" id="cp-mention" hidden>' +
      '<div class="cp-mention-head">引用到对话 · ↑↓ 选择 · Enter 插入 · Esc 关闭</div>' +
      '<div class="cp-mention-list" id="cp-mention-list"></div>' +
      "</div>" +
      '<div class="cp-pop" id="cp-prompt-menu" hidden></div>' +
      '<div class="cp-pop cp-page-pop" id="cp-page-pop" hidden>' +
      '<input id="cp-page-search" placeholder="搜索页面…" autocomplete="off"/>' +
      '<div class="cp-page-list" id="cp-page-list"></div>' +
      "</div>" +
      '<div class="cp-pop cp-sess-pop" id="cp-sess-pop" hidden>' +
      '<div class="cp-sess-head"><span>历史会话</span><span class="cp-sess-dir" id="cp-sess-dir"></span></div>' +
      '<div class="cp-sess-list" id="cp-sess-list"></div>' +
      "</div>" +
      '<div class="cp-resize-x" title="拖动调整宽度"></div>' +
      '<div class="cp-resize-y" title="拖动调整高度"></div>' +
      "</div>"
    );
  }

  /* ------------------------------- 挂载 ------------------------------- */

  async function mount() {
    const root = document.getElementById("app");
    root.innerHTML = template();
    el = {
      root: root.querySelector(".cp-root"),
      head: root.querySelector(".cp-head"),
      model: root.querySelector("#cp-model"),
      ctx: root.querySelector("#cp-ctx"),
      msgs: root.querySelector("#cp-msgs"),
      mode: root.querySelector("#cp-mode"),
      promptBtn: root.querySelector("#cp-prompt"),
      promptMenu: root.querySelector("#cp-prompt-menu"),
      pagePop: root.querySelector("#cp-page-pop"),
      pageSearch: root.querySelector("#cp-page-search"),
      pageList: root.querySelector("#cp-page-list"),
      input: root.querySelector("#cp-input"),
      send: root.querySelector("#cp-send"),
      status: root.querySelector("#cp-status"),
      mention: root.querySelector("#cp-mention"),
      mentionList: root.querySelector("#cp-mention-list"),
      toolsBtn: root.querySelector("#cp-tools"),
      sessPop: root.querySelector("#cp-sess-pop"),
      sessList: root.querySelector("#cp-sess-list"),
      sessDir: root.querySelector("#cp-sess-dir"),
    };

    el.msgs.addEventListener("click", onMessagesClick);
    el.ctx.addEventListener("click", onContextClick);
    el.head.addEventListener("click", onHeadClick);
    el.send.addEventListener("click", () => (state.busy ? stop() : send()));
    el.input.addEventListener("keydown", onInputKeydown);
    el.input.addEventListener("input", () => {
      autosize();
      updateMention();
    });
    el.input.addEventListener("click", updateMention);
    el.mentionList.addEventListener("mousedown", (e) => {
      // mousedown 而不是 click：否则 textarea 先失焦，选区位置会丢
      e.preventDefault();
      const item = e.target.closest("[data-mid]");
      if (!item) return;
      const idx = Number(item.getAttribute("data-mid"));
      const picked = state.mention.items[idx];
      if (picked) insertMention(picked);
    });
    el.mode.addEventListener("change", () => {
      state.mode = el.mode.value;
    });

    // 拖动标题栏移动；双击复位；左边缘改宽、下边缘改高
    el.head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, select, input, textarea")) return;
      e.preventDefault();
      beginDrag(e, "move", el.head);
    });
    el.head.addEventListener("dblclick", (e) => {
      if (e.target.closest("button")) return;
      resetGeom();
    });
    const resizeX = root.querySelector(".cp-resize-x");
    const resizeY = root.querySelector(".cp-resize-y");
    if (resizeX) {
      resizeX.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        beginDrag(e, "x", resizeX);
      });
    }
    if (resizeY) {
      resizeY.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        beginDrag(e, "y", resizeY);
      });
    }

    try {
      const saved = await CP.store.get("geom");
      geom = saved && typeof saved === "object" ? sanitizeGeom(saved) : defaultGeom();
    } catch (e) {
      geom = defaultGeom();
    }
    el.promptBtn.addEventListener("click", togglePromptMenu);
    el.pageSearch.addEventListener("input", renderPageList);
    if (el.toolsBtn) el.toolsBtn.addEventListener("click", cycleToolPolicy);
    if (el.sessList) el.sessList.addEventListener("click", onSessionListClick);

    document.body.addEventListener("click", (e) => {
      if (!el.promptMenu.contains(e.target) && e.target !== el.promptBtn) el.promptMenu.hidden = true;
      if (!el.pagePop.contains(e.target) && !e.target.closest('[data-act="add-page"]')) el.pagePop.hidden = true;
      if (el.sessPop && !el.sessPop.contains(e.target) && !e.target.closest('[data-act="sessions"]')) el.sessPop.hidden = true;
    });

    window.addEventListener("keydown", (e) => {
      // 焦点在 iframe 里时，宿主的全局快捷键收不到按键，所以这里自己再兜一层
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && (e.key === "J" || e.key === "j" || e.code === "KeyJ")) {
        e.preventDefault();
        toggle();
        return;
      }
      if (e.key === "Escape") {
        if (state.mention.open) closeMention();
        else if (!el.promptMenu.hidden) el.promptMenu.hidden = true;
        else if (!el.pagePop.hidden) el.pagePop.hidden = true;
        else if (el.sessPop && !el.sessPop.hidden) el.sessPop.hidden = true;
        else if (state.open) close();
      }
    });

    // 和宿主保持同步：外部（快捷命令 / 宿主 UI）隐藏面板时，别让 state.open 卡在 true
    try {
      global.logseq.on("ui:visible:changed", (payload) => {
        if (payload && typeof payload.visible === "boolean") state.open = payload.visible;
      });
    } catch (e) {
      /* ignore */
    }

    el.promptMenu.addEventListener("click", (e) => {
      const item = e.target.closest("[data-prompt]");
      if (!item) return;
      el.promptMenu.hidden = true;
      const text = item.getAttribute("data-text") || "";
      el.input.value = text;
      autosize();
      el.input.focus();
    });

    el.pageList.addEventListener("click", (e) => {
      const item = e.target.closest("[data-page]");
      if (!item) return;
      pinPage(item.getAttribute("data-page"));
      el.pagePop.hidden = true;
    });

    applyTheme();
    applyModelLabel();
    renderContext();
    renderMessages();
    renderPromptMenu();
    renderToolsButton();
    el.mode.value = state.mode;
    refreshWorkspace();
    return Promise.resolve();
  }

  /* ------------------------------ 主题 ------------------------------ */

  // 把宿主的 CSS 变量搬进插件 iframe（跨文档不会自动继承），域名对不上就退回内置配色
  const HOST_VARS = [
    ["--cp-bg", ["--ls-primary-background-color"]],
    ["--cp-bg-soft", ["--ls-secondary-background-color", "--ls-tertiary-background-color"]],
    ["--cp-bg-elev", ["--ls-secondary-background-color", "--ls-primary-background-color"]],
    ["--cp-text", ["--ls-primary-text-color"]],
    ["--cp-muted", ["--ls-secondary-text-color", "--ls-tertiary-text-color"]],
    ["--cp-border", ["--ls-border-color"]],
    ["--cp-border-strong", ["--ls-border-color"]],
    ["--cp-accent", ["--ls-link-text-color", "--ls-active-primary-color"]],
    ["--cp-user-bg", ["--ls-tertiary-background-color", "--ls-secondary-background-color"]],
    ["--cp-code-bg", ["--ls-code-block-background-color", "--ls-secondary-background-color"]],
    ["--cp-danger", ["--ls-error-text-color"]],
    ["--cp-font", ["--ls-font-family"]],
  ];

  let hostProbe = null; // null=还没试过 / true=能读宿主样式 / false=跨域，读不到
  let themeTimer = 0;
  const themeState = { mode: "light", source: "builtin", accent: "", hostVars: 0 };

  function hostRoot() {
    if (hostProbe === false) return null;
    try {
      const p = global.parent;
      if (!p || p === global || !p.document || !p.document.documentElement) {
        hostProbe = false;
        return null;
      }
      hostProbe = true;
      return p;
    } catch (e) {
      hostProbe = false; // 跨域：只能用内置配色
      return null;
    }
  }

  function hostVar(p, name) {
    try {
      return String(p.getComputedStyle(p.document.documentElement).getPropertyValue(name) || "").trim();
    } catch (e) {
      return "";
    }
  }

  function applyHostColors(dark) {
    const root = document.documentElement;
    const s = (global.logseq && global.logseq.settings) || {};
    HOST_VARS.forEach((pair) => root.style.removeProperty(pair[0]));
    const p = hostRoot();
    let used = 0;
    if (p) {
      HOST_VARS.forEach((pair) => {
        for (const src of pair[1]) {
          const v = hostVar(p, src);
          if (v) {
            root.style.setProperty(pair[0], v);
            used++;
            break;
          }
        }
      });
    }
    const accent = String(s.accentColor || "").trim();
    if (accent) root.style.setProperty("--cp-accent", accent);
    themeState.mode = dark ? "dark" : "light";
    themeState.source = used >= 3 ? "host" : "builtin";
    themeState.hostVars = used;
    themeState.accent = accent || String(root.style.getPropertyValue("--cp-accent") || "").trim();
  }

  function mediaMode() {
    try {
      return global.matchMedia && global.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (e) {
      return "light";
    }
  }

  /** 从宿主配置 / 事件载荷 / 主题名里判断白天还是暗夜 */
  function modeOf(obj) {
    const o = obj || {};
    const direct = String(o.mode || o.themeMode || o.preferredThemeMode || o.type || "").toLowerCase();
    if (direct) return direct.indexOf("dark") >= 0 ? "dark" : "light";
    const theme = String(o.preferredTheme || o.theme || "").toLowerCase();
    if (theme) return theme.indexOf("dark") >= 0 ? "dark" : "light";
    return mediaMode();
  }

  function setThemeMode(mode) {
    const s = (global.logseq && global.logseq.settings) || {};
    const fixed = s.appearance === "dark" ? "dark" : s.appearance === "light" ? "light" : "";
    const dark = fixed ? fixed === "dark" : String(mode) === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    applyHostColors(dark);
  }

  function refreshTheme() {
    try {
      global.logseq.App.getUserConfigs()
        .then((c) => setThemeMode(modeOf(c)))
        .catch(() => setThemeMode(mediaMode()));
    } catch (e) {
      setThemeMode(mediaMode());
    }
  }

  function applyTheme() {
    refreshTheme();
    try {
      global.logseq.App.onThemeModeChanged((payload) => setThemeMode(modeOf(payload)));
    } catch (e) {
      /* 老版本没有这个事件 */
    }
    try {
      const mq = global.matchMedia && global.matchMedia("(prefers-color-scheme: dark)");
      if (mq && mq.addEventListener) {
        mq.addEventListener("change", (e) => {
          const s = (global.logseq && global.logseq.settings) || {};
          if (!s.appearance || s.appearance === "follow") setThemeMode(e.matches ? "dark" : "light");
        });
      }
    } catch (e) {
      /* ignore */
    }
    // 换自定义主题不会发 mode 事件，面板开着时低频重读一次颜色
    if (!themeTimer) {
      themeTimer = setInterval(() => {
        if (state.open) applyHostColors(document.documentElement.getAttribute("data-theme") === "dark");
      }, 5000);
    }
  }

  function themeInfo() {
    return {
      mode: document.documentElement.getAttribute("data-theme") || "light",
      source: themeState.source,
      accent: themeState.accent,
      hostVars: themeState.hostVars,
      hostReadable: hostProbe === true,
    };
  }

  function applyModelLabel() {
    try {
      const c = CP.llm.resolve();
      el.model.textContent = c.model || "未配置";
      el.model.title = c.label + " · " + c.model;
    } catch (e) {
      el.model.textContent = "未配置";
    }
  }

  /* ------------------------------ 上下文 ------------------------------ */

  async function refreshContext() {
    try {
      state.current = await CP.ctx.active();
    } catch (e) {
      state.current = { page: null, block: null, selected: [] };
    }
    renderContext();
  }

  function chip(label, opts) {
    const o = opts || {};
    const cls = "cp-chip" + (o.off ? " off" : "") + (o.tone ? " " + o.tone : "");
    const title = o.title ? ' title="' + esc(o.title) + '"' : "";
    const act = o.act ? ' data-act="' + o.act + '"' : "";
    const extra = o.name ? ' data-name="' + esc(o.name) + '"' : "";
    const close = o.closable ? '<span class="cp-chip-x">✕</span>' : "";
    return '<span class="' + cls + '"' + title + act + extra + ">" + label + close + "</span>";
  }

  function renderContext() {
    if (!el.ctx) return;
    const cur = state.current;
    const parts = [];

    if (state.workspace) {
      const ws = state.workspace;
      parts.push(
        chip("📁 " + esc(ws.graph || "图谱"), {
          tone: "ws",
          title:
            "工作区：" + (ws.dir || ws.label || "?") +
            (ws.hint ? "\n" + ws.hint : "") +
            "\n会话文件：" + (ws.files || "akyuu-session-*.json"),
        })
      );
    }
    if (cur.page && cur.page.name) {
      parts.push(
        chip("📄 " + esc(cur.page.name), {
          act: "toggle-page",
          off: !state.usePage,
          title: state.usePage ? "点击从上下文移除当前页面" : "点击把当前页面加入上下文",
        })
      );
    }
    if (cur.block && cur.block.content) {
      parts.push(
        chip("📍 当前块", {
          act: "toggle-block",
          off: !state.useBlock,
          title: state.useBlock ? "点击不发送光标所在块" : "点击发送光标所在块",
        })
      );
    }
    if (cur.selected && cur.selected.length) {
      parts.push(chip("🖱 选中 " + cur.selected.length + " 块", { tone: "accent" }));
    }
    state.pinned.forEach((p) => {
      parts.push(
        '<span class="cp-chip pinned" data-pin="' + esc(p.name) + '" title="点击移除">📌 ' +
          esc(p.name) +
          '<span class="cp-chip-x">✕</span></span>'
      );
    });
    parts.push(chip("＋ 页面", { act: "add-page", tone: "ghost", title: "引用其他页面作为上下文" }));

    el.ctx.innerHTML = parts.join("");
  }

  async function pinPage(name) {
    if (!name) return;
    if (state.pinned.some((p) => p.name === name)) return;
    state.pinned.push({ name: name });
    renderContext();
  }

  async function pinCurrentPage() {
    await refreshContext();
    const p = state.current.page;
    if (!p || !p.name) {
      toast("先把光标放到一个页面上", "warning");
      return;
    }
    pinPage(p.name);
    toast("已加入上下文：" + p.name);
  }

  /* ------------------------------ 工作区 ------------------------------ */

  async function refreshWorkspace() {
    if (!CP.ws) return null;
    try {
      state.workspace = await CP.ws.folder();
    } catch (e) {
      state.workspace = null;
    }
    renderContext();
    return state.workspace;
  }

  /* ------------------------------ 工具策略 ------------------------------ */

  function toolPolicy() {
    const s = (global.logseq && global.logseq.settings) || {};
    const v = s.toolPolicy;
    return v === "auto" || v === "off" ? v : "confirm";
  }

  function renderToolsButton() {
    if (!el.toolsBtn) return;
    const p = toolPolicy();
    el.toolsBtn.textContent = p === "auto" ? "⚡ 自动执行" : p === "off" ? "🚫 只能聊天" : "✋ 需确认";
    el.toolsBtn.title =
      p === "auto"
        ? "工具自动执行（删除类仍要确认）· 点击切换"
        : p === "off"
        ? "不启用工具，只输出文字 · 点击切换"
        : "改笔记前先让你确认 · 点击切换";
    el.toolsBtn.classList.toggle("on", p === "auto");
    el.toolsBtn.classList.toggle("off", p === "off");
  }

  function cycleToolPolicy() {
    const order = ["confirm", "auto", "off"];
    const next = order[(order.indexOf(toolPolicy()) + 1) % order.length];
    state.toolAllow = {}; // 换模式就重新问，避免「以为还会确认」
    try {
      if (typeof global.logseq.updateSettings === "function") global.logseq.updateSettings({ toolPolicy: next });
      else global.logseq.settings.toolPolicy = next;
    } catch (e) {
      try {
        global.logseq.settings.toolPolicy = next;
      } catch (e2) {
        /* ignore */
      }
    }
    renderToolsButton();
    toast("工具模式：" + (next === "auto" ? "自动执行" : next === "off" ? "只能聊天" : "需确认"));
  }

  /* ------------------------------ 历史会话 ------------------------------ */

  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    if (d.toDateString() === now.toDateString()) return hm;
    return d.getMonth() + 1 + "-" + d.getDate() + " " + hm;
  }

  function toggleSessions() {
    const willShow = el.sessPop.hidden;
    el.sessPop.hidden = !willShow;
    if (willShow) renderSessionList();
  }

  async function renderSessionList() {
    if (!el.sessList) return;
    el.sessList.innerHTML = '<div class="cp-empty">读取中…</div>';
    let list = [];
    try {
      list = await CP.ws.listSessions();
    } catch (e) {
      list = [];
    }
    if (el.sessDir) {
      const f = state.workspace || (await CP.ws.folder().catch(() => null));
      if (f) {
        el.sessDir.textContent = f.dir || f.label || "";
        el.sessDir.title = (f.dir || f.label || "") + "\n" + (f.files || "");
      }
    }
    if (!list.length) {
      el.sessList.innerHTML = '<div class="cp-empty">还没有历史会话</div>';
      return;
    }
    el.sessList.innerHTML = list
      .map(
        (s) =>
          '<div class="cp-sess-item' +
          (String(s.id) === String(state.sessionId) ? " active" : "") +
          '" data-sid="' +
          esc(s.id) +
          '"><div class="cp-sess-title">' +
          esc(s.title || "新对话") +
          '</div><div class="cp-sess-meta">' +
          esc(fmtTime(s.updated)) +
          " · " +
          (s.count || 0) +
          ' 条</div><button class="cp-sess-del" data-del="' +
          esc(s.id) +
          '" title="删除这个会话文件">✕</button></div>'
      )
      .join("");
  }

  async function onSessionListClick(e) {
    const del = e.target.closest("[data-del]");
    if (del) {
      e.stopPropagation();
      const id = del.getAttribute("data-del");
      try {
        await CP.ws.removeSession(id);
      } catch (err) {
        /* ignore */
      }
      if (String(id) === String(state.sessionId)) {
        state.messages = [];
        state.sessionId = null;
        renderMessages();
      }
      renderSessionList();
      toast("已删除会话");
      return;
    }
    const item = e.target.closest("[data-sid]");
    if (!item) return;
    await loadSession(item.getAttribute("data-sid"));
    el.sessPop.hidden = true;
  }

  async function loadSession(id) {
    if (state.busy) {
      toast("正在生成，先停止再切换", "warning");
      return;
    }
    let s = null;
    try {
      s = await CP.ws.loadSession(id);
    } catch (e) {
      s = null;
    }
    if (!s) {
      toast("读不到这个会话", "error");
      return;
    }
    state.sessionId = s.id;
    state.sessionCreated = s.created;
    state.toolAllow = {};
    state.messages = (s.messages || []).map((m) => Object.assign({ id: ++seq }, m));
    renderMessages();
    autoScroll(true);
    toast("已载入：" + (s.title || "会话"));
  }

  async function openPagePicker() {
    el.pagePop.hidden = false;
    el.pageSearch.value = "";
    el.pageSearch.focus();
    renderPageList();
  }

  async function allPages() {
    if (state.pages) return state.pages;
    try {
      const pages = await global.logseq.Editor.getAllPages();
      state.pages = (pages || [])
        .map((p) => p && (p.originalName || p.name))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    } catch (e) {
      state.pages = [];
    }
    return state.pages;
  }

  async function renderPageList() {
    const q = (el.pageSearch.value || "").trim().toLowerCase();
    const pages = await allPages();
    const list = (q ? pages.filter((p) => p.toLowerCase().includes(q)) : pages).slice(0, 12);
    if (!list.length) {
      el.pageList.innerHTML = '<div class="cp-empty">没有匹配的页面</div>';
      return;
    }
    el.pageList.innerHTML = list
      .map((p) => '<div class="cp-page-item" data-page="' + esc(p) + '">' + esc(p) + "</div>")
      .join("");
  }

  /* ------------------------------ @ 引用 ------------------------------ */

  function clipOneLine(s, n) {
    const str = String(s || "").replace(/\s+/g, " ").trim();
    return str.length > n ? str.slice(0, n) + "…" : str;
  }

  function detectMention() {
    const input = el.input;
    if (!input) return null;
    const caret = input.selectionStart || 0;
    const before = input.value.slice(0, caret);
    const m = before.match(/(^|[\s(（,，。;；:：、])@([^\s@\[\]()]{0,30})$/);
    if (!m) return null;
    const query = m[2] || "";
    return { query: query, start: caret - query.length - 1, end: caret };
  }

  function updateMention() {
    const d = detectMention();
    if (!d) {
      closeMention();
      return;
    }
    const m = state.mention;
    const changed = !m.open || m.query !== d.query;
    m.open = true;
    m.start = d.start;
    m.end = d.end;
    if (changed) {
      m.query = d.query;
      m.items = [];
      m.index = 0;
      renderMention();
    }
    scheduleMentionSearch(d.query);
  }

  function scheduleMentionSearch(query) {
    const m = state.mention;
    if (m.timer) clearTimeout(m.timer);
    m.timer = setTimeout(async () => {
      m.timer = null;
      let items = [];
      try {
        items = await searchMentions(query);
      } catch (e) {
        items = [];
      }
      if (!m.open || m.query !== query) return;
      m.items = items;
      m.index = 0;
      renderMention();
    }, 160);
  }

  async function searchMentions(query) {
    const q = String(query || "").trim();
    const items = [];
    const seen = new Set();

    if (!q) {
      const b = await global.logseq.Editor.getCurrentBlock().catch(() => null);
      if (b && b.uuid && b.content) {
        items.push({ kind: "block", uuid: b.uuid, content: b.content, page: "" });
        seen.add(b.uuid);
      }
      if (state.current.page && state.current.page.name) {
        items.push({ kind: "page", name: state.current.page.name });
      }
    }

    const pages = await allPages();
    const lower = q.toLowerCase();
    const pageHits = (q ? pages.filter((p) => p.toLowerCase().includes(lower)) : pages).slice(0, q ? 4 : 3);
    pageHits.forEach((name) => items.push({ kind: "page", name: name }));

    if (q.length >= 1) {
      const blocks = await CP.retrieval.searchBlocks(q, 8);
      blocks.forEach((b) => {
        if (!b.uuid || seen.has(b.uuid)) return;
        seen.add(b.uuid);
        items.push({ kind: "block", uuid: b.uuid, content: b.content, page: b.page });
      });
    }

    return items.slice(0, 12);
  }

  function renderMention() {
    const m = state.mention;
    if (!m.open || !el.mention) return;
    el.mention.hidden = false;
    if (!m.items.length) {
      el.mentionList.innerHTML = '<div class="cp-empty">输入关键词搜索页面或块…</div>';
      return;
    }
    el.mentionList.innerHTML = m.items
      .map((it, i) => {
        const active = i === m.index ? " active" : "";
        if (it.kind === "page") {
          return (
            '<div class="cp-mention-item' + active + '" data-mid="' + i + '">' +
            '<span class="cp-mk page">页面</span>' +
            '<span class="cp-mention-text">' + esc(it.name) + "</span></div>"
          );
        }
        const page = it.page ? '<span class="cp-mention-page">' + esc(it.page) + "</span>" : "";
        return (
          '<div class="cp-mention-item' + active + '" data-mid="' + i + '">' +
          '<span class="cp-mk block">块</span>' +
          '<span class="cp-mention-text">' + esc(clipOneLine(it.content, 66)) + page + "</span></div>"
        );
      })
      .join("");
    const activeEl = el.mentionList.querySelector(".active");
    if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: "nearest" });
  }

  function insertMention(item) {
    const m = state.mention;
    const token = item.kind === "page" ? "[[" + item.name + "]]" : "((" + item.uuid + "))";
    const v = el.input.value;
    el.input.value = v.slice(0, m.start) + token + v.slice(m.end);
    const pos = m.start + token.length;
    try {
      el.input.setSelectionRange(pos, pos);
    } catch (e) {
      /* ignore */
    }
    closeMention();
    autosize();
    el.input.focus();
  }

  function closeMention() {
    const m = state.mention;
    if (m.timer) {
      clearTimeout(m.timer);
      m.timer = null;
    }
    m.open = false;
    m.query = "";
    m.items = [];
    m.index = 0;
    if (el.mention) el.mention.hidden = true;
  }

  function moveMention(delta) {
    const m = state.mention;
    if (!m.items.length) return;
    m.index = (m.index + delta + m.items.length) % m.items.length;
    renderMention();
  }

  function onInputKeydown(e) {
    const m = state.mention;
    if (m.open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveMention(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveMention(-1);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing) {
        const picked = m.items[m.index];
        if (picked) {
          e.preventDefault();
          insertMention(picked);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  }

  /* ------------------------------ 消息渲染 ------------------------------ */

  function toolCardHtml(m) {
    const calls = m.calls || [];
    const pending = m.state === "pending";
    const running = m.state === "running";
    const cancelled = m.state === "cancelled";
    const items = calls
      .map((c, i) => {
        const r = (m.results || [])[i] || null;
        const mark = r ? (r.ok ? "✓" : "✕") : cancelled ? "—" : pending ? "?" : "…";
        const cls = r ? (r.ok ? " ok" : " fail") : cancelled ? " skip" : "";
        const danger = CP.tools.isDanger(c.name) ? '<b class="cp-tool-danger">危险</b>' : "";
        const allowed = !danger && state.toolAllow[c.name] ? '<b class="cp-tool-allowed">本会话已允许</b>' : "";
        const result = r ? '<div class="cp-tool-result">' + esc(r.message) + "</div>" : "";
        return (
          '<li class="cp-tool-item' +
          cls +
          '"><span class="cp-tool-state">' +
          mark +
          '</span><div class="cp-tool-main"><div class="cp-tool-name">' +
          esc(c.title || CP.tools.title(c.name)) +
          danger +
          allowed +
          '</div><div class="cp-tool-prev">' +
          esc(c.preview || "").replace(/\n/g, "<br/>") +
          "</div>" +
          result +
          "</div></li>"
        );
      })
      .join("");
    const head = cancelled
      ? "🔧 已取消 " + calls.length + " 个操作"
      : pending
      ? "🔧 需要你确认 " + calls.length + " 个操作"
      : running
      ? "🔧 正在执行…"
      : "🔧 已执行 " + calls.length + " 个操作";
    const actions = pending
      ? '<div class="cp-tool-actions"><button class="cp-tool-apply" data-msg-act="apply-tools">应用</button>' +
        '<button class="cp-tool-cancel" data-msg-act="cancel-tools">取消</button>' +
        '<label class="cp-tool-remember" title="勾选后，本会话里同类操作不再询问（删除类除外）">' +
        '<input type="checkbox" data-allow="1"/> 本会话内不再询问这类操作</label>' +
        "</div>"
      : "";
    return '<div class="cp-tool-card">' + '<div class="cp-tool-head">' + head + "</div>" + '<ol class="cp-tool-list">' + items + "</ol>" + actions + "</div>";
  }

  function messageHtml(m) {
    if (m.role === "user") {
      return (
        '<div class="cp-msg user" data-mid="' + m.id + '">' +
        '<div class="cp-bubble">' +
        esc(m.content).replace(/\n/g, "<br/>") +
        "</div></div>"
      );
    }
    if (m.kind === "tool") {
      return (
        '<div class="cp-msg assistant tool" data-mid="' + m.id + '">' +
        '<div class="cp-avatar">🔧</div><div class="cp-body">' +
        toolCardHtml(m) +
        "</div></div>"
      );
    }
    const body = m.content ? CP.md.render(m.content) : '<span class="cp-typing"><i></i><i></i><i></i></span>';
    const think = m.reasoning
      ? '<details class="cp-think"><summary>🧠 思考过程（' +
        m.reasoning.length +
        " 字）</summary><pre>" +
        esc(m.reasoning) +
        "</pre></details>"
      : "";
    const err = m.error
      ? '<div class="cp-error"><b>请求失败</b><span>' + esc(m.error) + "</span></div>"
      : "";
    const sources =
      m.sources && m.sources.length
        ? '<div class="cp-sources">上下文：' + m.sources.map(esc).join(" · ") + "</div>"
        : "";
    const actions = m.content
      ? '<div class="cp-actions">' +
        '<button data-msg-act="copy">复制</button>' +
        '<button data-msg-act="insert">插入到当前块</button>' +
        '<button data-msg-act="retry">重试</button>' +
        "</div>"
      : "";
    const cta = m.kind === "welcome" ? '<div class="cp-cta-row"><button class="cp-cta" data-msg-act="gear">打开设置</button></div>' : "";
    return (
      '<div class="cp-msg assistant" data-mid="' + m.id + '">' +
      '<div class="cp-avatar">✦</div>' +
      '<div class="cp-body"><div class="cp-think-badge" hidden></div>' +
      think +
      '<div class="cp-md">' + body + "</div>" + err + sources + cta + actions + "</div>" +
      "</div>"
    );
  }

  function renderMessages() {
    if (!el.msgs) return;
    if (!state.messages.length) {
      el.msgs.innerHTML = '<div class="cp-welcome-hint">开始一段对话吧 —— 你的页面会自动作为上下文。</div>';
      return;
    }
    el.msgs.innerHTML = state.messages.map(messageHtml).join("");
  }

  function msgNode(id) {
    return el.msgs.querySelector('.cp-msg[data-mid="' + id + '"] .cp-md');
  }

  function scheduleMd(node, m) {
    if (!node || rafMap.has(node)) return;
    const raf = requestAnimationFrame(() => {
      rafMap.delete(node);
      if (!node.isConnected) return;
      node.innerHTML = m.content ? CP.md.render(m.content) : "";
      autoScroll();
    });
    rafMap.set(node, raf);
  }

  function flushMd(node, m) {
    if (!node || !node.isConnected) return;
    node.innerHTML = m.content ? CP.md.render(m.content) : "";
  }

  function autoScroll(force) {
    if (!el.msgs) return;
    const near = el.msgs.scrollHeight - el.msgs.scrollTop - el.msgs.clientHeight < 140;
    if (force || near) el.msgs.scrollTop = el.msgs.scrollHeight;
  }

  /* ------------------------------ 对话流程 ------------------------------ */

  function lastUser() {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === "user") return state.messages[i].content;
    }
    return "";
  }

  /** 发给模型时把 ((uuid)) 换成可读占位：块内容在 <pinned_blocks> 里，模型不需要看裸 uuid */
  function forModel(text) {
    return String(text || "").replace(/\(\(([0-9a-fA-F-]{36})\)\)/g, "[块引用]");
  }

  function chatHistory(beforeId) {
    const s = global.logseq.settings || {};
    const turns = Math.max(1, Number(s.historyTurns) || 8);
    const out = [];
    for (const m of state.messages) {
      if (m.id === beforeId) break;
      if (m.error || !m.content) continue;
      if (m.toolSummary || m.kind === "tool") continue;
      if (m.role === "user" || (m.role === "assistant" && m.kind !== "welcome")) {
        out.push({ role: m.role, content: m.role === "user" ? forModel(m.content) : m.content });
      }
    }
    return out.slice(-turns * 2);
  }

  /**
   * system 保持稳定（不含时间、不含检索结果），这样 DeepSeek 的前缀缓存能命中：
   * 动态的图谱上下文放到最后一条 user 消息里。
   */
  function systemPrompt() {
    const s = global.logseq.settings || {};
    const base = (s.systemPrompt && String(s.systemPrompt).trim()) || DEFAULT_SYSTEM;
    const parts = [base];
    const lang = s.language || "auto";
    if (lang === "zh") parts.push("始终用简体中文回答。");
    else if (lang === "en") parts.push("Always answer in English.");
    parts.push(
      "用户消息里可能带 <graph_context>，那是用户笔记里的真实内容（可能不完整）。\n" +
        "分段含义：<current_page> 当前页；<current_block>/<selection> 光标块或选中内容；" +
        "<pinned> 用户明确要你看的页面（可信）；<pinned_blocks> 用户 @ 引用的具体块（可信）；" +
        "<graph_hits> 检索猜出来的相关块（可能不相关，请自行判断，不要硬凑）。\n" +
        "引用页面时用 [[页面名]] 的形式。"
    );
    return parts.join("\n\n");
  }

  function composeUser(text, ctx) {
    const parts = [];
    if (ctx && ctx.text) {
      parts.push("以下是本次相关的笔记上下文：\n<graph_context>\n" + ctx.text + "\n</graph_context>");
    }
    parts.push("当前时间：" + new Date().toLocaleString());
    parts.push("用户问题：\n" + text);
    return parts.join("\n\n");
  }

  async function send(presetText) {
    const fromPreset = typeof presetText === "string";
    const text = (fromPreset ? presetText : el.input.value).trim();
    if (!text || state.busy) return;
    closeMention();
    if (!fromPreset) {
      el.input.value = "";
      autosize();
    }
    state.messages.push({ id: ++seq, role: "user", content: text, ts: Date.now() });
    renderMessages();
    autoScroll(true);
    await turn();
  }

  /* ------------------------------ 工具卡片与确认 ------------------------------ */

  function updateThinkBadge(m) {
    const badge = el.msgs.querySelector('[data-mid="' + m.id + '"] .cp-think-badge');
    if (!badge) return;
    badge.hidden = false;
    badge.textContent = "🧠 思考中… " + (m.reasoning || "").length + " 字";
  }

  function askConfirm(msg) {
    return new Promise((resolve) => {
      state.confirm = { msg: msg, resolve: resolve };
    });
  }

  function decideTools(ok) {
    const c = state.confirm;
    if (!c) return;
    state.confirm = null;
    const msg = c.msg;
    if (ok) {
      const box = el.msgs.querySelector('.cp-msg[data-mid="' + msg.id + '"] input[data-allow]');
      const added = [];
      if (box && box.checked) {
        (msg.calls || []).forEach((call) => {
          if (CP.tools.isDanger(call.name) || state.toolAllow[call.name]) return;
          state.toolAllow[call.name] = true;
          added.push(CP.tools.title(call.name));
        });
      }
      if (added.length) toast("本会话内不再询问：" + added.join("、"));
    }
    msg.state = ok ? "running" : "cancelled";
    renderMessages();
    c.resolve(!!ok);
  }

  function lastAssistantForSources() {
    const list = state.messages.filter(
      (m) => m.role === "assistant" && m.kind !== "tool" && m.kind !== "welcome"
    );
    return list[list.length - 1] || null;
  }

  /** agent 交来一批工具调用：出卡片 → 等确认 → 执行 → 把结果交回去 */
  async function handleToolCalls(calls) {
    const policy = toolPolicy();
    if (policy === "off") return calls.map(() => ({ ok: false, message: "工具已关闭（只能聊天）" }));

    const previews = await Promise.all(calls.map((c) => CP.tools.preview(c.name, c.args)));
    const msg = {
      id: ++seq,
      role: "assistant",
      kind: "tool",
      ts: Date.now(),
      state: "pending",
      calls: calls.map((c, i) => ({
        name: c.name,
        title: CP.tools.title(c.name),
        args: c.args,
        preview: previews[i],
        danger: CP.tools.isDanger(c.name),
      })),
      results: [],
    };
    state.messages.push(msg);
    renderMessages();
    autoScroll(true);

    const hasDanger = calls.some((c) => CP.tools.isDanger(c.name));
    const allAllowed = calls.every((c) => CP.tools.isDanger(c.name) || state.toolAllow[c.name]);
    if (policy === "auto" ? hasDanger : !allAllowed || hasDanger) {
      const ok = await askConfirm(msg);
      if (!ok) {
        msg.state = "cancelled";
        renderMessages();
        return calls.map(() => ({ ok: false, message: "用户取消了这次操作" }));
      }
    } else {
      msg.state = "running";
      renderMessages();
    }

    for (let i = 0; i < calls.length; i++) {
      if (el.status) el.status.textContent = "执行工具 " + (i + 1) + "/" + calls.length + "…";
      const r = await CP.tools.run(calls[i].name, calls[i].args);
      msg.results[i] = r;
      renderMessages();
      autoScroll();
    }
    msg.state = "done";
    if (el.status) el.status.textContent = "";
    renderMessages();
    autoScroll();
    const failed = msg.results.filter((r) => r && !r.ok).length;
    if (failed) toast(failed + " 个操作失败", "warning");
    else toast("已应用 " + calls.length + " 个操作", "success");
    return msg.results;
  }

  async function turn() {
    const s = global.logseq.settings || {};
    const first = { id: ++seq, role: "assistant", content: "", ts: Date.now(), model: s.model };
    state.messages.push(first);
    renderMessages();
    autoScroll(true);

    let active = first;
    let node = msgNode(first.id);
    let ctxSources = null;

    state.busy = true;
    setBusy(true);

    const onRound = (index) => {
      if (index > 0) {
        active = { id: ++seq, role: "assistant", content: "", ts: Date.now(), model: s.model };
        state.messages.push(active);
        renderMessages();
        autoScroll(true);
      }
      node = msgNode(active.id);
      const target = active;
      return {
        delta: (d) => {
          target.content += d;
          scheduleMd(node, target);
        },
        reasoning: (d) => {
          target.reasoning = (target.reasoning || "") + d;
          updateThinkBadge(target);
        },
        final: (t) => {
          if (!t) return;
          const text = String(t.text || "").trim();
          const hasCalls = !!(t.toolCalls && t.toolCalls.length);
          if (hasCalls && !text) {
            // 这一轮只有工具调用，不留空壳气泡
            const i = state.messages.indexOf(target);
            if (i >= 0) state.messages.splice(i, 1);
            if (active === target) active = null;
            return;
          }
          target.content = hasCalls ? text : target.content;
          flushMd(msgNode(target.id), target);
        },
      };
    };

    try {
      const ctx = await CP.ctx.build({
        question: lastUser(),
        mode: state.mode,
        pinned: state.pinned,
        usePage: state.usePage,
        useBlock: state.useBlock,
      });
      ctxSources = (ctx.sources || []).map((x) => x.name);
      const history = chatHistory(first.id);
      if (history.length) {
        const last = history[history.length - 1];
        if (last.role === "user") last.content = composeUser(last.content, ctx);
      } else {
        history.push({ role: "user", content: composeUser(lastUser(), ctx) });
      }
      state.abort = new AbortController();
      const res = await CP.agent.run({
        messages: history,
        system: systemPrompt(),
        signal: state.abort.signal,
        onRound: onRound,
        onToolCalls: handleToolCalls,
      });
      if (res && res.note) {
        state.messages.push({
          id: ++seq,
          role: "assistant",
          content: "_" + res.note + "_",
          ts: Date.now(),
          note: true,
        });
      }
    } catch (err) {
      const target = active || lastAssistantForSources() || { id: ++seq, role: "assistant", content: "", ts: Date.now() };
      if (!state.messages.includes(target)) state.messages.push(target);
      if (err && err.name === "AbortError") {
        target.content = (target.content || "") + "\n\n*（已停止生成）*";
      } else {
        target.error = (err && err.message) || String(err);
      }
      active = target;
    } finally {
      state.busy = false;
      state.abort = null;
      state.confirm = null;
      setBusy(false);
      if (ctxSources && ctxSources.length) {
        const holder = lastAssistantForSources();
        if (holder) holder.sources = ctxSources;
      }
      const target = active;
      if (target && target.id) flushMd(msgNode(target.id), target);
      renderMessages();
      autoScroll();
      persist();
    }
  }

  function stop() {
    if (state.confirm) {
      decideTools(false);
      return;
    }
    if (state.abort) {
      try {
        state.abort.abort();
      } catch (e) {
        /* ignore */
      }
    }
  }

  function setBusy(busy) {
    if (!el.send) return;
    el.send.textContent = busy ? "停止" : "发送";
    el.send.classList.toggle("busy", !!busy);
    if (el.status) el.status.textContent = busy ? "正在生成…" : "";
  }

  /* ------------------------------ 消息操作 ------------------------------ */

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch (e2) {
        return false;
      }
    }
  }

  async function insertIntoGraph(text) {
    const ls = global.logseq;
    const content = String(text || "").trim();
    if (!content) return;
    // 优先用打开面板时记录的块：此时焦点在 iframe 里，getCurrentBlock 可能已经拿不到
    let block = await ls.Editor.getCurrentBlock().catch(() => null);
    if (!block && state.current.block && state.current.block.uuid) block = state.current.block;
    if (block && block.uuid) {
      await ls.Editor.insertBlock(block.uuid, content, { sibling: true });
    } else {
      const page = await ls.Editor.getCurrentPage().catch(() => null);
      if (!page || !page.name) {
        toast("先打开一个页面再插入", "warning");
        return;
      }
      await ls.Editor.appendBlockInPage(page.name, content);
    }
    toast("已插入到图谱");
  }

  function messageById(id) {
    return state.messages.find((m) => String(m.id) === String(id));
  }

  async function onMessagesClick(e) {
    const codeBtn = e.target.closest("[data-copy-code]");
    if (codeBtn) {
      const pre = codeBtn.closest(".cp-code").querySelector("code");
      const ok = await copyText(pre ? pre.textContent : "");
      codeBtn.textContent = ok ? "已复制" : "失败";
      setTimeout(() => (codeBtn.textContent = "复制"), 1200);
      return;
    }

    const actBtn = e.target.closest("[data-msg-act]");
    if (actBtn) {
      const act = actBtn.getAttribute("data-msg-act");
      if (act === "apply-tools") {
        decideTools(true);
        return;
      }
      if (act === "cancel-tools") {
        decideTools(false);
        return;
      }
      const msgEl = actBtn.closest(".cp-msg");
      const m = messageById(msgEl && msgEl.getAttribute("data-mid"));
      if (act === "gear") {
        global.logseq.showSettingsUI();
        return;
      }
      if (!m) return;
      if (act === "copy") {
        const ok = await copyText(m.content);
        toast(ok ? "已复制" : "复制失败", ok ? "success" : "error");
      } else if (act === "insert") {
        try {
          await insertIntoGraph(m.content);
        } catch (err) {
          toast("插入失败：" + err.message, "error");
        }
      } else if (act === "retry") {
        if (state.busy) return;
        const idx = state.messages.indexOf(m);
        state.messages.splice(idx, 1);
        renderMessages();
        await turn();
      }
      return;
    }

  }

  function onHeadClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    if (act === "pin") {
      pinCurrentPage().catch((err) => toast("加入上下文失败：" + err.message, "error"));
    } else if (act === "sessions") {
      toggleSessions();
    } else if (act === "new") {
      newChat();
    } else if (act === "gear") {
      try {
        global.logseq.showSettingsUI();
      } catch (err) {
        toast("打不开设置：" + err.message, "error");
      }
    } else if (act === "close") {
      close();
    }
  }

  function onContextClick(e) {
    const pinned = e.target.closest("[data-pin]");
    if (pinned) {
      const name = pinned.getAttribute("data-pin");
      state.pinned = state.pinned.filter((p) => p.name !== name);
      renderContext();
      return;
    }
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    if (act === "toggle-page") {
      state.usePage = !state.usePage;
      renderContext();
    } else if (act === "toggle-block") {
      state.useBlock = !state.useBlock;
      renderContext();
    } else if (act === "add-page") {
      openPagePicker();
    }
  }

  /* ------------------------------ 提示词 ------------------------------ */

  function promptList() {
    return (CP.chatPrompts || []).slice();
  }

  function renderPromptMenu() {
    const items = promptList();
    el.promptMenu.innerHTML = items.length
      ? items
          .map(
            (p) =>
              '<div class="cp-prompt-item" data-prompt="' +
              esc(p.id) +
              '" data-text="' +
              esc(p.text) +
              '"><span class="cp-prompt-label">' +
              esc(p.label) +
              '</span><span class="cp-prompt-desc">' +
              esc(p.desc || "") +
              "</span></div>"
          )
          .join("")
      : '<div class="cp-empty">没有可用提示词</div>';
  }

  function togglePromptMenu() {
    const willShow = el.promptMenu.hidden;
    el.promptMenu.hidden = !willShow;
    if (willShow) renderPromptMenu();
  }

  /* ------------------------------ 会话持久化 ------------------------------ */

  /** 会话存成「图谱目录里的一个文件」：工作区的实体化 */
  async function persist() {
    if (!state.messages.length || !CP.ws) return;
    try {
      if (!state.sessionId) state.sessionId = CP.ws.newId();
      if (!state.sessionCreated) state.sessionCreated = Date.now();
      const title = (state.messages.find((m) => m.role === "user") || {}).content || "新对话";
      const messages = state.messages
        .map((m) => {
          if (m.kind === "tool") {
            const lines = (m.results || []).map(
              (r, i) =>
                (r && r.ok ? "✓ " : "✕ ") +
                (((m.calls || [])[i] || {}).title || "") +
                "：" +
                String((r && r.message) || "").split("\n")[0]
            );
            if (!lines.length) return null;
            return { role: "assistant", content: "🔧 **操作记录**\n\n" + lines.join("\n"), toolSummary: true, ts: m.ts };
          }
          if (!m.content) return null;
          return {
            role: m.role,
            content: m.content,
            reasoning: m.reasoning || "",
            error: m.error || "",
            sources: m.sources || [],
            kind: m.kind || "",
            ts: m.ts || 0,
          };
        })
        .filter(Boolean);
      await CP.ws.saveSession({
        id: state.sessionId,
        title: String(title).replace(/\s+/g, " ").slice(0, 60),
        created: state.sessionCreated,
        updated: Date.now(),
        model: (global.logseq.settings || {}).model || "",
        provider: (global.logseq.settings || {}).provider || "",
        messages: messages,
      });
    } catch (e) {
      /* 存不下来不影响对话 */
    }
  }

  async function restore() {
    try {
      if (CP.ws) await CP.ws.migrateLegacy();
    } catch (e) {
      /* ignore */
    }
    try {
      const s = CP.ws ? await CP.ws.latest() : null;
      if (s && s.messages && s.messages.length) {
        state.sessionId = s.id;
        state.sessionCreated = s.created;
        state.messages = s.messages.map((m) => Object.assign({ id: ++seq }, m));
      }
    } catch (e) {
      /* ignore */
    }
    if (!state.messages.length && !hasApiKey()) {
      state.messages.push(welcomeMessage());
    }
    renderMessages();
    applyModelLabel();
    renderToolsButton();
    refreshWorkspace();
  }

  function welcomeMessage() {
    return {
      id: ++seq,
      role: "assistant",
      kind: "welcome",
      content: [
        "**我是 Akyuu ✦** —— 你的 Logseq 笔记助手。",
        "",
        "还没有配置模型，三步就能开始：",
        "",
        "1. 点右上角 ⚙ 打开插件设置",
        "2. 选择供应商，填入 API Key 和模型名（默认 DeepSeek；本地 Ollama 不需要 Key）",
        "3. 回到这里，直接提问 —— 当前页面会自动作为上下文",
        "",
        "> 提示：`Ctrl/Cmd + Shift + J` 可以随时唤起这个面板。",
      ].join("\n"),
    };
  }

  function hasApiKey() {
    try {
      const c = CP.llm.resolve();
      return !!c.apiKey || CP.llm.isLocal(c.baseUrl);
    } catch (e) {
      return false;
    }
  }

  async function newChat() {
    if (state.busy) {
      toast("正在生成，先停止再新建", "warning");
      return;
    }
    if (state.messages.length) await persist();
    state.messages = [];
    state.toolAllow = {};
    state.sessionId = CP.ws ? CP.ws.newId() : "c" + Date.now();
    state.sessionCreated = Date.now();
    if (!hasApiKey()) state.messages.push(welcomeMessage());
    renderMessages();
    el.input.focus();
  }

  /* ------------------------------ 位置与大小 ------------------------------ */

  let geom = null; // { top, right, width, height }
  let geomRaf = 0;

  function screenW() {
    return (global.screen && global.screen.availWidth) || 1440;
  }

  function screenH() {
    return (global.screen && global.screen.availHeight) || 900;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function defaultGeom() {
    const s = global.logseq.settings || {};
    const width = Math.max(340, Math.min(960, Number(s.panelWidth) || 460));
    const availH = screenH();
    const availW = screenW();
    return {
      width: width,
      right: clamp(20, 8, Math.max(8, availW - width - 8)),
      top: 56,
      height: Math.max(360, Math.min(860, availH - 112)),
    };
  }

  function sanitizeGeom(g) {
    const d = defaultGeom();
    const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
    const width = clamp(num(g.width, d.width), 340, Math.min(960, screenW() - 24));
    return {
      width: width,
      height: clamp(num(g.height, d.height), 320, Math.max(320, screenH() - 5)),
      top: clamp(num(g.top, d.top), 0, Math.max(0, screenH() - 120)),
      right: clamp(num(g.right, d.right), 0, Math.max(0, screenW() - width)),
    };
  }

  function applyGeom() {
    if (!geom) geom = defaultGeom();
    try {
      global.logseq.setMainUIInlineStyle({
        position: "fixed",
        zIndex: "9999",
        top: geom.top + "px",
        right: geom.right + "px",
        left: "auto",
        width: geom.width + "px",
        height: geom.height + "px",
        border: "none",
        background: "transparent",
        boxShadow: "none",
        borderRadius: "16px",
      });
    } catch (e) {
      /* ignore */
    }
  }

  function applyGeomSoon() {
    if (geomRaf) return;
    geomRaf = requestAnimationFrame(() => {
      geomRaf = 0;
      applyGeom();
    });
  }

  function persistGeom() {
    try {
      CP.store.set("geom", geom);
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 用 screenX/screenY 算位移：iframe 自己在动，用 clientX 会抖。
   * mode: 'move' 拖标题栏 | 'x' 拖左边缘改宽 | 'y' 拖下边缘改高
   */
  function beginDrag(e, mode, target) {
    if (e.button !== 0 && e.button !== undefined) return;
    const startX = e.screenX;
    const startY = e.screenY;
    const base = { top: geom.top, right: geom.right, width: geom.width, height: geom.height };
    try {
      target.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
    document.body.classList.add("cp-dragging");

    const move = (ev) => {
      const dx = ev.screenX - startX;
      const dy = ev.screenY - startY;
      if (mode === "move") {
        geom.top = clamp(base.top + dy, 0, Math.max(0, screenH() - 120));
        geom.right = clamp(base.right - dx, 0, Math.max(0, screenW() - geom.width - 8));
      } else if (mode === "x") {
        geom.width = clamp(base.width - dx, 340, Math.max(340, Math.min(960, screenW() - 24)));
        geom.right = clamp(geom.right, 0, Math.max(0, screenW() - geom.width - 8));
      } else if (mode === "y") {
        geom.height = clamp(base.height + dy, 320, Math.max(320, screenH() - geom.top - 8));
      }
      applyGeomSoon();
    };

    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      try {
        target.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      document.body.classList.remove("cp-dragging");
      applyGeom();
      persistGeom();
    };

    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  function resetGeom() {
    geom = defaultGeom();
    applyGeom();
    persistGeom();
    toast("面板位置已复位");
  }

  /* ------------------------------ 打开 / 关闭 ------------------------------ */

  function open(opts) {
    const o = opts || {};
    applyGeom();
    try {
      global.logseq.showMainUI({ autoFocus: true });
    } catch (e) {
      /* ignore */
    }
    state.open = true;
    applyModelLabel();
    renderToolsButton();
    refreshContext();
    refreshWorkspace();
    if (o.prefill) {
      el.input.value = o.prefill;
      autosize();
    }
    if (o.pinCurrentPage) pinCurrentPage();
    if (o.ask) {
      // 等上下文刷新一拍再发，避免把上一页当成当前页
      setTimeout(() => send(String(o.ask)), 120);
    } else {
      setTimeout(() => el.input.focus(), 60);
    }
  }

  function close() {
    persist();
    state.open = false;
    try {
      global.logseq.hideMainUI({ restoreEditingCursor: true });
    } catch (e) {
      /* ignore */
    }
  }

  let lastToggle = 0;

  function toggle() {
    // 宿主快捷键和 iframe 内兜底可能同时触发，去重一下防止「开了又关」
    const now = Date.now();
    if (now - lastToggle < 250) return;
    lastToggle = now;
    if (state.open) close();
    else open();
  }

  function autosize() {
    if (!el.input) return;
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 180) + "px";
  }

  /** 把一段现成的 Markdown（如自检报告）作为一条助手消息塞进面板 */
  function showReport(markdown) {
    open();
    state.messages.push({
      id: ++seq,
      role: "assistant",
      kind: "report",
      content: String(markdown || ""),
      ts: Date.now(),
    });
    renderMessages();
    autoScroll(true);
    persist();
  }

  CP.panel = {
    mount: mount,
    open: open,
    close: close,
    toggle: toggle,
    restore: restore,
    refreshContext: refreshContext,
    refreshSettings: function () {
      applyModelLabel();
      renderToolsButton();
      refreshTheme();
    },
    refreshWorkspace: refreshWorkspace,
    pinCurrentPage: pinCurrentPage,
    newChat: newChat,
    send: send,
    loadSession: loadSession,
    toggleSessions: toggleSessions,
    cycleToolPolicy: cycleToolPolicy,
    hasApiKey: hasApiKey,
    showReport: showReport,
    state: state,
    template: template,
    render: renderMessages,
    themeInfo: themeInfo,
    toast: toast,
  };
})(typeof window !== "undefined" ? window : globalThis);
