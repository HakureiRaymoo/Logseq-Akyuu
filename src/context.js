/**
 * 上下文装配：把「当前页 / 当前块 / 选中块 / 显式引用 / 图谱检索」拼成分段注入的文本。
 *
 * 分段注入（照搬 obsidian-copilot 的思路）是为了让模型能区分：
 *   <pinned>      用户明确点名要的（[[页面]]、#标签、📌 引用）—— 高可信，整页给
 *   <graph_hits>  检索猜出来的 —— 可能不相关，需要自己判断
 */
(function (global) {
  const CP = (global.CP = global.CP || {});

  const PROP_LINE = /^\s*(id|collapsed|created-at|updated-at|updated_by|created_by)::\s*/i;

  function clip(s, n) {
    const str = String(s == null ? "" : s);
    if (!n || str.length <= n) return str;
    return str.slice(0, n) + "\n…（上下文已截断）";
  }

  function cleanContent(content) {
    return String(content || "")
      .split("\n")
      .filter((line) => !PROP_LINE.test(line))
      .join("\n")
      .trim();
  }

  async function safe(fn, fallback) {
    try {
      const v = await fn();
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function attr(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  /** 块树 → 缩进 Markdown 大纲 */
  function blocksToMarkdown(blocks, depth) {
    const d = depth || 0;
    const out = [];
    (blocks || []).forEach((b) => {
      const content = cleanContent(b && b.content);
      if (content) out.push("  ".repeat(d) + "- " + content);
      if (b && b.children && b.children.length) out.push(blocksToMarkdown(b.children, d + 1));
    });
    return out.filter(Boolean).join("\n");
  }

  async function pageMarkdown(pageName, maxChars) {
    const name = typeof pageName === "string" ? pageName : pageName && pageName.name;
    if (!name) return "";
    const tree = await safe(() => global.logseq.Editor.getPageBlocksTree(name), []);
    return clip(blocksToMarkdown(tree), maxChars || 6000);
  }

  /** 当前打开页面 / 光标所在块 / 选中的块 */
  async function active() {
    const ls = global.logseq;
    const [block, page, selected] = await Promise.all([
      safe(() => ls.Editor.getCurrentBlock(), null),
      safe(() => ls.Editor.getCurrentPage(), null),
      safe(() => (ls.Editor.getSelectedBlocks ? ls.Editor.getSelectedBlocks() : []), []),
    ]);
    return {
      block: block && block.content ? block : null,
      page: page && page.name ? page : null,
      selected: Array.isArray(selected) ? selected.filter((b) => b && b.content) : [],
    };
  }

  /**
   * 组装发给模型的上下文。
   * @param {{question:string, mode?:'chat'|'graph', pinned?:{name:string}[], usePage?:boolean, useBlock?:boolean, maxChars?:number}} opts
   */
  async function build(opts) {
    const o = opts || {};
    const s = (global.logseq && global.logseq.settings) || {};
    const budget = Number(o.maxChars || s.contextChars || 6000);
    const cur = await active();
    const sections = [];
    const sources = [];
    const question = String(o.question || "");
    const wantGraph = o.mode === "graph" || s.smartContext === true;

    /* 1. 当前页面 */
    let currentPageMd = "";
    if (o.usePage !== false && cur.page && cur.page.name) {
      currentPageMd = await pageMarkdown(cur.page.name, Math.floor(budget * 0.4));
      if (currentPageMd) {
        sections.push('<current_page name="' + attr(cur.page.name) + '">\n' + currentPageMd + "\n</current_page>");
        sources.push({ type: "page", name: "当前页：" + cur.page.name });
      }
    }

    /* 2. 当前块 */
    if (o.useBlock !== false && cur.block && cur.block.content) {
      const content = cleanContent(cur.block.content);
      if (content) {
        sections.push("<current_block>\n" + clip(content, Math.floor(budget * 0.15)) + "\n</current_block>");
        sources.push({ type: "block", name: "光标块" });
      }
    }

    /* 3. 选中块 */
    if (cur.selected.length) {
      const text = cur.selected
        .slice(0, 20)
        .map((b) => "- " + cleanContent(b.content))
        .join("\n");
      sections.push("<selection>\n" + clip(text, Math.floor(budget * 0.2)) + "\n</selection>");
      sources.push({ type: "selection", name: "选中 " + cur.selected.length + " 块" });
    }

    /* 4. 保底命中：问题里的 [[页面]] / #标签 + 用户 📌 的页面 */
    const mentions = CP.retrieval.extractMentions(question);
    const explicit = []
      .concat(mentions.pages)
      .concat(mentions.tags)
      .concat((o.pinned || []).map((p) => p && p.name).filter(Boolean));

    const seen = new Set();
    if (cur.page && cur.page.name) seen.add(String(cur.page.name).toLowerCase());
    const guaranteed = [];
    explicit.forEach((name) => {
      const key = String(name || "").trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      guaranteed.push(String(name).trim());
    });

    if (guaranteed.length) {
      const names = [];
      let left = Math.floor(budget * 0.3);
      for (const name of guaranteed.slice(0, 4)) {
        if (left < 300) break;
        const md = await pageMarkdown(name, Math.min(2500, left));
        if (!md) continue;
        sections.push('<pinned name="' + attr(name) + '">\n' + md + "\n</pinned>");
        names.push(name);
        left -= md.length;
      }
      if (names.length) sources.push({ type: "pinned", name: "引用：" + names.join("、") });
    }

    /* 4.5 块引用：((uuid)) —— 用户 @ 出来的具体块，可信度等同 pinned */
    const blockRefs = [];
    question.replace(/\(\(([0-9a-fA-F-]{36})\)\)/g, (_, uuid) => {
      if (blockRefs.indexOf(uuid) < 0) blockRefs.push(uuid);
      return "";
    });
    if (blockRefs.length) {
      const items = [];
      for (const uuid of blockRefs.slice(0, 6)) {
        const b = await safe(() => global.logseq.Editor.getBlock(uuid), null);
        if (!b || !b.content) continue;
        const pageName = (b.page && (b.page.originalName || b.page.name)) || "";
        items.push(
          '<block_ref page="' +
            attr(pageName) +
            '" uuid="' +
            attr(uuid) +
            '">\n' +
            clip(cleanContent(b.content), 800) +
            "\n</block_ref>"
        );
      }
      if (items.length) {
        sections.push("<pinned_blocks>\n" + items.join("\n") + "\n</pinned_blocks>");
        sources.push({ type: "blockref", name: "块引用 " + items.length });
      }
    }

    /* 5. 图谱检索（扩展查询 → 召回 → BM25 → 图信号 → 多样性） */
    let stats = null;
    if (wantGraph && question) {
      const ret = await CP.retrieval.retrieve(question, {
        maxK: o.mode === "graph" ? 10 : 8,
        currentPage: cur.page && cur.page.name,
        pageText: currentPageMd,
      });
      stats = ret.stats;

      // 页面名直接命中的，补进保底段落（最多 2 页，避免抢预算）
      const extra = (ret.pageHits || []).filter((n) => !seen.has(String(n).toLowerCase())).slice(0, 2);
      if (extra.length) {
        let left = Math.floor(budget * 0.15);
        const names = [];
        for (const name of extra) {
          if (left < 300) break;
          const md = await pageMarkdown(name, Math.min(1800, left));
          if (!md) continue;
          sections.push('<pinned name="' + attr(name) + '" reason="页面名命中">\n' + md + "\n</pinned>");
          names.push(name);
          seen.add(String(name).toLowerCase());
          left -= md.length;
        }
        if (names.length) sources.push({ type: "pagehit", name: "页面名命中：" + names.join("、") });
      }

      // 块级命中：跳过已在当前页/引用页里出现过的内容
      const skipText = sections.join("\n").toLowerCase();
      const lines = [];
      (ret.docs || []).forEach((d) => {
        if (!d.content) return;
        if (currentPageMd && d.page === (cur.page && cur.page.name)) return; // 整页已给，别重复
        const probe = d.content.slice(0, 40).toLowerCase();
        if (probe && skipText.indexOf(probe) >= 0) return;
        lines.push("- [" + (d.page || "?") + "] " + d.content.replace(/\n+/g, " "));
      });

      if (lines.length) {
        const tag = stats && stats.expanded ? "（含扩展召回）" : "";
        sections.push(
          '<graph_hits note="按相关度检索命中，可能部分不相关' +
            (stats && stats.variants ? "，已用 " + (stats.variants + 1) + " 个查询变体召回" : "") +
            '">\n' +
            clip(lines.join("\n"), Math.floor(budget * 0.35)) +
            "\n</graph_hits>"
        );
        sources.push({ type: "graph", name: "检索 " + lines.length + " 块" + tag });
      }
    }

    return {
      text: clip(sections.join("\n\n"), budget),
      sources: sources,
      stats: stats,
      current: cur,
    };
  }

  CP.ctx = {
    active: active,
    build: build,
    blocksToMarkdown: blocksToMarkdown,
    pageMarkdown: pageMarkdown,
    cleanContent: cleanContent,
    clip: clip,
  };
})(typeof window !== "undefined" ? window : globalThis);
