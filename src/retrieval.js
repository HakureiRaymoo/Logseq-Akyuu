/**
 * 检索层（灵感来自 obsidian-copilot v3 的 TieredLexicalRetriever，但换成 Logseq 的块查询）。
 *
 *   问题
 *    ├─ 显式引用保底：[[页面]] / #标签  → 整页进上下文，不参与打分
 *    └─ 检索
 *         1. expandQuery  用小模型把问题扩成「关键词 + 改写问法」（失败则本地切词）
 *         2. recall       拿关键词去 DataScript 里按页面名 / 块内容召回
 *         3. rank         块级 BM25+（短语匹配 + 标题加权）
 *         4. boost        图信号：反向链接、当前页出链、同页聚团（封顶 ×1.18）
 *         5. pick         归一化 + 多样性 Top-K（同一页面最多 2 块）
 *
 * 不做向量嵌入、不建索引：每次提问现算，几百个候选块内的 BM25 是毫秒级。
 */
(function (global) {
  const CP = (global.CP = global.CP || {});

  const CACHE_MAX = 100;
  const cache = new Map(); // key -> {terms, queries, source}
  const MAX_TERMS = 6;
  const MAX_DOCS = 400;

  const STOP = new Set([
    "的", "了", "是", "在", "和", "与", "我", "你", "他", "她", "它", "这", "那", "有", "也", "就", "都",
    "而", "及", "或", "把", "被", "对", "为", "从", "到", "一个", "什么", "怎么", "如何", "哪些", "多少",
    "帮我", "一下", "这个", "那个", "可以", "能", "吗", "呢", "吧", "这一页", "这个页面", "这一篇", "这篇",
    "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "for", "on", "with", "this", "that", "it", "my", "me",
  ]);

  /* ------------------------------ 纯工具（可在 Node 里直接测） ------------------------------ */

  function sanitizeTerm(t) {
    return String(t == null ? "" : t)
      .replace(/["\\\n\r\t]/g, " ")
      .replace(/^#+/, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isGoodTerm(t) {
    if (!t || t.length < 2 || t.length > 40) return false;
    if (STOP.has(t)) return false;
    // 至少要含一个字母/数字/汉字，纯标点或纯空白没意义
    if (!/[A-Za-z0-9\u4e00-\u9fa5]/.test(t)) return false;
    return true;
  }

  /** 本地切词：英文词 + 中文 3-gram/4-gram/2-gram。小模型不可用时的兜底。 */
  function localTerms(text) {
    const q = String(text || "");
    const buckets = { 3: [], 4: [], 2: [] };
    const seen = new Set();

    (q.match(/[A-Za-z][A-Za-z0-9_+#.-]{1,}/g) || []).forEach((w) => {
      const s = sanitizeTerm(w);
      if (isGoodTerm(s) && !seen.has(s)) {
        seen.add(s);
        buckets[3].push(s);
      }
    });

    const segs = q.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    segs.slice(0, 3).forEach((seg) => {
      [3, 4, 2].forEach((n) => {
        for (let i = 0; i + n <= seg.length; i++) {
          const s = seg.slice(i, i + n);
          if (!isGoodTerm(s) || seen.has(s)) continue;
          seen.add(s);
          buckets[n].push(s);
        }
      });
    });

    // 3-gram 优先（召回与精度平衡），再 4-gram，最后 2-gram；每档最多取 2-3 个，避免全是大长词
    const out = [];
    [3, 4, 2].forEach((n) => {
      const quota = n === 3 ? 3 : n === 4 ? 2 : 1;
      buckets[n].slice(0, quota).forEach((t) => {
        if (out.length < MAX_TERMS && out.indexOf(t) < 0) out.push(t);
      });
    });
    return out;
  }

  /** [[页面]] 与 #标签：显式引用，直接保底进上下文 */
  function extractMentions(text) {
    const s = String(text || "");
    const pages = [];
    const tags = [];
    let m;
    const rePage = /\[\[([^\[\]]{1,200})\]\]/g;
    while ((m = rePage.exec(s))) {
      const name = m[1].trim();
      if (name && pages.indexOf(name) < 0) pages.push(name);
    }
    const reTag = /(^|[\s(（,，。;；])#([\w\u4e00-\u9fa5/-]{2,40})/g;
    while ((m = reTag.exec(s))) {
      const name = m[2].trim();
      if (name && tags.indexOf(name) < 0) tags.push(name);
    }
    return { pages: pages, tags: tags };
  }

  function stripFence(text) {
    let s = String(text || "").trim();
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
    return s;
  }

  /** 解析小模型返回的扩展结果；任何异常都返回 null 交给兜底 */
  function parseExpansion(raw) {
    let obj;
    try {
      obj = JSON.parse(stripFence(raw));
    } catch (e) {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;

    const terms = [];
    (Array.isArray(obj.terms) ? obj.terms : []).forEach((t) => {
      const s = sanitizeTerm(t);
      if (isGoodTerm(s) && terms.indexOf(s) < 0 && terms.length < MAX_TERMS) terms.push(s);
    });

    const queries = [];
    (Array.isArray(obj.queries) ? obj.queries : []).forEach((q) => {
      const s = String(q == null ? "" : q).trim();
      if (s && s.length <= 200 && queries.indexOf(s) < 0 && queries.length < 3) queries.push(s);
    });

    if (!terms.length && !queries.length) return null;
    return { terms: terms, queries: queries };
  }

  function countOccurrences(haystack, needle) {
    if (!haystack || !needle) return 0;
    let count = 0;
    let idx = haystack.indexOf(needle);
    while (idx >= 0 && count < 50) {
      count++;
      idx = haystack.indexOf(needle, idx + needle.length);
    }
    return count;
  }

  /**
   * 块级 BM25+：用短语子串当 term（中文不需要分词），标题（页面名）命中额外加权。
   * @param {{content:string, page:string}[]} docs
   * @param {string[]} terms
   */
  function bm25Rank(docs, terms) {
    const list = (docs || []).filter((d) => d && d.content);
    if (!list.length || !terms || !terms.length) return [];

    const k1 = 1.2;
    const b = 0.75;
    const N = list.length;
    const prepared = list.map((d) => {
      const lower = String(d.content).toLowerCase();
      const title = String(d.page || "").toLowerCase();
      return { doc: d, lower: lower, title: title, len: Math.max(4, lower.length) };
    });
    const avgLen = prepared.reduce((a, p) => a + p.len, 0) / N || 1;

    const df = new Map();
    terms.forEach((t) => {
      let n = 0;
      prepared.forEach((p) => {
        if (p.lower.indexOf(t) >= 0 || p.title.indexOf(t) >= 0) n++;
      });
      df.set(t, n);
    });

    const scored = [];
    prepared.forEach((p) => {
      let score = 0;
      const hits = [];
      terms.forEach((t) => {
        const inBody = countOccurrences(p.lower, t);
        const inTitle = countOccurrences(p.title, t);
        let tf = inBody + inTitle * 2.2;
        if (!tf) return;
        const n = df.get(t) || 1;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * p.len) / avgLen)));
        hits.push(t);
      });
      if (score > 0) {
        scored.push({
          uuid: p.doc.uuid,
          content: p.doc.content,
          page: p.doc.page,
          hits: hits,
          raw: score,
        });
      }
    });

    scored.sort((a, b2) => b2.raw - a.raw);
    return scored;
  }

  /** min-max 归一化到 [0.02, 0.98]，和 obsidian-copilot 的做法对齐 */
  function normalize(rows, key, outKey) {
    if (!rows.length) return rows;
    const vals = rows.map((r) => r[key] || 0);
    const min = Math.min.apply(null, vals);
    const max = Math.max.apply(null, vals);
    const span = max - min;
    rows.forEach((r) => {
      const t = span > 0 ? (r[key] - min) / span : 1;
      r[outKey || "score"] = 0.02 + t * 0.96;
    });
    return rows;
  }

  /** 多样性：同一页面默认最多 2 块，当前页放宽到 3 块 */
  function selectDiverse(rows, k, opts) {
    const o = opts || {};
    const currentPage = (o.currentPage || "").toLowerCase();
    const maxPerPage = o.maxPerPage || 2;
    const picked = [];
    const perPage = new Map();
    for (const r of rows) {
      if (picked.length >= k) break;
      const page = String(r.page || "").toLowerCase();
      const cap = page && page === currentPage ? maxPerPage + 1 : maxPerPage;
      const used = perPage.get(page) || 0;
      if (used >= cap) continue;
      perPage.set(page, used + 1);
      picked.push(r);
    }
    return picked;
  }

  /* ------------------------------ 查询扩展 ------------------------------ */

  const EXPAND_PROMPT = [
    "你是检索查询扩展器。把用户问题转换成用于「全文检索笔记」的关键词与改写问法。",
    "只输出 JSON，不要代码块，不要解释：",
    '{"terms":["关键词1","关键词2","关键词3"],"queries":["改写问题1","改写问题2"]}',
    "规则：",
    "- terms 给 3-6 个：优先保留专有名词、术语、人名、项目名；不要臆造问题里没有的实体。",
    "- queries 最多 3 个：同一问题的不同说法（同义替换、换一种问法），保持原意。",
    "- 中文问题输出中文，英文问题输出英文。",
  ].join("\n");

  function cacheKey(question, model) {
    return String(model || "") + "|" + String(question || "").trim().toLowerCase().slice(0, 300);
  }

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    cache.delete(key); // LRU：命中后移到末尾
    cache.set(key, hit);
    return hit;
  }

  function cacheSet(key, value) {
    cache.set(key, value);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  /**
   * @returns {Promise<{terms:string[], queries:string[], source:'llm'|'fallback'|'cache', ms:number}>}
   */
  async function expandQuery(question, opts) {
    const o = opts || {};
    const started = Date.now();
    const q = String(question || "").trim();
    const fallback = { terms: localTerms(q), queries: [], source: "fallback", ms: 0 };
    if (!q) return fallback;

    let model = "";
    try {
      model = CP.llm.resolve().model;
    } catch (e) {
      return fallback;
    }

    const key = cacheKey(q, model);
    const cached = cacheGet(key);
    if (cached) return Object.assign({}, cached, { source: "cache", ms: 0 });

    // 没配 Key、或用户关掉扩展、或离线模型不可用：直接本地切词，避免每次提问都多一次失败请求
    if (o.enabled === false || o.offline) return fallback;

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => {
      try {
        controller && controller.abort();
      } catch (e) {
        /* ignore */
      }
    }, 6000);

    try {
      const res = await CP.llm.chat({
        messages: [{ role: "user", content: EXPAND_PROMPT + '\n\n用户问题：\n"""\n' + q + '\n"""' }],
        maxTokens: 260,
        temperature: 0,
        signal: controller ? controller.signal : undefined,
      });
      clearTimeout(timer);
      const parsed = parseExpansion(res && res.text);
      if (parsed) {
        const merged = {
          terms: parsed.terms.length ? parsed.terms : fallback.terms,
          queries: parsed.queries,
          source: "llm",
          ms: Date.now() - started,
        };
        cacheSet(key, merged);
        return merged;
      }
      return Object.assign({}, fallback, { ms: Date.now() - started });
    } catch (e) {
      clearTimeout(timer);
      return Object.assign({}, fallback, { ms: Date.now() - started });
    }
  }

  /* ------------------------------ 召回 ------------------------------ */

  /* --------------------------- 图谱能力探测 --------------------------- */

  /*
   * Logseq 有两代图谱，块正文的字段名不一样（实测）：
   *   文件版：块正文 = :block/content，页面名 = :block/name
   *   DB 版（logseq_db_*，图谱目录下是 db.sqlite）：正文存在 :block/title，
   *        :block/content 在库里根本不存在 —— 查它永远 0 行，而且不报错。
   * 所以先探一次，把「用哪个字段」缓存下来；探测失败就按文件版处理。
   */
  let capsCache = null;
  let capsPromise = null;
  const diagState = { queries: 0, errors: 0, lastError: "", lastMs: 0, lastRows: 0 };

  function dbApi() {
    const l = global.logseq;
    return l && l.DB && typeof l.DB.datascriptQuery === "function" ? l.DB : null;
  }

  /** EDN 字符串字面量（关键词直接内联进查询，不依赖宿主的 :in 传参约定） */
  function ednStr(s) {
    return '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  async function countOf(query) {
    const db = dbApi();
    if (!db) return -1;
    try {
      const rows = await db.datascriptQuery(query);
      const n = Number(rows && rows[0] && rows[0][0]);
      return Number.isFinite(n) ? n : -1;
    } catch (e) {
      return -1;
    }
  }

  async function capabilities(force) {
    if (force) {
      capsCache = null;
      capsPromise = null;
    }
    if (capsCache) return capsCache;
    if (capsPromise) return capsPromise;
    capsPromise = (async () => {
      const caps = {
        content: "content",
        page: "name",
        graph: "file",
        blocks: 0,
        contentBlocks: -1,
        titleBlocks: -1,
      };
      caps.blocks = await countOf("[:find (count ?b) :where [?b :block/uuid]]");
      if (caps.blocks > 0) {
        caps.contentBlocks = await countOf("[:find (count ?b) :where [?b :block/content]]");
        caps.titleBlocks = await countOf("[:find (count ?b) :where [?b :block/title]]");
        if (caps.contentBlocks <= 0 && caps.titleBlocks > 0) {
          caps.content = "title";
          caps.graph = "db";
        }
        if ((await countOf("[:find (count ?p) :where [?p :block/name]]")) <= 0) caps.page = "title";
      }
      capsCache = caps;
      return caps;
    })();
    return capsPromise;
  }

  function blockQuery(caps, withPage) {
    const head =
      "[:find ?uuid ?text ?pname\n" +
      " :where\n" +
      " [?b :block/" + caps.content + " ?text]\n" +
      " [?b :block/uuid ?uuid]\n";
    const tail = " [(clojure.string/lower-case ?text) ?lt]\n [(clojure.string/includes? ?lt %NEEDLE%)]]";
    return withPage
      ? head + " [?b :block/page ?p]\n [?p :block/" + caps.page + " ?pname]\n" + tail
      : head + tail;
  }

  function pageQuery(caps) {
    return "[:find ?pname\n :where\n [?p :block/" + caps.page + " ?pname]\n [(clojure.string/includes? ?pname %NEEDLE%)]]";
  }

  async function runQuery(template, needle) {
    const db = dbApi();
    if (!db) return [];
    // 关键词直接内联：不同 Logseq 版本对 :in 传参的 EDN 解析行为不一致，
    // 旧的 JSON.stringify(needle) 在「不解析入参」的版本上会带上引号，导致永远 0 行。
    const query =
      needle == null ? String(template) : String(template).split("%NEEDLE%").join(ednStr(needle));
    diagState.queries++;
    diagState.lastError = "";
    const t = Date.now();
    try {
      const rows = (await db.datascriptQuery(query)) || [];
      diagState.lastMs = Date.now() - t;
      diagState.lastRows = Array.isArray(rows) ? rows.length : 0;
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      diagState.errors++;
      diagState.lastError = String((e && e.message) || e).slice(0, 300);
      return [];
    }
  }

  /*
   * 已删除页面：DB 版图谱删页是「软删除」，实体还在库里（:logseq.property/deleted-at 有值、
   * :logseq.property.recycle/original-page 指向自己），Logseq 界面和 Ctrl+K 会隐藏它们，
   * 但插件 API getAllPages() 仍会返回 —— 所以必须自己过滤，否则会出现
   * 「页面上明明已经删了，AI 还在 list_pages 里看到它」。
   */
  const DELETED_QUERY = "[:find ?name :where [?p :block/name ?name] [?p :logseq.property/deleted-at _]]";
  let deletedCache = null;

  async function deletedPageNames(force) {
    if (force) deletedCache = null;
    if (deletedCache) return deletedCache;
    const caps = await capabilities();
    const set = new Set();
    if (caps.graph === "db") {
      const rows = await runQuery(DELETED_QUERY);
      (rows || []).forEach((r) => {
        const n = String((r && r[0]) || "").trim().toLowerCase();
        if (n) set.add(n);
      });
    }
    deletedCache = set;
    return set;
  }

  function resetDeleted() {
    deletedCache = null;
  }

  /** 块检索：优先带页面名 join；某些图谱没有 :block/page，出错就退回不带 join 的版本 */
  async function findBlocks(needle) {
    const caps = await capabilities();
    const rows = await runQuery(blockQuery(caps, true), needle);
    if (rows.length) return rows;
    if (!diagState.lastError) return rows; // 没报错 = 真的没命中
    return runQuery(blockQuery(caps, false), needle);
  }

  async function findPages(needle) {
    const caps = await capabilities();
    return runQuery(pageQuery(caps), needle);
  }

  /** 按关键词召回块 + 页面名命中（已删除页面里的块/页面不参与） */
  async function recall(terms) {
    const docs = new Map();
    const pageHits = new Map();

    await capabilities();
    const deleted = await deletedPageNames();
    const gone = (name) => deleted.has(String(name || "").trim().toLowerCase());
    const tasks = [];
    (terms || []).slice(0, MAX_TERMS).forEach((t) => {
      tasks.push(
        findBlocks(t).then((rows) => {
          rows.slice(0, 300).forEach((row) => {
            const uuid = String(row && row[0]);
            const page = String((row && row[2]) || "");
            if (gone(page)) return;
            const content = CP.ctx.cleanContent(row && row[1]);
            if (!uuid || !content || content.length < 2 || content.length > 2000) return;
            const prev = docs.get(uuid);
            if (prev) {
              prev.hitCount++;
              return;
            }
            docs.set(uuid, {
              uuid: uuid,
              content: content,
              page: page,
              hitCount: 1,
            });
          });
        })
      );
      tasks.push(
        findPages(t).then((rows) => {
          rows.slice(0, 20).forEach((row) => {
            const name = String(row && row[0]);
            if (!name || gone(name)) return;
            pageHits.set(name, (pageHits.get(name) || 0) + 1);
          });
        })
      );
    });

    await Promise.all(tasks);

    const sortedDocs = Array.from(docs.values())
      .sort((a, b) => b.hitCount - a.hitCount)
      .slice(0, MAX_DOCS);
    const sortedPages = Array.from(pageHits.entries())
      .sort((a, b) => b[1] - a[1])
      .map((x) => x[0])
      .slice(0, 5);

    return { docs: sortedDocs, pageHits: sortedPages };
  }

  /** 合并两次召回（同一块累加命中数，页面命中取并集） */
  function mergeRecall(base, extra) {
    const docs = new Map();
    (base.docs || []).forEach((d) => docs.set(d.uuid, d));
    (extra.docs || []).forEach((d) => {
      const prev = docs.get(d.uuid);
      if (prev) prev.hitCount += d.hitCount;
      else docs.set(d.uuid, d);
    });
    const pages = new Map();
    (base.pageHits || []).concat(extra.pageHits || []).forEach((n) => {
      pages.set(n, (pages.get(n) || 0) + 1);
    });
    return {
      docs: Array.from(docs.values())
        .sort((a, b) => b.hitCount - a.hitCount)
        .slice(0, MAX_DOCS),
      pageHits: Array.from(pages.entries())
        .sort((a, b) => b[1] - a[1])
        .map((x) => x[0])
        .slice(0, 5),
    };
  }

  /** @ 选择器 / search_graph 工具用：按内容搜块，返回 {uuid, content, page} */
  async function searchBlocks(text, limit) {
    const needle = sanitizeTerm(text);
    if (!needle || needle.length < 1) return [];
    const rows = await findBlocks(needle);
    const deleted = await deletedPageNames();
    const seen = new Set();
    const out = [];
    (rows || []).forEach((row) => {
      const uuid = String(row && row[0]);
      const page = String((row && row[2]) || "");
      if (deleted.has(page.trim().toLowerCase())) return; // 回收站里的页面不出现
      const content = CP.ctx.cleanContent(row && row[1]);
      if (!uuid || !content || content.length < 2 || seen.has(uuid)) return;
      seen.add(uuid);
      const pos = content.toLowerCase().indexOf(needle);
      out.push({
        uuid: uuid,
        content: content,
        page: page,
        _score: (pos < 0 ? 999 : pos) + content.length / 200,
      });
    });
    out.sort((a, b) => a._score - b._score);
    return out.slice(0, limit || 8).map((x) => ({ uuid: x.uuid, content: x.content, page: x.page }));
  }

  /* ------------------------------ 图信号 ------------------------------ */

  async function backlinkPages(pageName) {
    const set = new Set();
    if (!pageName) return set;
    try {
      const refs = await global.logseq.Editor.getPageLinkedReferences(pageName);
      (refs || []).forEach((pair) => {
        const page = pair && pair[0];
        const name = page && (page.originalName || page.name);
        if (name) set.add(String(name).toLowerCase());
      });
    } catch (e) {
      /* ignore */
    }
    return set;
  }

  /**
   * 加成（封顶 ×1.18）：
   *  - 命中块所在页面被当前页反向链接（backlinks）
   *  - 当前页正文里 [[提到]] 了那个页面
   *  - 同页聚团（前 10 名里同页出现 ≥2 次）
   */
  function applyBoosts(rows, ctx) {
    const backlinks = ctx.backlinks || new Set();
    const outlinks = ctx.outlinks || new Set();
    const currentPage = String(ctx.currentPage || "").toLowerCase();

    const pageCount = new Map();
    rows.slice(0, 10).forEach((r) => {
      const p = String(r.page || "").toLowerCase();
      if (p) pageCount.set(p, (pageCount.get(p) || 0) + 1);
    });

    rows.forEach((r) => {
      const page = String(r.page || "").toLowerCase();
      let boost = 1;
      const reasons = [];
      if (page && page === currentPage) {
        boost *= 1.05;
        reasons.push("当前页");
      }
      if (page && backlinks.has(page)) {
        boost *= 1.08;
        reasons.push("反向链接");
      }
      if (page && outlinks.has(page)) {
        boost *= 1.06;
        reasons.push("页面出链");
      }
      if (page && (pageCount.get(page) || 0) >= 2) {
        boost *= 1.03;
        reasons.push("同页聚团");
      }
      r.boost = Math.min(1.18, boost);
      r.reasons = reasons;
      r.score = r.score * r.boost;
    });
    return rows;
  }

  /* ------------------------------ 主流程 ------------------------------ */

  /**
   * @param {string} question
   * @param {{maxK?:number, currentPage?:string, pageText?:string, smart?:boolean, signal?:AbortSignal}} opts
   */
  async function retrieve(question, opts) {
    const o = opts || {};
    const started = Date.now();
    const empty = { docs: [], pageHits: [], expansion: null, stats: { ms: 0, candidates: 0 } };

    const settings = (global.logseq && global.logseq.settings) || {};
    if (o.enabled === false || settings.smartContext === false) return empty;

    const expansion = await expandQuery(question, { enabled: settings.queryExpansion !== false });
    const terms = expansion.terms.slice(0, MAX_TERMS);
    if (!terms.length) return Object.assign(empty, { expansion: expansion });

    const recalled0 = await recall(terms);
    let recalled = recalled0;
    let expandedRecall = false;

    // 关键词召回太少时，才动用「改写问法」补召回（v3 的做法：扩展只加召回，不参与打分）
    if (
      recalled.docs.length < Math.max(3, terms.length) &&
      expansion.queries &&
      expansion.queries.length
    ) {
      const extraTerms = [];
      expansion.queries.forEach((q) => {
        localTerms(q).slice(0, 2).forEach((t) => {
          if (terms.indexOf(t) < 0 && extraTerms.indexOf(t) < 0 && extraTerms.length < 3) extraTerms.push(t);
        });
      });
      if (extraTerms.length) {
        recalled = mergeRecall(recalled, await recall(extraTerms));
        expandedRecall = true;
      }
    }

    const ranked = bm25Rank(recalled.docs, terms);
    if (!ranked.length) {
      return Object.assign(empty, {
        expansion: expansion,
        pageHits: recalled.pageHits,
        stats: { ms: Date.now() - started, candidates: recalled.docs.length },
      });
    }

    const currentPage = o.currentPage || "";
    const outlinks = new Set();
    String(o.pageText || "")
      .replace(/\[\[([^\[\]]+)\]\]/g, (_, name) => outlinks.add(String(name).trim().toLowerCase()));

    normalize(ranked, "raw", "score");
    applyBoosts(ranked, {
      backlinks: o.backlinks || (await backlinkPages(currentPage)),
      outlinks: outlinks,
      currentPage: currentPage,
    });
    ranked.sort((a, b) => b.score - a.score);

    const picked = selectDiverse(ranked, o.maxK || 8, { currentPage: currentPage });

    return {
      docs: picked,
      pageHits: recalled.pageHits,
      expansion: expansion,
      stats: {
        ms: Date.now() - started,
        candidates: recalled.docs.length,
        scored: ranked.length,
        variants: expansion.queries ? expansion.queries.length : 0,
        expanded: expandedRecall,
        source: expansion.source,
      },
    };
  }

  /* ------------------------------ 诊断 ------------------------------ */

  /**
   * 用一个词实测检索链路，返回：图谱类型 / 用的字段 / 命中数 / 报错 / 样本。
   * 出问题时先跑它，比猜快得多。
   */
  async function probe(term) {
    const caps = await capabilities(true);
    const deleted = await deletedPageNames(true);
    const needle = sanitizeTerm(term);
    const out = { caps: caps, term: needle, rows: 0, ms: 0, error: "", deleted: deleted.size, deletedHit: false, samples: [] };
    const t = Date.now();
    const rows = await findBlocks(needle);
    out.ms = Date.now() - t;
    out.rows = rows.length;
    out.error = diagState.lastError;
    out.deletedHit = deleted.has(needle);
    out.samples = rows.slice(0, 3).map((r) => ({
      page: String((r && r[2]) || ""),
      text: String((r && r[1]) || "").slice(0, 80),
    }));
    return out;
  }

  function diag() {
    return {
      caps: capsCache,
      queries: diagState.queries,
      errors: diagState.errors,
      lastError: diagState.lastError,
      lastMs: diagState.lastMs,
      lastRows: diagState.lastRows,
      deleted: deletedCache ? deletedCache.size : null,
    };
  }

  function resetCaps() {
    capsCache = null;
    capsPromise = null;
  }

  CP.retrieval = {
    retrieve: retrieve,
    expandQuery: expandQuery,
    recall: recall,
    searchBlocks: searchBlocks,
    bm25Rank: bm25Rank,
    selectDiverse: selectDiverse,
    extractMentions: extractMentions,
    parseExpansion: parseExpansion,
    localTerms: localTerms,
    sanitizeTerm: sanitizeTerm,
    normalize: normalize,
    applyBoosts: applyBoosts,
    countOccurrences: countOccurrences,
    capabilities: capabilities,
    probe: probe,
    diag: diag,
    resetCaps: resetCaps,
    deletedPageNames: deletedPageNames,
    resetDeleted: resetDeleted,
    ednStr: ednStr,
  };
})(typeof window !== "undefined" ? window : globalThis);
