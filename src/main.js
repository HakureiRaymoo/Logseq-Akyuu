/**
 * 插件入口：设置项、命令注册、把「快捷改写」写回图谱，以及启动面板。
 */
(function (global) {
  const CP = (global.CP = global.CP || {});
  const ls = () => global.logseq;

  const PROVIDERS = ["deepseek", "openai", "siliconflow", "moonshot", "openrouter", "ollama", "lmstudio", "anthropic", "google", "custom"];

  const SCHEMA = [
    { key: "h-model", type: "heading", title: "模型", description: "选一个供应商，填 Key 与模型名即可；本地 Ollama / LM Studio 不用 Key。", default: null },

    { key: "provider", type: "enum", title: "供应商", description: "默认 DeepSeek（deepseek-chat / deepseek-reasoner）；OpenAI 兼容接口统一走 /chat/completions", default: "deepseek", enumChoices: PROVIDERS, enumPicker: "select" },

    { key: "apiKey", type: "string", title: "API Key", description: "仅保存在本机，随插件设置存储", default: "" },

    { key: "baseUrl", type: "string", title: "接口地址 baseUrl", description: "留空使用供应商默认值，例如 https://api.deepseek.com/v1", default: "" },

    { key: "model", type: "string", title: "模型名", description: "例如 gpt-4o-mini / deepseek-chat / claude-3-5-sonnet-latest / gemini-2.0-flash", default: "" },

    { key: "temperature", type: "number", title: "温度 temperature", description: "0~2，越低越稳定", default: 0.7 },

    { key: "maxTokens", type: "number", title: "最大输出 token", description: "Anthropic 必填；其他供应商留 0 表示用默认", default: 2048 },

    { key: "h-ctx", type: "heading", title: "上下文", description: "决定每次提问时把多少笔记内容一起发给模型。", default: null },

    { key: "smartContext", type: "boolean", title: "自动图谱检索", description: "每次提问前按关键词在整张图里检索相关块（查询扩展 → 召回 → BM25 排序 → 图信号加成）", default: true },

    { key: "queryExpansion", type: "boolean", title: "智能查询扩展", description: "先用小模型把问题扩成同义关键词和改写问法，能显著提高召回；关掉可省一次小请求", default: true },

    { key: "contextChars", type: "number", title: "上下文字符上限", description: "当前页 + 引用页 + 检索结果合计的截断长度", default: 6000 },

    { key: "historyTurns", type: "number", title: "记住多少轮对话", description: "每次请求携带的历史消息轮数", default: 8 },

    { key: "h-agent", type: "heading", title: "行动能力（让 AI 真的改笔记）", description: "开启后 Akyuu 可以读页面、检索、新建页面、插入/改写/移动块、加标签、改 TODO、删块。改笔记前会先让你确认。", default: null },

    { key: "enableTools", type: "boolean", title: "允许操作 Logseq", description: "关掉后它只能聊天和给建议，不会写入任何块（更保险）", default: true },

    { key: "toolPolicy", type: "enum", title: "写操作确认策略", description: "confirm＝每次都问你（推荐）；auto＝直接执行（删除类仍会问）；off＝不提供工具", default: "confirm", enumChoices: ["confirm", "auto", "off"], enumPicker: "select" },

    { key: "toolProtocol", type: "enum", title: "工具调用协议", description: "auto＝能原生调用的模型用 function calling，其余用文本协议；native／text 可强制（个别兼容模型不认 tools 时切 text）", default: "auto", enumChoices: ["auto", "native", "text"], enumPicker: "select" },

    { key: "toolMaxRounds", type: "number", title: "最多工具轮数", description: "一次提问里模型最多连续调用几轮工具（1~8），超过就停手；发「继续」可以接着做。调大更省事，但更容易一次改太多", default: 4 },

    { key: "h-prompt", type: "heading", title: "提示词", description: "", default: null },

    { key: "systemPrompt", type: "string", inputAs: "textarea", title: "系统提示词", description: "留空使用内置的 Akyuu 人格", default: "" },

    { key: "language", type: "enum", title: "回答语言", description: "", default: "zh", enumChoices: ["auto", "zh", "en"], enumPicker: "select" },

    { key: "customPrompts", type: "string", inputAs: "textarea", title: "自定义提示词（JSON）", description: '格式：[{"label":"提炼观点","prompt":"请提炼要点：\\n\\n{{content}}"}]，会自动出现在命令面板和块右键菜单里', default: "" },

    { key: "h-ui", type: "heading", title: "界面", description: "", default: null },

    { key: "appearance", type: "enum", title: "外观", description: "follow＝跟随 Logseq 的白天/暗夜配色（推荐）；也可强制亮或暗", default: "follow", enumChoices: ["follow", "light", "dark"], enumPicker: "select" },

    { key: "accentColor", type: "string", title: "强调色（可选）", description: "留空＝跟随 Logseq 主题色（--ls-link-text-color）；也可填 #106ba3 这类颜色", default: "" },

    { key: "panelWidth", type: "number", title: "面板宽度（px）", description: "340~960", default: 460 },
  ];

  /* ---------------------------- 快捷动作 ---------------------------- */

  const ACTIONS = [
    {
      id: "summarize-page",
      label: "总结当前页面",
      target: "page",
      prompt: "请总结下面这个 Logseq 页面：先用 3-6 条要点概括，再给一句话结论。只输出总结本身。\n\n{{content}}",
    },
    {
      id: "explain-block",
      label: "解释当前块",
      target: "block",
      prompt: "请解释下面这段笔记：它在说什么、为什么重要、可能有什么问题。语言简洁，必要时补充背景。\n\n{{content}}",
    },
    {
      id: "polish",
      label: "润色当前块",
      target: "block",
      prompt: "请润色下面的文字：保持原意与原语言，让表达更清晰、更精炼。只输出润色后的文本，不要解释。\n\n{{content}}",
    },
    {
      id: "translate",
      label: "翻译当前块",
      target: "block",
      prompt: "请翻译下面的内容：如果主要是中文就翻译成英文，否则翻译成简体中文。只输出译文。\n\n{{content}}",
    },
    {
      id: "continue",
      label: "续写当前块",
      target: "block",
      prompt: "请顺着下面这段内容的思路继续写 3-6 句，保持同样的语气与风格。只输出续写的部分。\n\n{{content}}",
    },
    {
      id: "outline",
      label: "生成大纲",
      target: "page",
      prompt: "请把下面的笔记整理成层级大纲（Markdown 列表，可嵌套）。只输出大纲。\n\n{{content}}",
    },
    {
      id: "todos",
      label: "提取待办",
      target: "page",
      prompt: "请从下面的笔记里提取所有可执行事项，改写成以「- [ ] 」开头的清单。只输出清单。\n\n{{content}}",
    },
    {
      id: "flashcards",
      label: "生成问答卡片",
      target: "page",
      prompt: "请把下面的内容改写成 5 组问答卡片，每组两行：\nQ: 问题\nA: 答案\n只输出卡片。\n\n{{content}}",
    },
    {
      id: "critique",
      label: "挑毛病",
      target: "block",
      prompt: "请以严格的审稿人视角指出下面这段内容的问题：逻辑漏洞、事实存疑、表达含糊之处，并给出修改建议。\n\n{{content}}",
    },
  ];

  /** 面板里的「提示词」菜单：直接可发的一段提问 */
  CP.chatPrompts = [
    { id: "p-sum", label: "总结这一页", desc: "要点 + 一句话结论", text: "请总结当前页面的要点，用列表输出，最后给一句话结论。" },
    { id: "p-todo", label: "这一页有什么待办", desc: "提取可执行项", text: "当前页面里有哪些待办/可执行事项？整理成 - [ ] 清单。" },
    { id: "p-next", label: "接下来该做什么", desc: "基于笔记给行动建议", text: "基于当前页面和检索到的相关笔记，给出 3 条接下来最值得做的事，并说明理由。" },
    { id: "p-link", label: "找我漏掉的关联", desc: "发现跨页联系", text: "根据当前页面与图谱检索结果，指出我可能忽略的跨页面关联，并给出建议的双链。" },
    { id: "p-clean", label: "把这一页整理成文章", desc: "重写成连贯正文", text: "把当前页面的笔记重写成一篇连贯的短文：保留事实，去掉碎片化表达，输出 Markdown。" },
    { id: "p-q", label: "生成 5 个问题", desc: "自我检验", text: "针对当前页面内容，生成 5 个由浅入深的思考题，并给出简要答案。" },
  ];

  /* ---------------------------- 设置读取 ---------------------------- */

  function settings() {
    return ls().settings || {};
  }

  function customActions() {
    const raw = String(settings().customPrompts || "").trim();
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((x) => x && x.label && x.prompt)
        .map((x, i) => ({
          id: "custom-" + i,
          label: String(x.label),
          prompt: String(x.prompt),
          target: x.target === "page" ? "page" : "block",
          custom: true,
        }));
    } catch (e) {
      return [];
    }
  }

  function allActions() {
    return ACTIONS.concat(customActions());
  }

  function actionById(id) {
    return allActions().find((a) => a.id === id);
  }

  /* ---------------------------- 快捷动作执行 ---------------------------- */

  async function resolveSource(action, opts) {
    const o = opts || {};
    const L = ls();
    const out = { anchor: null, pageName: null, text: "" };

    if (action.target === "page") {
      let page = o.pageName;
      if (!page) {
        const cur = await L.Editor.getCurrentPage().catch(() => null);
        page = cur && cur.name;
      }
      if (!page) throw new Error("先打开一个页面再用这个命令");
      out.pageName = page;
      out.text = await CP.ctx.pageMarkdown(page, 12000);
      if (!out.text) throw new Error("这个页面还是空的");
      return out;
    }

    if (action.target === "selection") {
      const sel = await L.Editor.getSelectedBlocks().catch(() => []);
      if (!sel || !sel.length) throw new Error("先选中一些块");
      out.anchor = sel[0];
      out.text = sel.map((b) => CP.ctx.cleanContent(b.content)).join("\n");
      return out;
    }

    const anchor = o.blockUuid ? await L.Editor.getBlock(o.blockUuid).catch(() => null) : await L.Editor.getCurrentBlock().catch(() => null);
    if (!anchor || !anchor.content) throw new Error("把光标放到一个块里再用这个命令");
    out.anchor = anchor;
    out.text = CP.ctx.cleanContent(anchor.content);
    return out;
  }

  async function runAction(action, opts) {
    if (!action) return;
    const L = ls();
    const o = opts || {};
    let src;
    try {
      src = await resolveSource(action, o);
    } catch (err) {
      CP.toast(err.message, "warning");
      return;
    }

    let holder = null;
    try {
      const placeholder = "⏳ Akyuu 正在生成： " + action.label + " …";
      if (src.anchor && src.anchor.uuid) {
        holder = await L.Editor.insertBlock(src.anchor.uuid, placeholder, { sibling: true });
      } else if (src.pageName) {
        holder = await L.Editor.appendBlockInPage(src.pageName, placeholder);
      }
      if (!holder) throw new Error("无法创建输出块");
    } catch (err) {
      CP.toast("插入失败：" + err.message, "error");
      return;
    }

    const prompt = String(action.prompt).replace(/\{\{\s*content\s*\}\}/g, src.text);
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let acc = "";
    let lastPush = 0;

    const push = async (final) => {
      const now = Date.now();
      if (!final && now - lastPush < 700) return;
      lastPush = now;
      try {
        await L.Editor.updateBlock(holder.uuid, final ? acc || "（模型没有返回内容）" : acc + " ▍");
      } catch (e) {
        /* 忽略刷新失败 */
      }
    };
    const timer = setInterval(() => push(false), 800);

    try {
      await CP.llm.chat({
        messages: [{ role: "user", content: prompt }],
        system: "你是 Akyuu（插件名 Logseq Akyuu），输出会直接写进用户的笔记块里。只输出最终结果，不要寒暄，不要复述要求。",
        signal: controller ? controller.signal : undefined,
        onDelta: (d) => {
          acc += d;
        },
      });
      clearInterval(timer);
      await L.Editor.updateBlock(holder.uuid, (acc || "（模型没有返回内容）").trim());
      CP.toast("完成：" + action.label, "success");
    } catch (err) {
      clearInterval(timer);
      const msg = acc ? acc + "\n\n⚠️ 生成中断：" + err.message : "⚠️ " + err.message;
      try {
        await L.Editor.updateBlock(holder.uuid, msg);
      } catch (e) {
        /* ignore */
      }
      CP.toast("生成失败：" + err.message, "error");
    }
  }

  /* ---------------------------- 注册入口 ---------------------------- */

  function workspaceReport(f, st) {
    const rows = [
      ["图谱", f.graph || "-"],
      ["图谱路径", f.path || "（Logseq 未提供）"],
      ["存储后端", f.label + "（" + f.kind + "）"],
      ["会话目录", f.dir || "（无）"],
      ["文件名", f.files],
      ["已存会话", String(st.count) + " 个"],
      ["最近一次", st.latest || "-"],
    ];
    return [
      "### 📁 Akyuu 的工作区",
      "",
      "| 项 | 值 |",
      "| --- | --- |",
    ]
      .concat(rows.map((r) => "| " + r[0] + " | " + String(r[1]).replace(/\|/g, "\\|") + " |"))
      .concat([
        "",
        "> " + (f.hint || ""),
        "> 每个会话两份：`.json` 给插件读，`.md` 给人读（可以直接拷进笔记）。",
      ])
      .join("\n");
  }

  /** 检索诊断：直接看图谱类型、用的正文键、命中数与报错 */
  async function runDiagnostics() {
    try {
      const active = await CP.ctx.active().catch(() => ({}));
      const term = (active.page && active.page.name) || "test";
      const p = await CP.retrieval.probe(term);
      const d = CP.retrieval.diag();
      const f = await CP.ws.folder().catch(() => null);
      const graphKind =
        p.caps.graph === "db" ? "DB 版（图谱目录里有 db.sqlite）" : p.caps.blocks > 0 ? "文件版（pages/*.md）" : "未知（块查询不通）";
      const rows = [
        ["图谱", f ? f.graph : "-"],
        ["图谱类型", graphKind],
        ["块总数", String(p.caps.blocks)],
        [":block/content 块数", String(p.caps.contentBlocks)],
        [":block/title 块数", String(p.caps.titleBlocks)],
        ["检索使用的正文键", ":block/" + p.caps.content],
        ["回收站页面（已排除）", String(p.deleted) + (p.deletedHit ? "（探测词本身就在回收站）" : "")],
        ["探测词", p.term || "-"],
        ["命中块", String(p.rows)],
        ["耗时", p.ms + " ms"],
        ["最近报错", p.error || "（无）"],
        ["累计查询 / 失败", d.queries + " / " + d.errors],
      ];
      const md = ["### 🔍 检索诊断", "", "| 项 | 值 |", "| --- | --- |"]
        .concat(rows.map((r) => "| " + r[0] + " | " + String(r[1]).replace(/\|/g, "\\|") + " |"))
        .concat(
          p.rows
            ? ["", "**命中样本**", ""].concat(p.samples.map((s) => "- [" + (s.page || "?") + "] " + s.text))
            : [
                "",
                "> 命中 0 块。若「块总数」很大但「命中块」是 0，多半是正文键不对（DB 版图谱用 `:block/title`），或者这个词确实不在任何块里。",
              ]
        );
      CP.panel.showReport(md.join("\n"));
    } catch (e) {
      CP.toast("诊断失败：" + ((e && e.message) || e), "error");
    }
  }

  function registerCommands() {
    const L = ls();
    const bind = (key, label, binding, fn) => {
      const opts = { key: key, label: label };
      if (binding) opts.keybinding = { binding: binding, mode: "global" };
      try {
        L.App.registerCommandPalette(opts, fn);
      } catch (e) {
        /* ignore */
      }
    };

    bind("akyuu-open", "Akyuu: 打开对话面板", "mod+shift+j", () => CP.panel.toggle());
    bind("akyuu-new", "Akyuu: 新对话", null, () => {
      CP.panel.open();
      CP.panel.newChat();
    });
    bind("akyuu-pin", "Akyuu: 把当前页面加入上下文", null, () => {
      CP.panel.open();
      CP.panel.pinCurrentPage();
    });
    bind("akyuu-selfcheck", "Akyuu: 运行自检（环境与写入）", null, () => {
      CP.toast("Akyuu 自检中…");
      CP.selfcheck
        .run()
        .then((r) => CP.toast(r.ok ? "自检完成" : "自检发现问题，见报告", r.ok ? "success" : "warning"))
        .catch((e) => CP.toast("自检失败：" + e.message, "error"));
    });
    bind("akyuu-workspace", "Akyuu: 显示工作区与会话目录", null, () => {
      CP.panel.open();
      Promise.all([CP.ws.folder(), CP.ws.stats()])
        .then(([f, st]) => CP.panel.showReport(workspaceReport(f, st)))
        .catch((e) => CP.toast("读取工作区失败：" + e.message, "error"));
    });
    bind("akyuu-sessions", "Akyuu: 历史会话", null, () => {
      CP.panel.open();
      setTimeout(() => CP.panel.toggleSessions(), 80);
    });
    bind("akyuu-diag", "Akyuu: 检索诊断（图谱查询）", null, () => {
      CP.panel.open();
      runDiagnostics();
    });
    bind("akyuu-toolmode", "Akyuu: 切换工具模式（需确认/自动/关闭）", null, () => {
      CP.panel.cycleToolPolicy();
    });

    allActions().forEach((a) => {
      bind("akyuu-" + a.id, "Akyuu: " + a.label, null, () => runAction(a));
    });
  }

  function registerMenus() {
    const L = ls();
    const blockActions = allActions().filter((a) => a.target !== "page");
    blockActions.forEach((a) => {
      try {
        L.Editor.registerBlockContextMenuItem("Akyuu: " + a.label, (e) => runAction(a, { blockUuid: e && e.uuid }));
      } catch (e) {
        /* ignore */
      }
    });

    try {
      L.Editor.registerHighlightContextMenuItem("Akyuu: 解释这段", (e) => {
        const explain = actionById("explain-block");
        runAction(explain, { blockUuid: e && e.uuid });
      });
    } catch (e) {
      /* ignore */
    }

    try {
      L.App.registerPageMenuItem("Akyuu: 总结此页面", (e) => {
        runAction(actionById("summarize-page"), { pageName: e && e.page });
      });
    } catch (e) {
      /* ignore */
    }
  }

  function registerSlash() {
    try {
      ls().Editor.registerSlashCommand("akyuu", async (e) => {
        CP.panel.open();
        try {
          const b = e && e.uuid ? await ls().Editor.getBlock(e.uuid) : null;
          if (b && /\/akyuu\s*$/.test(b.content || "")) await ls().Editor.updateBlock(b.uuid, "");
        } catch (err) {
          /* ignore */
        }
      });
    } catch (e) {
      /* ignore */
    }
  }

  function registerUiEntries() {
    const L = ls();
    try {
      L.provideStyle(`
        .cp-trigger-btn {
          display: inline-flex; align-items: center; justify-content: center;
          width: 22px; height: 22px; border-radius: 6px;
          color: var(--ls-link-text-color, #6d5efc); cursor: pointer;
          font-size: 13px; line-height: 1; opacity: .75;
        }
        .cp-trigger-btn:hover { opacity: 1; background: var(--ls-tertiary-background-color, rgba(0,0,0,.06)); }
      `);
      L.provideModel({
        openAkyuu() {
          CP.panel.open();
        },
      });
      L.provideUI({
        key: "akyuu-trigger",
        path: "#search",
        template: '<a class="cp-trigger-btn" data-on-click="openAkyuu" title="Logseq Akyuu">✦</a>',
      });
    } catch (e) {
      /* ignore */
    }
  }

  /* ---------------------------- 启动 ---------------------------- */

  async function main() {
    try {
      ls().useSettingsSchema(SCHEMA);
    } catch (e) {
      console.warn("[akyuu] useSettingsSchema failed", e);
    }

    try {
      await CP.panel.mount();
    } catch (e) {
      console.error("[akyuu] mount failed", e);
    }

    try {
      await CP.panel.restore();
    } catch (e) {
      console.error("[akyuu] restore failed", e);
    }

    registerCommands();
    registerMenus();
    registerSlash();
    registerUiEntries();

    try {
      ls().onSettingsChanged(() => CP.panel.refreshSettings());
    } catch (e) {
      /* ignore */
    }

    console.log("[akyuu] ready · provider =", (settings().provider || "openai"));
  }

  global.logseq.ready(main).catch((e) => console.error("[akyuu] boot failed", e));
})(typeof window !== "undefined" ? window : globalThis);
