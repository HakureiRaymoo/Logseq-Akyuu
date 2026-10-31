/**
 * 无浏览器烟测：用 vm 加载插件脚本，验证纯逻辑（Markdown、SSE 解析、上下文工具、存储降级）。
 * 运行：node test/smoke.mjs
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeSandbox() {
  const mem = new Map();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextDecoder,
    fetch: () => {
      throw new Error("no network in smoke test");
    },
    AbortController,
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

function load(ctx, file) {
  const code = fs.readFileSync(path.join(root, file), "utf8");
  vm.runInContext(code, ctx, { filename: file });
}

const ctx = makeSandbox();
[
  "src/md.js",
  "src/store.js",
  "src/llm.js",
  "src/retrieval.js",
  "src/context.js",
  "src/tools.js",
  "src/workspace.js",
  "src/agent.js",
].forEach((f) => load(ctx, f));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    fail++;
    console.log("  ✗ " + name + (extra ? " → " + extra : ""));
  }
}

console.log("md.render");
const html = ctx.CP.md.render(
  ["# 标题", "", "**粗体** 和 `code` 与 [链接](https://x.com)", "", "- 一", "  - 嵌套", "- 二", "", "```js", "const a = 1 < 2;", "```", "", "> 引用"].join("\n")
);
check("标题", /<h3>标题<\/h3>/.test(html), html);
check("粗体", /<strong>粗体<\/strong>/.test(html));
check("行内代码", /<code>code<\/code>/.test(html));
check("链接", /<a href="https:\/\/x.com"/.test(html));
check("嵌套列表", (html.match(/<ul>/g) || []).length === 2, html);
check("代码块转义", /const a = 1 &lt; 2;/.test(html));
check("引用", /<blockquote>/.test(html));

console.log("md 安全性");
const xss = ctx.CP.md.render('<img src=x onerror=alert(1)> **hi**');
check("原始 HTML 被转义", !/<img/.test(xss), xss);

console.log("llm.parseEvent");
check("data 行", ctx.CP.llm.parseEvent('data: {"choices":[{"delta":{"content":"你"}}]}').json.choices[0].delta.content === "你");
check("[DONE]", ctx.CP.llm.parseEvent("data: [DONE]").done === true);
check("空事件", ctx.CP.llm.parseEvent(": keep-alive") === null);

console.log("retrieval.localTerms");
const cn = ctx.CP.retrieval.localTerms("上线时间有变化吗");
check("中文切词", cn.some((k) => k.includes("上线")), JSON.stringify(cn));
check("过滤停用词", !cn.includes("吗"), JSON.stringify(cn));
const en = ctx.CP.retrieval.localTerms("Summarize the quarterly OKR notes");
check("英文单词", en.includes("summarize") && en.includes("quarterly"), JSON.stringify(en));

console.log("retrieval.parseExpansion");
const exp = ctx.CP.retrieval.parseExpansion(
  '```json\n{"terms":["上线","发布","延期","上线"],"queries":["上线时间变了吗","发布时间改动"]}\n```'
);
check("去重后 3 个 term", exp && exp.terms.length === 3, JSON.stringify(exp));
check("改写问法", exp && exp.queries.length === 2);
check("坏 JSON 返回 null", ctx.CP.retrieval.parseExpansion("我觉得应该是你要找的东西") === null);

console.log("retrieval.extractMentions");
const mentions = ctx.CP.retrieval.extractMentions("帮我总结 [[项目复盘]] 和 #ops/incident 的内容");
check("解析 [[页面]]", mentions.pages[0] === "项目复盘", JSON.stringify(mentions));
check("解析 #标签", mentions.tags[0] === "ops/incident", JSON.stringify(mentions));

console.log("retrieval.bm25Rank");
const ranked = ctx.CP.retrieval.bm25Rank(
  [
    { uuid: "a", content: "缓存雪崩的处理方案：加随机过期时间，再做降级", page: "后端" },
    { uuid: "b", content: "今天天气不错，出去散步", page: "日记" },
    { uuid: "c", content: "一些零散的想法", page: "缓存雪崩" },
  ],
  ["缓存雪崩"]
);
check("无关块不入选", ranked.length === 2 && !ranked.some((r) => r.uuid === "b"), JSON.stringify(ranked.map((r) => r.uuid)));
check("正文命中与标题命中都保留", ranked.some((r) => r.uuid === "a") && ranked.some((r) => r.uuid === "c"));

console.log("retrieval.selectDiverse / normalize");
const rows = [0, 1, 2, 3, 4].map((i) => ({ page: "同页", score: 10 - i, content: "x" + i }));
check("同页最多 2 块", ctx.CP.retrieval.selectDiverse(rows, 5, {}).length === 2);
check("当前页放宽到 3 块", ctx.CP.retrieval.selectDiverse(rows, 5, { currentPage: "同页" }).length === 3);
const normed = ctx.CP.retrieval.normalize(
  [{ score: 10 }, { score: 20 }, { score: 30 }],
  "score",
  "score"
);
check("归一化到 0.02~0.98", Math.abs(normed[0].score - 0.02) < 1e-6 && Math.abs(normed[2].score - 0.98) < 1e-6);

console.log("ctx.blocksToMarkdown");
const tree = [
  { content: "第一行", children: [{ content: "子块" }] },
  { content: "id:: 1234-5678\n第二行" },
];
const mdOut = ctx.CP.ctx.blocksToMarkdown(tree);
check("缩进层级", mdOut.includes("  - 子块"), mdOut);
check("过滤属性行", !mdOut.includes("id::"), mdOut);

console.log("store 降级");
await ctx.CP.store.set("k", { a: 1 });
check("写读一致", (await ctx.CP.store.get("k")).a === 1);
await ctx.CP.store.remove("k");
check("删除", (await ctx.CP.store.get("k")) === null);

console.log("llm 工具协议");
check("推理模型走文本协议", ctx.CP.llm.supportsNativeTools({ kind: "openai", model: "deepseek-reasoner" }) === false);
check("chat 模型走原生工具", ctx.CP.llm.supportsNativeTools({ kind: "openai", model: "deepseek-chat" }) === true);
check("Anthropic 走文本协议", ctx.CP.llm.supportsNativeTools({ kind: "anthropic", model: "claude-3-5-sonnet-latest" }) === false);

const acts = ctx.CP.llm.parseActions('先看看\n```akyuu\n{"tool":"insert_block","args":{"content":"hi"}}\n```\n完成');
check("解析 akyuu 动作块", acts.length === 1 && acts[0].name === "insert_block" && acts[0].args.content === "hi", JSON.stringify(acts));
check("数组形式的多动作", ctx.CP.llm.parseActions('```akyuu\n[{"tool":"a"},{"name":"b","args":{"x":1}}]\n```').length === 2);
check("坏 JSON 忽略", ctx.CP.llm.parseActions("```akyuu\n这不是 JSON\n```").length === 0);
check("普通 ```json 不算动作", ctx.CP.llm.parseActions('```json\n{"tool":"x"}\n```').length === 0);
const stripped = ctx.CP.llm.stripActions('说明一\n```akyuu\n{"tool":"x"}\n```\n说明二');
check("剥离动作块", !/akyuu/.test(stripped) && /说明一/.test(stripped) && /说明二/.test(stripped), JSON.stringify(stripped));

const flat = ctx.CP.llm.flatten([
  { role: "user", content: "q" },
  { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "insert_block", arguments: '{"content":"x"}' } }] },
  { role: "tool", tool_call_id: "1", name: "insert_block", content: "成功：ok" },
]);
check("工具往返压平", flat.length === 3 && /```akyuu/.test(flat[1].content) && /tool_result/.test(flat[2].content), JSON.stringify(flat));
const normCalls = ctx.CP.llm.normalizeToolCalls({ 0: { id: "c1", name: "insert_block", args: '{"content":"y"}' } });
check("流式增量归一", normCalls.length === 1 && normCalls[0].args.content === "y", JSON.stringify(normCalls));

// 「别人的机子上报 create_page 缺 name」那次线上问题的回归用例
const objArgs = ctx.CP.llm.normalizeToolCalls([{ id: "c2", type: "function", function: { name: "create_page", arguments: { name: "周报" } } }]);
check("arguments 是对象时也能用", objArgs.length === 1 && objArgs[0].args.name === "周报", JSON.stringify(objArgs));
const flatArgs = ctx.CP.llm.normalizeToolCalls([{ id: "c3", name: "create_page", page: "周报", blocks: ["a"] }]);
check("参数摊平在顶层也能用", flatArgs.length === 1 && flatArgs[0].args.page === "周报", JSON.stringify(flatArgs));
const textFlat = ctx.CP.llm.parseActions('```akyuu\n{"tool":"create_page","name":"周报","blocks":["a"]}\n```');
check("文本协议参数摊平时 name 当参数", textFlat.length === 1 && textFlat[0].args.name === "周报", JSON.stringify(textFlat));
const badArgs = ctx.CP.llm.normalizeToolCalls([{ id: "c4", function: { name: "create_page", arguments: '{"name":' } }]);
check("截断的 JSON 标成解析失败", badArgs.length === 1 && badArgs[0].rawArgs.length > 0, JSON.stringify(badArgs));
const wrappedArgs = ctx.CP.llm.parseArgs('这是一段废话\n```json\n{"name":"周报"}\n```');
check("参数被代码块包着也能抠出来", wrappedArgs.ok === true && wrappedArgs.args.name === "周报", JSON.stringify(wrappedArgs));

console.log("tools 注册表");
const allTools = ctx.CP.tools.all();
check("17 个工具", allTools.length === 17, String(allTools.length));
check("每个都有 JSON Schema", allTools.every((t) => t.parameters && t.parameters.type === "object"));
check("写操作被标记", ctx.CP.tools.isWrite("insert_block") && !ctx.CP.tools.isWrite("read_page"));
check("删除被标 danger", ctx.CP.tools.isDanger("delete_block") && ctx.CP.tools.isDanger("delete_page") && !ctx.CP.tools.isDanger("update_block"));
check("页面级工具有齐", ["set_page_property", "remove_page_property", "move_page_blocks", "delete_page", "restore_page"].every((n) => !!ctx.CP.tools.get(n)));
const specs = ctx.CP.tools.specs();
check("specs 是 OpenAI 格式", specs[0].type === "function" && typeof specs[0].function.name === "string");
check("缺必填参数被拦", (() => {
  try {
    ctx.CP.tools.validate("update_block", { uuid: "x" });
    return false;
  } catch (e) {
    return /content/.test(e.message);
  }
})());
check("数字参数被强转", ctx.CP.tools.validate("search_graph", { query: "x", limit: "5" }).limit === 5);
const badTool = await ctx.CP.tools.run("nope", {});
check("未知工具不抛异常", badTool.ok === false && /没有这个工具/.test(badTool.message));
const noLs = await ctx.CP.tools.run("read_page", { page: "current" });
check("没有 logseq 时给出可读错误", noLs.ok === false && noLs.message.length > 0, noLs.message);

const treeNodes = ctx.CP.tools.parseTree(["A", "  B", "  C", "    D", "E"]);
check(
  "缩进→块树",
  treeNodes.length === 2 && treeNodes[0].children.length === 2 && treeNodes[0].children[1].children.length === 1,
  JSON.stringify(treeNodes)
);
check("协议说明包含工具名", /insert_block/.test(ctx.CP.tools.protocolPrompt()));

console.log("agent 提示词");
check("原生工具说明", /工具使用/.test(ctx.CP.agent.buildSystem("base", true, true)));
check("文本协议说明", /行动协议/.test(ctx.CP.agent.buildSystem("base", true, false)));
check("关闭工具时不加料", ctx.CP.agent.buildSystem("base", false, false) === "base");

console.log("agent 参数兜底");
{
  let asked = 0;
  let seen = [];
  let n = 0;
  const realTurn = ctx.CP.llm.chatTurn;
  ctx.CP.llm.chatTurn = async (o) => {
    seen = o.messages;
    n++;
    if (n === 1) return { text: "", toolCalls: [{ id: "c1", name: "create_page", args: {} }], native: true };
    return { text: "好的", toolCalls: [], native: true };
  };
  const res = await ctx.CP.agent.run({
    messages: [{ role: "user", content: "建个页面" }],
    system: "s",
    onRound: () => ({ delta: () => {}, final: () => {} }),
    onToolCalls: async () => {
      asked++;
      return [];
    },
  });
  check("参数不全时不弹确认卡片", asked === 0, "asked=" + asked);
  check("参数不全时把「缺什么」回喂模型", /缺少参数 name/.test(JSON.stringify(seen)), JSON.stringify(seen).slice(0, 200));
  check("参数不全时会自动重试一轮", res.rounds === 2, "rounds=" + res.rounds);

  // 参数齐全时照常走确认
  asked = 0;
  n = 0;
  ctx.CP.llm.chatTurn = async () => {
    n++;
    if (n === 1) return { text: "", toolCalls: [{ id: "c2", name: "create_page", args: { name: "周报" } }], native: true };
    return { text: "完成", toolCalls: [], native: true };
  };
  await ctx.CP.agent.run({
    messages: [{ role: "user", content: "建个页面" }],
    system: "s",
    onRound: () => ({ delta: () => {}, final: () => {} }),
    onToolCalls: async () => {
      asked++;
      return [{ ok: true, message: "已新建页面《周报》" }];
    },
  });
  check("参数齐全时仍然要确认", asked === 1, "asked=" + asked);
  ctx.CP.llm.chatTurn = realTurn;
}

console.log("agent 轮数上限");
{
  ctx.logseq = { settings: { toolMaxRounds: 2, enableTools: true, toolPolicy: "confirm" } };
  let n = 0;
  let asked = 0;
  const real = ctx.CP.llm.chatTurn;
  ctx.CP.llm.chatTurn = async () => {
    n++;
    return { text: "", toolCalls: [{ id: "c" + n, name: "create_page", args: { name: "P" + n } }], native: true };
  };
  const res = await ctx.CP.agent.run({
    messages: [{ role: "user", content: "批量建页" }],
    system: "s",
    onRound: () => ({ delta: () => {}, final: () => {} }),
    onToolCalls: async (calls) => {
      asked += calls.length;
      return calls.map(() => ({ ok: true, message: "ok" }));
    },
  });
  check("按设置只跑 2 轮", res.rounds === 2, "rounds=" + res.rounds);
  check("停手时提示「继续」", /最大工具轮数 2/.test(res.note) && /继续/.test(res.note), res.note);
  check("上限内工具被执行", asked === 2, "asked=" + asked);
  check("maxRounds 读到设置", ctx.CP.agent.maxRounds() === 2);
  ctx.CP.llm.chatTurn = real;
  delete ctx.logseq;
}

console.log("retrieval 图谱字段探测（DB 版图谱）");
{
  const seen = [];
  ctx.logseq = {
    DB: {
      datascriptQuery: async (q) => {
        seen.push(q);
        if (q.indexOf("(count ?b)") >= 0) {
          if (q.indexOf(":block/content]") >= 0) return [[0]];
          if (q.indexOf(":block/title]") >= 0) return [[40]];
          return [[42]];
        }
        if (q.indexOf("(count ?p)") >= 0) return [[12]];
        if (q.indexOf(":block/title ?text") >= 0) return [["u1", "读书笔记1 的第一条内容", "读书笔记1"]];
        return [];
      },
    },
  };
  const caps = await ctx.CP.retrieval.capabilities(true);
  check("DB 图谱自动切到 :block/title", caps.content === "title" && caps.graph === "db", JSON.stringify(caps));
  const rows = await ctx.CP.retrieval.searchBlocks("读书笔记1", 5);
  check("DB 图谱能搜到块", rows.length === 1 && /读书笔记1/.test(rows[0].content), JSON.stringify(rows));
  check("关键词内联进查询（不再依赖 :in 传参）", seen.some((q) => q.indexOf('"读书笔记1"') >= 0 && q.indexOf(":in $") < 0));
  const probed = await ctx.CP.retrieval.probe("读书笔记1");
  check("诊断报告命中与正文键", probed.rows === 1 && probed.caps.content === "title", JSON.stringify(probed).slice(0, 160));
  check("EDN 字符串转义", ctx.CP.retrieval.ednStr('a"b\\c') === '"a\\"b\\\\c"', ctx.CP.retrieval.ednStr('a"b\\c'));
  ctx.CP.retrieval.resetCaps();
  delete ctx.logseq;
}

console.log("retrieval 回收站过滤（DB 版软删除）");
{
  ctx.logseq = {
    DB: {
      datascriptQuery: async (q) => {
        if (q.indexOf("(count ?b)") >= 0) return q.indexOf(":block/content]") >= 0 ? [[0]] : [[50]];
        if (q.indexOf("(count ?p)") >= 0) return [[10]];
        if (q.indexOf(":logseq.property/deleted-at") >= 0) return [["读书笔记1"]];
        if (q.indexOf(":block/title ?text") >= 0) {
          const m = /includes\? \?lt "([^"]*)"\)?\]\]/.exec(q);
          const needle = m ? m[1] : "";
          return [
            ["u1", "读书笔记1 的内容", "读书笔记1"],
            ["u2", "读书笔记3 的存活内容", "读书笔记3"],
          ].filter((r) => r[1].indexOf(needle) >= 0 || r[2].indexOf(needle) >= 0);
        }
        return [];
      },
    },
    Editor: {
      getAllPages: async () => [{ name: "读书笔记1" }, { name: "读书笔记3" }, { name: "别的" }],
      getPage: async (n) => (n === "读书笔记1" ? { name: "读书笔记1" } : null),
      getPageBlocksTree: async () => [],
    },
  };
  ctx.CP.retrieval.resetCaps();
  ctx.CP.retrieval.resetDeleted();
  const del = await ctx.CP.retrieval.deletedPageNames(true);
  check("识别出回收站页面", del.has("读书笔记1"), JSON.stringify(Array.from(del)));
  const rows = await ctx.CP.retrieval.searchBlocks("读书笔记", 5);
  check("回收站页面的块被过滤", rows.length === 1 && rows[0].page === "读书笔记3", JSON.stringify(rows));
  const listed = await ctx.CP.tools.run("list_pages", { query: "读书笔记" });
  check("list_pages 不列已删页面", !/读书笔记1/.test(listed.message) && /已排除回收站/.test(listed.message), listed.message);
  const live = await ctx.CP.tools.run("list_pages", { query: "读书笔记3" });
  check("list_pages 仍能列出存活页面", /读书笔记3/.test(live.message), live.message);
  const sg = await ctx.CP.tools.run("search_graph", { query: "读书笔记1" });
  check("search_graph 说明页面已删除", /已经被删除/.test(sg.message), sg.message.slice(0, 140));
  ctx.CP.retrieval.resetCaps();
  ctx.CP.retrieval.resetDeleted();
  delete ctx.logseq;
}

console.log("workspace 会话格式");const sess = ctx.CP.ws.normalizeSession({
  id: "s1",
  messages: [{ role: "user", content: "你好" }, { role: "assistant", content: "在" }],
});
check("标题取首条用户消息", sess.title === "你好", sess.title);
check("消息规范化", sess.messages.length === 2 && sess.messages[1].role === "assistant");
check("导出 markdown", /# 你好/.test(ctx.CP.ws.toMarkdown(sess)) && /Akyuu/.test(ctx.CP.ws.toMarkdown(sess)));
check("会话 id 唯一", ctx.CP.ws.newId() !== ctx.CP.ws.newId());

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
