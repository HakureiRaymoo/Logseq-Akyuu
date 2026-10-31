/**
 * Logseq 操作工具集 —— 让 Akyuu 真的能动手，而不只是输出文字。
 *
 * 设计要点：
 *   1. 一张注册表：每个工具 = JSON Schema（给模型看）+ 预览文案（给人看）+ 执行函数。
 *   2. 写操作一律 `write: true`，删除再标 `danger: true`：面板据此要求确认。
 *   3. 所有 uuid / 页面名都支持 "current"，让模型能说「改光标这一块」而不用背 uuid。
 *   4. 只调用公开的 Editor API；某个 API 在当前版本不存在时给出明确错误，而不是静默失败。
 */
(function (global) {
  const CP = (global.CP = global.CP || {});
  const ls = () => global.logseq;

  const CUR = ["current", "cursor", "here", "this", "当前", "这", "光标"];

  function isCurrent(v) {
    if (v == null || v === "") return true;
    return typeof v === "string" && CUR.indexOf(v.trim().toLowerCase()) >= 0;
  }

  function need(v, name) {
    if (v == null || String(v).trim() === "") throw new Error("缺少参数 " + name);
    return v;
  }

  function oneLine(s, n) {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  }

  function clean(s) {
    return CP.ctx && CP.ctx.cleanContent ? CP.ctx.cleanContent(s) : String(s == null ? "" : s).trim();
  }

  async function safe(fn, fallback) {
    try {
      const v = await fn();
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  /* ------------------------------ 定位辅助 ------------------------------ */

  async function resolveBlock(ref) {
    const r = isCurrent(ref) ? null : String(ref).trim();
    if (!r) {
      const b = await safe(() => ls().Editor.getCurrentBlock(), null);
      if (!b || !b.uuid) throw new Error("当前没有光标所在的块：请先在 Logseq 里点一下某个块，或给出块 uuid");
      return b;
    }
    const b = await safe(() => ls().Editor.getBlock(r), null);
    if (!b) throw new Error("找不到块 " + r + "（uuid 不对，或块已被删除）");
    return b;
  }

  async function resolvePage(ref) {
    if (!isCurrent(ref)) {
      const name = String(ref).trim();
      const p = await safe(() => ls().Editor.getPage(name), null);
      return { name: name, page: p };
    }
    const p = await safe(() => ls().Editor.getCurrentPage(), null);
    if (!p || !p.name) throw new Error("当前没有打开任何页面");
    return { name: p.name, page: p };
  }

  /** 页面属性挂在第一个块上；空页面就造一个块来承载 */
  async function firstBlockOf(pageName) {
    const tree = await safe(() => ls().Editor.getPageBlocksTree(pageName), []);
    const first = (tree || []).filter((b) => b && b.uuid)[0];
    if (first) return first;
    const b = await ls().Editor.appendBlockInPage(pageName, "");
    if (!b || !b.uuid) throw new Error("《" + pageName + "》是空页面，建不出承载属性的块");
    return b;
  }

  async function topLevelBlocks(pageName) {
    const tree = await safe(() => ls().Editor.getPageBlocksTree(pageName), []);
    return (tree || []).filter((b) => b && b.uuid);
  }

  /** 按缩进把多行文本还原成块树，并逐级写入（遵循 Logseq 的父子关系） */
  function parseTree(lines) {
    const root = [];
    const stack = [{ indent: -1, children: root }];
    (lines || []).forEach((raw) => {
      const text = String(raw == null ? "" : raw);
      if (!text.trim()) return;
      const indent = (text.match(/^[\t ]*/) || [""])[0].replace(/\t/g, "  ").length;
      const node = { text: text.trim(), children: [] };
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      stack[stack.length - 1].children.push(node);
      stack.push({ indent: indent, children: node.children });
    });
    return root;
  }

  async function writeSiblings(nodes, parentBlock, pageName) {
    let prev = null;
    let count = 0;
    for (const n of nodes) {
      let block;
      if (prev) block = await ls().Editor.insertBlock(prev.uuid, n.text, { sibling: true });
      else if (parentBlock) block = await ls().Editor.insertBlock(parentBlock.uuid, n.text, { sibling: false });
      else block = await ls().Editor.appendBlockInPage(pageName, n.text);
      if (!block || !block.uuid) throw new Error("写入块失败：" + oneLine(n.text, 30));
      count++;
      if (n.children.length) count += await writeSiblings(n.children, block, pageName);
      prev = block;
    }
    return count;
  }

  const TODO_RE = /^\s*(TODO|DOING|NOW|LATER|WAITING|DONE|CANCELED)\s+/i;

  /* ------------------------------ 工具注册表 ------------------------------ */

  const TOOLS = [
    {
      name: "list_pages",
      title: "查找页面",
      write: false,
      description:
        "按关键词模糊查找图谱里的页面名（中文用子串匹配）。动手改笔记前先用它确认页面是否存在、叫什么。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "关键词；留空列出最近的页面" },
          limit: { type: "number", description: "最多返回几个，默认 20，上限 50" },
        },
        required: [],
      },
      preview: (a) => "查找页面" + (a.query ? "：" + a.query : "（全部）"),
      async run(a) {
        const limit = Math.min(50, Math.max(1, Number(a.limit) || 20));
        const q = String(a.query || "").trim().toLowerCase();
        const pages = await safe(() => ls().Editor.getAllPages(), []);
        // DB 版图谱把删除的页面留在库里（回收站），getAllPages 仍会返回，得自己滤掉
        const deleted =
          CP.retrieval && CP.retrieval.deletedPageNames
            ? await CP.retrieval.deletedPageNames().catch(() => new Set())
            : new Set();
        const all = (pages || [])
          .map((p) => p && (p.originalName || p.name))
          .filter(Boolean);
        const names = all.filter((n) => !deleted.has(String(n).toLowerCase()));
        const hidden = all.length - names.length;
        const matched = names.filter((n) => !q || n.toLowerCase().indexOf(q) >= 0);
        // 完全同名 > 前缀命中 > 只是包含，短的优先；避免「读书笔记」先列出一堆「读书笔记1234」
        const rank = (n) => {
          const l = n.toLowerCase();
          if (l === q) return 0;
          if (l.indexOf(q) === 0) return 1;
          return 2;
        };
        matched.sort((x, y) => rank(x) - rank(y) || x.length - y.length || x.localeCompare(y));
        const hits = matched.slice(0, limit);
        const exact = q && matched.some((n) => n.toLowerCase() === q);
        const note = hidden > 0 ? "（已排除回收站里的 " + hidden + " 个页面）" : "";
        return {
          ok: true,
          message: hits.length
            ? hits.length + " 个页面" + (exact ? "（含同名页面）" : "") + note + "：\n" + hits.map((n) => "- " + n).join("\n")
            : "没有匹配的页面" + note,
          data: hits,
        };
      },
    },
    {
      name: "read_page",
      title: "读取页面",
      write: false,
      description: "读出某个页面（或当前页面）的完整块树，Markdown 缩进形式。写之前先读，能避免覆盖用户内容。",
      parameters: {
        type: "object",
        properties: {
          page: { type: "string", description: "页面名；填 current 表示当前页面" },
          max_chars: { type: "number", description: "最多返回多少字符，默认 8000" },
        },
        required: [],
      },
      preview: (a) => "读取页面" + (isCurrent(a.page) ? "（当前页）" : "《" + a.page + "》"),
      async run(a) {
        const p = await resolvePage(a.page);
        const md = await CP.ctx.pageMarkdown(p.name, Math.min(20000, Number(a.max_chars) || 8000));
        return { ok: true, message: md ? "《" + p.name + "》：\n" + md : "《" + p.name + "》是空的", data: { page: p.name } };
      },
    },
    {
      name: "get_block",
      title: "读取块",
      write: false,
      description: "按 uuid 或 current 读出单个块的内容与所属页面（含子块）。",
      parameters: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "块 uuid；填 current 表示光标所在块" },
        },
        required: [],
      },
      preview: (a) => "读取块 " + (isCurrent(a.uuid) ? "（光标块）" : a.uuid),
      async run(a) {
        const b = await resolveBlock(a.uuid);
        const page = (b.page && (b.page.originalName || b.page.name)) || "";
        const lines = [clean(b.content)];
        (b.children || []).forEach((c) => lines.push("  - " + clean(c.content)));
        return {
          ok: true,
          message: "块 " + b.uuid + (page ? "（页面《" + page + "》）" : "") + "：\n" + lines.join("\n"),
          data: { uuid: b.uuid, page: page },
        };
      },
    },
    {
      name: "search_graph",
      title: "检索图谱",
      write: false,
      description: "在整张图里按关键词做块级检索（BM25 排序），返回 uuid + 所在页面 + 内容摘要。需要找「哪里提过这件事」时用。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词，可以是中文短语" },
          limit: { type: "number", description: "返回条数，默认 8" },
        },
        required: ["query"],
      },
      preview: (a) => "检索图谱：" + a.query,
      async run(a) {
        const q = need(a.query, "query");
        const limit = Math.min(30, Math.max(1, Number(a.limit) || 8));
        const hits = await safe(() => CP.retrieval.searchBlocks(q, limit), []);
        if (!hits.length) {
          // 空结果分三种：页面不存在 / 页面存在但没块 / 页面有块但没这段文字 —— 说清楚，别让模型瞎猜
          const page = await safe(() => ls().Editor.getPage(String(q).trim()), null);
          const deleted =
            CP.retrieval && CP.retrieval.deletedPageNames
              ? await CP.retrieval.deletedPageNames().catch(() => new Set())
              : new Set();
          const isDeleted = deleted.has(String(q).trim().toLowerCase());
          let why;
          if (isDeleted) {
            why = "页面《" + q + "》已经被删除（在回收站里，可用 restore_page 恢复），所以检索不到它的内容";
          } else if (page) {
            const name = page.originalName || page.name;
            const tree = await safe(() => ls().Editor.getPageBlocksTree(name), []);
            const all = (tree || []).filter((b) => b && b.uuid);
            const filled = all.filter((b) => String(CP.ctx.cleanContent(b.content) || "").trim());
            why =
              filled.length === 0
                ? "页面《" + name + "》存在，但它是空的（" + all.length + " 个块都没有文字，可能只被 [[链接]] 引用过）"
                : "页面《" + name + "》存在，有 " + filled.length + " 个有内容的顶层块，但没有块的文字包含「" + q + "」";
          } else {
            why = "图谱里没有叫《" + q + "》的页面，块内容里也没有这段文字";
          }
          return { ok: true, message: "没有检索到「" + q + "」：" + why + "。可以先用 read_page 读整页，或用 list_pages 确认真实页面名。", data: [] };
        }
        const lines = hits.map(
          (h) => "- [" + (h.page || "?") + "] uuid=" + h.uuid + " " + oneLine(h.content, 120)
        );
        return { ok: true, message: "命中 " + hits.length + " 块：\n" + lines.join("\n"), data: hits };
      },
    },
    {
      name: "create_page",
      title: "新建页面",
      write: true,
      description:
        "新建一个页面，可同时写入若干块（支持用两个空格缩进表示层级）。页面已存在时不会覆盖，会返回提示。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "页面名，例如「项目复盘 2024-11」" },
          blocks: { type: "array", items: { type: "string" }, description: "要写入的块，按顺序排列" },
        },
        required: ["name"],
      },
      preview: (a) =>
        "新建页面《" + (a.name || "?") + "》" +
        (a.blocks && a.blocks.length ? "，并写入 " + a.blocks.length + " 个块：\n" + a.blocks.map((b) => "  · " + oneLine(b, 60)).join("\n") : ""),
      async run(a) {
        const name = String(need(a.name, "name")).trim();
        const exists = await safe(() => ls().Editor.getPage(name), null);
        if (exists) return { ok: false, message: "页面《" + name + "》已存在，未做修改（要追加内容请用 append_blocks）" };
        const page = await ls().Editor.createPage(name, {}, { redirect: false, createFirstBlock: false });
        if (!page) return { ok: false, message: "创建页面失败（同名页面可能存在，或名称含非法字符）" };
        let blocks = 0;
        if (a.blocks && a.blocks.length) {
          blocks = await writeSiblings(parseTree(a.blocks), null, (page && (page.originalName || page.name)) || name);
        }
        return { ok: true, message: "已新建页面《" + name + "》" + (blocks ? "，写入 " + blocks + " 个块" : ""), data: { page: name, blocks: blocks } };
      },
    },
    {
      name: "insert_block",
      title: "插入块",
      write: true,
      description:
        "插入一个新块。mode：after 放在 uuid 块之后（默认，uuid 留空=光标块）、child 作为它的子块、page-end 追加到指定页面末尾。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "块内容，Markdown" },
          mode: { type: "string", enum: ["after", "child", "page-end"], description: "插入位置，默认 after" },
          uuid: { type: "string", description: "参照块 uuid，或 current" },
          page: { type: "string", description: "mode=page-end 时的页面名，或 current" },
        },
        required: ["content"],
      },
      preview: async (a) => {
        const mode = a.mode || "after";
        if (mode === "page-end") {
          return "在页面" + (isCurrent(a.page) ? "（当前页）" : "《" + a.page + "》") + "末尾追加：" + oneLine(a.content, 80);
        }
        if (mode === "child") {
          const b = await resolveBlock(a.uuid).catch(() => null);
          return "在块「" + oneLine(b ? clean(b.content) : a.uuid || "光标块", 40) + "」下面新建子块：" + oneLine(a.content, 80);
        }
        const b = await resolveBlock(a.uuid).catch(() => null);
        return "在块「" + oneLine(b ? clean(b.content) : a.uuid || "光标块", 40) + "」之后插入：" + oneLine(a.content, 80);
      },
      async run(a) {
        const content = String(need(a.content, "content")).trim();
        const mode = a.mode || "after";
        if (mode === "page-end") {
          const p = await resolvePage(a.page);
          const block = await ls().Editor.appendBlockInPage(p.name, content);
          if (!block) throw new Error("追加失败");
          return { ok: true, message: "已追加到《" + p.name + "》末尾", data: { uuid: block.uuid } };
        }
        const target = await resolveBlock(a.uuid);
        const block = await ls().Editor.insertBlock(target.uuid, content, { sibling: mode !== "child" });
        if (!block) throw new Error("插入失败");
        return {
          ok: true,
          message: "已插入到块 " + target.uuid + (mode === "child" ? " 下面（子块）" : " 之后"),
          data: { uuid: block.uuid },
        };
      },
    },
    {
      name: "append_blocks",
      title: "追加多个块",
      write: true,
      description: "往页面末尾追加一整组块（数组，支持两个空格缩进表示子块）。适合把整理好的大纲/清单写进笔记。",
      parameters: {
        type: "object",
        properties: {
          page: { type: "string", description: "页面名，留空或用 current 表示当前页" },
          blocks: { type: "array", items: { type: "string" }, description: "块内容数组，顺序即上下顺序" },
        },
        required: ["blocks"],
      },
      preview: (a) =>
        "在页面" + (isCurrent(a.page) ? "（当前页）" : "《" + a.page + "》") + "末尾追加 " +
        ((a.blocks && a.blocks.length) || 0) + " 个块：\n" +
        (a.blocks || []).slice(0, 8).map((b) => "  · " + oneLine(b, 60)).join("\n") +
        ((a.blocks || []).length > 8 ? "\n  · …" : ""),
      async run(a) {
        const blocks = Array.isArray(a.blocks) ? a.blocks : [a.blocks];
        if (!blocks.length) throw new Error("blocks 为空");
        const p = await resolvePage(a.page);
        const n = await writeSiblings(parseTree(blocks), null, p.name);
        return { ok: true, message: "已向《" + p.name + "》追加 " + n + " 个块", data: { page: p.name, blocks: n } };
      },
    },
    {
      name: "update_block",
      title: "改写块",
      write: true,
      description: "用新内容整体替换某个块的正文（uuid 或 current）。这是「润色/重写这一段」的执行工具，原内容会被覆盖。",
      parameters: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "块 uuid，或 current" },
          content: { type: "string", description: "新的块内容" },
        },
        required: ["content"],
      },
      preview: async (a) => {
        const b = await resolveBlock(a.uuid).catch(() => null);
        return (
          "改写块「" + oneLine(b ? clean(b.content) : a.uuid || "光标块", 50) + "」\n" +
          "  → " + oneLine(a.content, 120)
        );
      },
      async run(a) {
        const content = String(need(a.content, "content"));
        const b = await resolveBlock(a.uuid);
        await ls().Editor.updateBlock(b.uuid, content);
        // 读回校验：DB 版图谱可能有毫秒级延迟，重试一次再下结论，别把成功写成失败
        let after = await safe(() => ls().Editor.getBlock(b.uuid), null);
        if (after && clean(after.content) !== clean(content)) {
          await new Promise((r) => setTimeout(r, 250));
          after = await safe(() => ls().Editor.getBlock(b.uuid), null);
        }
        const mismatch = !!(after && clean(after.content) !== clean(content));
        return {
          ok: true,
          message:
            "已改写块 " + b.uuid + (mismatch ? "（读回内容有差异，可能被 Logseq 规范化或模板改写）" : ""),
          data: { uuid: b.uuid, verified: !mismatch },
        };
      },
    },
    {
      name: "add_tags",
      title: "加标签",
      write: true,
      description: "给块追加 #标签（已存在的不重复加）。",
      parameters: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "块 uuid，或 current" },
          tags: { type: "array", items: { type: "string" }, description: "标签名数组，不带 #" },
        },
        required: ["tags"],
      },
      preview: async (a) => {
        const b = await resolveBlock(a.uuid).catch(() => null);
        const tags = (a.tags || []).map((t) => "#" + String(t).replace(/^#+/, "").trim()).join(" ");
        return "给块「" + oneLine(b ? clean(b.content) : "光标块", 40) + "」加标签：" + tags;
      },
      async run(a) {
        const tags = (Array.isArray(a.tags) ? a.tags : [a.tags])
          .map((t) => String(t == null ? "" : t).replace(/^#+/, "").trim())
          .filter(Boolean);
        if (!tags.length) throw new Error("tags 为空");
        const b = await resolveBlock(a.uuid);
        const content = String(b.content || "");
        const add = tags.filter((t) => content.indexOf("#" + t) < 0);
        if (!add.length) return { ok: true, message: "这些标签已经都在了，未改动" };
        await ls().Editor.updateBlock(b.uuid, content.replace(/\s*$/, "") + " " + add.map((t) => "#" + t).join(" "));
        return { ok: true, message: "已加标签：" + add.map((t) => "#" + t).join(" "), data: { tags: add } };
      },
    },
    {
      name: "set_todo",
      title: "改 TODO 状态",
      write: true,
      description: "把块的 TODO 状态改成 none / TODO / DOING / DONE。",
      parameters: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "块 uuid，或 current" },
          state: { type: "string", enum: ["none", "TODO", "DOING", "DONE"], description: "目标状态" },
        },
        required: ["state"],
      },
      preview: async (a) => {
        const b = await resolveBlock(a.uuid).catch(() => null);
        return "把块「" + oneLine(b ? clean(b.content) : "光标块", 40) + "」的状态改为 " + a.state;
      },
      async run(a) {
        const state = String(need(a.state, "state")).toUpperCase();
        if (["NONE", "TODO", "DOING", "DONE"].indexOf(state) < 0) throw new Error("state 只能是 none / TODO / DOING / DONE");
        const b = await resolveBlock(a.uuid);
        const body = String(b.content || "").replace(TODO_RE, "");
        const next = state === "NONE" ? body : state + " " + body;
        await ls().Editor.updateBlock(b.uuid, next);
        return { ok: true, message: "状态已改为 " + state, data: { uuid: b.uuid } };
      },
    },
    {
      name: "move_block",
      title: "移动块",
      write: true,
      description: "把块移动到另一个块的前面/后面，或成为它的子块。position：before / after / child。",
      parameters: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "要移动的块 uuid" },
          target: { type: "string", description: "目标块 uuid" },
          position: { type: "string", enum: ["before", "after", "child"], description: "相对目标的位置，默认 after" },
        },
        required: ["uuid", "target"],
      },
      preview: async (a) => {
        const s = await resolveBlock(a.uuid).catch(() => null);
        const t = await resolveBlock(a.target).catch(() => null);
        return (
          "移动块「" + oneLine(s ? clean(s.content) : a.uuid, 36) + "」到「" +
          oneLine(t ? clean(t.content) : a.target, 36) + "」" + (a.position === "before" ? "之前" : a.position === "child" ? "下面" : "之后")
        );
      },
      async run(a) {
        if (typeof ls().Editor.moveBlock !== "function") throw new Error("当前 Logseq 版本没有 moveBlock API");
        const src = await resolveBlock(a.uuid);
        const dst = await resolveBlock(a.target);
        const pos = a.position || "after";
        await ls().Editor.moveBlock(src.uuid, dst.uuid, { before: pos === "before", children: pos === "child" });
        return { ok: true, message: "已移动块", data: { uuid: src.uuid } };
      },
    },
    {
      name: "delete_block",
      title: "删除块",
      write: true,
      danger: true,
      description: "删除一个块及其子块。危险操作，只应在用户明确要求时使用。",
      parameters: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "块 uuid，或 current" },
        },
        required: [],
      },
      preview: async (a) => {
        const b = await resolveBlock(a.uuid).catch(() => null);
        return "⚠️ 删除块「" + oneLine(b ? clean(b.content) : a.uuid || "光标块", 60) + "」及其子块（不可恢复，可尝试 Ctrl+Z）";
      },
      async run(a) {
        const b = await resolveBlock(a.uuid);
        const ls2 = ls();
        const fn = ls2.Editor.removeBlock || ls2.Editor.deleteBlock;
        if (typeof fn !== "function") throw new Error("当前 Logseq 版本没有 removeBlock API");
        await fn.call(ls2.Editor, b.uuid);
        return { ok: true, message: "已删除块", data: { uuid: b.uuid } };
      },
    },
    {
      name: "set_page_property",
      title: "设置页面属性",
      write: true,
      description:
        "给页面设置一个属性（页面属性就是页面第一个块上的 key:: value），例如 status、author、tags。已有同名属性会被覆盖。",
      parameters: {
        type: "object",
        properties: {
          page: { type: "string", description: "页面名，留空或 current 表示当前页" },
          key: { type: "string", description: "属性名，例如 status" },
          value: { type: "string", description: "属性值" },
        },
        required: ["key", "value"],
      },
      preview: (a) =>
        "给页面" + (isCurrent(a.page) ? "（当前页）" : "《" + a.page + "》") + " 设置属性 " + a.key + ":: " + oneLine(a.value, 60),
      async run(a) {
        const key = String(need(a.key, "key")).trim();
        const value = a.value == null ? "" : a.value;
        const p = await resolvePage(a.page);
        const block = await firstBlockOf(p.name);
        const fn = ls().Editor.upsertBlockProperty;
        if (typeof fn !== "function") throw new Error("当前 Logseq 版本没有 upsertBlockProperty API");
        await fn.call(ls().Editor, block.uuid, key, value);
        return { ok: true, message: "已设置《" + p.name + "》属性 " + key + ":: " + oneLine(value, 60), data: { page: p.name, key: key } };
      },
    },
    {
      name: "remove_page_property",
      title: "删除页面属性",
      write: true,
      description: "删掉页面上的某个属性（key）。",
      parameters: {
        type: "object",
        properties: {
          page: { type: "string", description: "页面名，留空或 current 表示当前页" },
          key: { type: "string", description: "属性名" },
        },
        required: ["key"],
      },
      preview: (a) => "删除页面" + (isCurrent(a.page) ? "（当前页）" : "《" + a.page + "》") + " 的属性 " + a.key,
      async run(a) {
        const key = String(need(a.key, "key")).trim();
        const p = await resolvePage(a.page);
        const block = await firstBlockOf(p.name);
        const ed = ls().Editor;
        const fn = ed.removeBlockProperty || ed.deleteBlockProperty;
        if (typeof fn !== "function") throw new Error("当前 Logseq 版本没有 removeBlockProperty API");
        await fn.call(ed, block.uuid, key);
        return { ok: true, message: "已删除《" + p.name + "》的属性 " + key };
      },
    },
    {
      name: "move_page_blocks",
      title: "整页搬块",
      write: true,
      description: "把 A 页面的所有顶层块搬到 B 页面（追加到末尾或插到开头）。原页面会剩下空壳，不删页。",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "来源页面名" },
          to: { type: "string", description: "目标页面名" },
          mode: { type: "string", enum: ["append", "prepend"], description: "追加到末尾（默认）或插到开头" },
        },
        required: ["from", "to"],
      },
      preview: async (a) => {
        const n = (await topLevelBlocks(a.from)).length;
        return "把《" + a.from + "》的 " + n + " 个顶层块搬到《" + a.to + "》" + (a.mode === "prepend" ? "开头" : "末尾");
      },
      async run(a) {
        const from = String(need(a.from, "from")).trim();
        const to = String(need(a.to, "to")).trim();
        if (from === to) throw new Error("来源和目标不能是同一页");
        if (typeof ls().Editor.moveBlock !== "function") throw new Error("当前 Logseq 版本没有 moveBlock API");
        const src = await topLevelBlocks(from);
        if (!src.length) throw new Error("《" + from + "》没有可搬的块");
        const dst = await topLevelBlocks(to);
        // 目标为空：先造一个占位块当锚点，搬完再删掉
        const placeholder = dst.length ? null : await ls().Editor.appendBlockInPage(to, "");
        const anchor = dst.length ? (a.mode === "prepend" ? dst[0].uuid : dst[dst.length - 1].uuid) : placeholder && placeholder.uuid;
        if (!anchor) throw new Error("找不到目标页面《" + to + "》的锚点块");
        const list = a.mode === "prepend" ? src.slice().reverse() : src;
        for (const b of list) await ls().Editor.moveBlock(b.uuid, anchor, { before: a.mode === "prepend" });
        if (placeholder) {
          try {
            await ls().Editor.removeBlock(placeholder.uuid);
          } catch (e) {
            /* 占位块删不掉也不影响结果 */
          }
        }
        return { ok: true, message: "已把 " + src.length + " 个块从《" + from + "》搬到《" + to + "》", data: { count: src.length } };
      },
    },
    {
      name: "delete_page",
      title: "删除页面",
      write: true,
      danger: true,
      description: "删除整个页面。Logseq 桌面版是软删除（进 Recycle，可用 restore_page 找回）。危险操作，只在用户明确要求时用。",
      parameters: {
        type: "object",
        properties: { page: { type: "string", description: "页面名" } },
        required: ["page"],
      },
      preview: (a) => "⚠️ 删除页面《" + a.page + "》（进 Recycle，可恢复）",
      async run(a) {
        const name = String(need(a.page, "page")).trim();
        if (typeof ls().Editor.deletePage !== "function") throw new Error("当前 Logseq 版本没有 deletePage API");
        const existed = await safe(() => ls().Editor.getPage(name), null);
        if (!existed) throw new Error("找不到页面《" + name + "》");
        await ls().Editor.deletePage(name);
        let still = await safe(() => ls().Editor.getPage(name), null);
        if (still) {
          // 软删除有延迟，等一下再判，别把成功写成失败
          await new Promise((r) => setTimeout(r, 250));
          still = await safe(() => ls().Editor.getPage(name), null);
        }
        if (still) throw new Error("删除没有生效（可能同名页面被引用占用），请手动删《" + name + "》");
        if (CP.retrieval && CP.retrieval.resetDeleted) CP.retrieval.resetDeleted();
        return { ok: true, message: "已删除页面《" + name + "》（在 Recycle 里可找回）", data: { page: name } };
      },
    },
    {
      name: "restore_page",
      title: "恢复页面",
      write: true,
      description: "从 Recycle 里恢复一个被删除的页面。",
      parameters: {
        type: "object",
        properties: { page: { type: "string", description: "被删掉的页面名" } },
        required: ["page"],
      },
      preview: (a) => "从 Recycle 恢复页面《" + a.page + "》",
      async run(a) {
        const name = String(need(a.page, "page")).trim();
        if (typeof ls().Editor.restorePage !== "function") throw new Error("当前 Logseq 版本没有 restorePage API（去 Recycle 页面手动恢复）");
        const ok = await ls().Editor.restorePage(name);
        if (!ok) throw new Error("Recycle 里没有《" + name + "》，或恢复失败");
        if (CP.retrieval && CP.retrieval.resetDeleted) CP.retrieval.resetDeleted();
        return { ok: true, message: "已恢复页面《" + name + "》" };
      },
    },
  ];

  const BY_NAME = {};
  TOOLS.forEach((t) => (BY_NAME[t.name] = t));

  function all() {
    return TOOLS.slice();
  }

  function get(name) {
    return BY_NAME[name] || null;
  }

  function isWrite(name) {
    const t = BY_NAME[name];
    return !!(t && t.write);
  }

  function isDanger(name) {
    const t = BY_NAME[name];
    return !!(t && t.danger);
  }

  /** OpenAI / DeepSeek 的 function calling 规范 */
  function specs(names) {
    return TOOLS.filter((t) => !names || names.indexOf(t.name) >= 0).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  /** 参数校验：缺必填 / 类型不对就在动手前拦住 */
  function validate(name, args) {
    const t = BY_NAME[name];
    if (!t) throw new Error("没有这个工具：" + name);
    const a = args && typeof args === "object" ? args : {};
    (t.parameters.required || []).forEach((k) => {
      if (a[k] == null || (typeof a[k] === "string" && !a[k].trim())) throw new Error("工具 " + name + " 缺少参数 " + k);
    });
    const props = t.parameters.properties || {};
    Object.keys(a).forEach((k) => {
      const def = props[k];
      if (!def) return;
      if (def.type === "number" && a[k] != null && a[k] !== "") {
        const n = Number(a[k]);
        if (!Number.isFinite(n)) throw new Error("参数 " + k + " 应该是数字");
        a[k] = n;
      }
      if (def.type === "array" && a[k] != null && !Array.isArray(a[k])) a[k] = [a[k]];
    });
    return a;
  }

  async function preview(name, args) {
    const t = BY_NAME[name];
    if (!t || !t.preview) return name;
    const a = args && typeof args === "object" ? args : {};
    const missing = (t.parameters.required || []).filter(
      (k) => a[k] == null || (typeof a[k] === "string" && !String(a[k]).trim())
    );
    if (missing.length) return "⚠️ 参数不完整：缺 " + missing.join("、") + "（这样执行会失败，需要模型重试）";
    try {
      const p = await t.preview(a);
      return String(p);
    } catch (e) {
      return name + "（预览失败：" + e.message + "）";
    }
  }

  /** 执行一个工具调用；永远返回 {ok, message}，不往外抛 */
  async function run(name, rawArgs) {
    const t = BY_NAME[name];
    if (!t) return { ok: false, message: "没有这个工具：" + name };
    let args;
    try {
      args = validate(name, rawArgs);
    } catch (e) {
      return { ok: false, message: e.message };
    }
    try {
      const r = await t.run(args);
      return r && typeof r === "object" ? r : { ok: true, message: String(r == null ? "完成" : r) };
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) };
    }
  }

  /** 给文本协议（非 function calling 的模型）用的一段说明 */
  function protocolPrompt() {
    const lines = TOOLS.map((t) => {
      const req = (t.parameters.required || []).join(", ");
      const props = Object.keys(t.parameters.properties || {});
      return "- " + t.name + "(" + (req || props.slice(0, 2).join(", ")) + ")： " + t.description;
    });
    return [
      "【行动协议】你可以调用下面的工具来真正读写用户的 Logseq 图谱。",
      "需要动手时，在回复里单独输出一个 ```akyuu 代码块，内容是 JSON：",
      '```akyuu',
      '{"tool":"insert_block","args":{"content":"要写入的内容"}}',
      "```",
      "规则：一次最多 3 个代码块；只想聊天就不要输出代码块；工具结果会以 <tool_results> 返回给你，然后你再决定继续调用还是给出最终回答。",
      "可用工具：",
      lines.join("\n"),
    ].join("\n");
  }

  /** 确认卡片的标题用 */
  function title(name) {
    const t = BY_NAME[name];
    return (t && t.title) || name;
  }

  CP.tools = {
    all: all,
    get: get,
    specs: specs,
    validate: validate,
    preview: preview,
    run: run,
    isWrite: isWrite,
    isDanger: isDanger,
    title: title,
    protocolPrompt: protocolPrompt,
    parseTree: parseTree,
  };
})(typeof window !== "undefined" ? window : globalThis);
