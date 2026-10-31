/**
 * 多轮工具循环（agent loop）。
 *
 *   user → 模型 → 有工具调用？
 *            ├─ 否 → 直接回答，结束
 *            └─ 是 → 面板确认 → 执行 → 结果回填 → 再问模型（最多 4 轮 / 8 次调用）
 *
 * 协议自适应：OpenAI 兼容接口 + 非推理模型走原生 function calling；
 * 其余（deepseek-reasoner / Anthropic / Gemini）走工具层里的文本协议，
 * 解析和压平都在 llm.js 里完成，这里只处理统一结构。
 */
(function (global) {
  const CP = (global.CP = global.CP || {});
  const MAX_ROUNDS = 4; // 默认值；设置里的「最多工具轮数」可以覆盖
  const MAX_TOOLS = 8;

  /** 一次提问允许几轮工具往返（1~8，防止模型原地打转 + 烧钱） */
  function maxRounds() {
    const n = Number(settings().toolMaxRounds);
    if (!Number.isFinite(n) || n <= 0) return MAX_ROUNDS;
    return Math.max(1, Math.min(8, Math.round(n)));
  }

  function settings() {
    return (global.logseq && global.logseq.settings) || {};
  }

  function abortErr() {
    const e = new Error("已停止");
    e.name = "AbortError";
    return e;
  }

  function textOf(r) {
    if (!r) return "未执行";
    return (r.ok ? "成功：" : "失败：") + String(r.message == null ? "" : r.message);
  }

  function assistantMsg(turn, calls, native) {
    if (!native || !calls.length) return { role: "assistant", content: turn.text || "" };
    return {
      role: "assistant",
      content: turn.text || "",
      // 原生协议下必须把 tool_calls 原样回传，否则下一轮会 400
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
      })),
    };
  }

  function toolMsgs(calls, results, native) {
    if (native) {
      return calls.map((c, i) => ({
        role: "tool",
        tool_call_id: c.id,
        name: c.name,
        content: textOf(results[i]),
      }));
    }
    const lines = calls.map((c, i) => '<tool_result name="' + c.name + '">\n' + textOf(results[i]) + "\n</tool_result>");
    return [
      {
        role: "user",
        content:
          "<tool_results>\n" +
          lines.join("\n") +
          "\n</tool_results>\n" +
          "请根据上面的结果继续：还需要动手就继续输出 ```akyuu 代码块；否则直接给用户最终回答，不要复述工具调用过程。",
      },
    ];
  }

  const NATIVE_RULE =
    "【工具使用】你可以调用工具真正读写这个图谱。规则：" +
    "① 改笔记前先用 read_page / search_graph / list_pages 确认目标；② 没有把握就不要猜 uuid；" +
    "③ 一次最多调用 3 个工具；④ 删除类操作要先在回答里问用户；" +
    "⑤ 工具执行完要基于结果给用户一句结论，不要复述 JSON。";

  function buildSystem(base, toolsOn, native) {
    const s = String(base || "");
    if (!toolsOn) return s;
    if (native) return s + "\n\n" + NATIVE_RULE;
    return s + "\n\n" + CP.tools.protocolPrompt();
  }

  /**
   * @param {{
   *   messages: object[], system: string, signal?: AbortSignal, tools?: boolean,
   *   onRound: (index:number) => ({delta:Function, reasoning?:Function, final:Function}),
   *   onToolCalls: (calls:object[]) => Promise<object[]>,
   * }} opts
   */
  async function run(opts) {
    const o = opts || {};
    const s = settings();
    const toolsOn = o.tools !== false && s.enableTools !== false && s.toolPolicy !== "off";
    const specs = toolsOn ? CP.tools.specs() : null;
    let cfg = null;
    try {
      cfg = CP.llm.resolve();
    } catch (e) {
      cfg = null;
    }
    const native = !!(specs && cfg && CP.llm.supportsNativeTools(cfg));
    const system = buildSystem(o.system, toolsOn, native);
    const messages = (o.messages || []).slice();

    let executed = 0;
    let rounds = 0;
    let note = "";
    let lastSig = "";
    const limit = maxRounds();

    while (rounds < limit) {
      if (o.signal && o.signal.aborted) throw abortErr();
      const sink = await o.onRound(rounds);
      rounds++;

      let turn;
      try {
        turn = await CP.llm.chatTurn({
          messages: messages,
          system: system,
          tools: specs,
          signal: o.signal,
          onDelta: (d) => sink.delta(d),
          onReasoning: sink.reasoning ? (d) => sink.reasoning(d) : undefined,
        });
      } catch (err) {
        if (sink.error) sink.error(err);
        throw err;
      }

      const calls = (turn.toolCalls || []).slice();
      if (!calls.length || !toolsOn) {
        if (sink.final) sink.final(turn);
        return { rounds: rounds, executed: executed, note: note, text: turn.text };
      }

      // 防止模型原地打转：同一批调用连续出现两次就停
      const sig = calls.map((c) => c.name + ":" + JSON.stringify(c.args || {})).join("|");
      if (sig === lastSig) {
        note = "（检测到重复的工具调用，已停止自动执行）";
        if (sink.final) sink.final(turn);
        return { rounds: rounds, executed: executed, note: note, text: turn.text };
      }
      lastSig = sig;

      const allowance = Math.max(0, MAX_TOOLS - executed);
      const batch = calls.slice(0, allowance);
      const dropped = allowance <= 0 || calls.length > allowance;

      if (sink.final) sink.final(turn);

      // 参数不合法（模型没给全 / arguments 被截断）的调用：不麻烦用户确认，
      // 直接把「缺什么」喂回模型让它重试——这正是「create_page 缺 name」那类报错的修法。
      const preErrors = batch.map((c) => {
        try {
          c.args = CP.tools.validate(c.name, c.args || {});
          return null;
        } catch (e) {
          if (global.console && console.warn) {
            console.warn("[akyuu] 工具参数不合法，已让模型重试：", c.name, c.args, c.rawArgs || "");
          }
          return {
            ok: false,
            message:
              e.message +
              "。请重新调用 " +
              c.name +
              "，这次必须给出完整、合法的参数" +
              (c.rawArgs ? "（上一次收到的参数是：" + String(c.rawArgs).slice(0, 160) + "）" : ""),
          };
        }
      });
      const ask = batch.filter((c, i) => !preErrors[i]);

      let asked = [];
      if (ask.length) {
        try {
          asked = await o.onToolCalls(ask);
        } catch (err) {
          asked = ask.map(() => ({ ok: false, message: "确认或执行失败：" + ((err && err.message) || err) }));
        }
        if (!Array.isArray(asked) || asked.length !== ask.length) {
          asked = ask.map((c, i) => (asked && asked[i]) || { ok: false, message: "未执行" });
        }
      }

      let cursor = 0;
      const results = batch.map((c, i) => preErrors[i] || asked[cursor++] || { ok: false, message: "未执行" });
      executed += batch.length;

      messages.push(assistantMsg(turn, batch, native));
      Array.prototype.push.apply(messages, toolMsgs(batch, results, native));

      if (o.signal && o.signal.aborted) throw abortErr();

      if (dropped) {
        note = "（本轮工具调用达到上限 " + MAX_TOOLS + " 次，已忽略多余请求）";
        return { rounds: rounds, executed: executed, note: note, text: "" };
      }
    }

    return {
      rounds: rounds,
      executed: executed,
      note: "（已达到最大工具轮数 " + limit + "：如果还有没做完的操作，发「继续」我就接着做）",
      text: "",
    };
  }

  CP.agent = { run: run, MAX_ROUNDS: MAX_ROUNDS, MAX_TOOLS: MAX_TOOLS, maxRounds: maxRounds, buildSystem: buildSystem };
})(typeof window !== "undefined" ? window : globalThis);
