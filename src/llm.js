/**
 * 多供应商 LLM 客户端：OpenAI 兼容 / Anthropic / Google Gemini。
 * 统一输出：{ text, usage, model }；流式时通过 onDelta 增量回调。
 */
(function (global) {
  const CP = (global.CP = global.CP || {});

  const PRESETS = {
    openai: { label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", needsKey: true },
    deepseek: { label: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", needsKey: true },
    openrouter: { label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", needsKey: true },
    siliconflow: { label: "SiliconFlow", kind: "openai", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct", needsKey: true },
    moonshot: { label: "Moonshot", kind: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", needsKey: true },
    ollama: { label: "Ollama（本地）", kind: "openai", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b", needsKey: false },
    lmstudio: { label: "LM Studio（本地）", kind: "openai", baseUrl: "http://localhost:1234/v1", model: "local-model", needsKey: false },
    anthropic: { label: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-3-5-sonnet-latest", needsKey: true },
    google: {
      label: "Google Gemini",
      kind: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.0-flash",
      needsKey: true,
    },
    custom: { label: "自定义（OpenAI 兼容）", kind: "openai", baseUrl: "", model: "", needsKey: false },
  };

  function cfg() {
    return (global.logseq && global.logseq.settings) || {};
  }

  function num(v, def) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  function presetOf(provider) {
    return PRESETS[provider] || PRESETS.custom;
  }

  /** 当前生效的配置（设置里的值优先，空值回落到预设） */
  function resolve() {
    const s = cfg();
    const provider = PRESETS[s.provider] ? s.provider : "openai";
    const preset = PRESETS[provider];
    const apiKey = String(s.apiKey || "").trim();
    const baseUrl = String(s.baseUrl || "").trim() || preset.baseUrl;
    return {
      provider: provider,
      label: preset.label,
      kind: preset.kind,
      apiKey: apiKey,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      model: String(s.model || "").trim() || preset.model,
      temperature: num(s.temperature, 0.7),
      maxTokens: num(s.maxTokens, 2048),
      needsKey: preset.needsKey,
    };
  }

  function isLocal(url) {
    return /(^|\.)localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(url || "");
  }

  function assertReady(c) {
    if (!c.baseUrl) throw new Error("还没配置 API 地址（baseUrl）：请在插件设置里填写，或选择一个预设供应商。");
    if (!c.model) throw new Error("还没配置模型名（model）：请在插件设置里填写。");
    if (!c.apiKey && !isLocal(c.baseUrl) && !/localhost/.test(c.baseUrl)) {
      throw new Error("缺少 API Key：请在插件设置 → Logseq Akyuu 里填写。");
    }
  }

  function parseEvent(raw) {
    let data = [];
    let event = "";
    raw.split(/\r?\n/).forEach((line) => {
      if (line.startsWith("data:")) data.push(line.slice(5).trim());
      else if (line.startsWith("event:")) event = line.slice(6).trim();
    });
    if (!data.length) return null;
    const payload = data.join("\n");
    if (payload === "[DONE]") return { done: true };
    try {
      return { done: false, event: event, json: JSON.parse(payload) };
    } catch (e) {
      return null;
    }
  }

  async function readSSE(res, onEvent, signal) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    while (true) {
      if (signal && signal.aborted) {
        try {
          reader.cancel();
        } catch (e) {
          /* ignore */
        }
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseEvent(chunk);
        if (ev) onEvent(ev);
      }
    }
    if (buffer.trim()) {
      const ev = parseEvent(buffer);
      if (ev) onEvent(ev);
    }
  }

  async function readError(res) {
    let body = "";
    try {
      body = await res.text();
    } catch (e) {
      /* ignore */
    }
    let msg = body;
    try {
      const j = JSON.parse(body);
      msg = (j.error && (j.error.message || j.error.type)) || j.message || body;
    } catch (e) {
      /* keep raw */
    }
    const hint =
      res.status === 401 || res.status === 403
        ? "（Key 无效或没有权限）"
        : res.status === 404
        ? "（接口地址或模型名不对）"
        : res.status === 429
        ? "（限流/余额不足）"
        : "";
    return new Error("HTTP " + res.status + " " + hint + "：" + String(msg).slice(0, 400));
  }

  /** 推理模型（deepseek-reasoner / R1 系）不吃 temperature，且 CoT 也占输出预算 */
  function isReasoningModel(model) {
    return /reasoner|deepseek-r1|(^|[^a-z])r1([^a-z]|$)/i.test(String(model || ""));
  }

  function openAIRequest(c, system, messages, stream, tools) {
    const reasoning = isReasoningModel(c.model);
    const body = {
      model: c.model,
      messages: messages.map((m) => {
        const out = { role: m.role, content: m.content == null ? "" : m.content };
        // 工具往返：assistant 的 tool_calls 必须原样回传，tool 消息要带 tool_call_id
        if (m.tool_calls && m.tool_calls.length) out.tool_calls = m.tool_calls;
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        return out;
      }),
      stream: !!stream,
    };
    // deepseek-reasoner 不支持 temperature；传了会被忽略，干脆不传
    if (!reasoning && Number.isFinite(c.temperature)) body.temperature = c.temperature;
    if (c.maxTokens > 0) body.max_tokens = reasoning ? Math.max(c.maxTokens, 8192) : c.maxTokens;
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    if (system) body.messages = [{ role: "system", content: system }].concat(body.messages);
    const headers = { "Content-Type": "application/json" };
    if (c.apiKey) headers.Authorization = "Bearer " + c.apiKey;
    return { url: c.baseUrl + "/chat/completions", headers: headers, body: body };
  }

  function anthropicRequest(c, system, messages, stream) {
    const body = {
      model: c.model,
      max_tokens: c.maxTokens > 0 ? c.maxTokens : 2048,
      messages: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
      stream: !!stream,
    };
    if (Number.isFinite(c.temperature)) body.temperature = c.temperature;
    if (system) body.system = system;
    return {
      url: c.baseUrl + "/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": c.apiKey,
        "anthropic-version": "2023-06-01",
        // 允许在浏览器/Electron 渲染进程里直连（Anthropic 的 CORS 开关）
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: body,
    };
  }

  function googleRequest(c, system, messages, stream) {
    const body = {
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: {},
    };
    if (Number.isFinite(c.temperature)) body.generationConfig.temperature = c.temperature;
    if (c.maxTokens > 0) body.generationConfig.maxOutputTokens = c.maxTokens;
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const method = stream ? ":streamGenerateContent?alt=sse&key=" : ":generateContent?key=";
    return {
      url: c.baseUrl + "/models/" + encodeURIComponent(c.model) + method + encodeURIComponent(c.apiKey),
      headers: { "Content-Type": "application/json" },
      body: body,
    };
  }

  /* --------------------------- 工具调用支持 --------------------------- */

  function safeJson(str, fallback) {
    if (str == null) return fallback;
    if (typeof str === "object") return str;
    try {
      const v = JSON.parse(String(str));
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  /**
   * 原生 function calling 只对 OpenAI 兼容接口 + 非推理模型开启：
   * deepseek-reasoner 不支持 tools，Anthropic/Google 的参数格式不同，
   * 这些走「文本协议」（模型输出 ```akyuu JSON 代码块，我们再解析）。
   * 设置里的 toolProtocol 可以强制选择，用于个别不认 tools 的兼容模型。
   */
  function supportsNativeTools(c) {
    if (c.kind !== "openai") return false;
    const s = (global.logseq && global.logseq.settings) || {};
    const pref = s.toolProtocol || "auto";
    if (pref === "text") return false;
    if (pref === "native") return true;
    return !isReasoningModel(c.model);
  }

  const ACTION_RE = /```akyuu(?:-action|-tools)?[ \t]*\r?\n([\s\S]*?)```/g;

  /**
   * 把模型给的 arguments 变成对象。兼容三种常见形态：
   *   1. 已经是对象（有些网关/代理会把 JSON 解析好再下发）
   *   2. JSON 字符串（标准 OpenAI 流式）
   *   3. 被代码块或废话包着的 JSON（弱模型常见）
   * 解析失败时 ok=false，并带回原文，方便回喂给模型让它重试。
   */
  function parseArgs(raw) {
    if (raw == null) return { args: {}, ok: false, raw: "" };
    if (typeof raw === "object") return { args: raw, ok: true, raw: JSON.stringify(raw) };
    const text = String(raw).trim();
    if (!text) return { args: {}, ok: false, raw: "" };
    const direct = safeJson(text, null);
    if (direct && typeof direct === "object") return { args: direct, ok: true, raw: text };
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s >= 0 && e > s) {
      const sliced = safeJson(text.slice(s, e + 1), null);
      if (sliced && typeof sliced === "object") return { args: sliced, ok: true, raw: text };
    }
    return { args: {}, ok: false, raw: text.slice(0, 240) };
  }

  const ACTION_RESERVED = { tool: 1, tool_name: 1, args: 1, arguments: 1, input: 1 };

  /** 从文本里抽出 ```akyuu {...} 动作块 —— 文本协议的解析器（纯函数，便于单测） */
  function parseActions(text) {
    const out = [];
    const src = String(text || "");
    ACTION_RE.lastIndex = 0;
    let m;
    while ((m = ACTION_RE.exec(src))) {
      const body = String(m[1] || "").trim();
      let json = safeJson(body, null);
      if (json == null) {
        const s = body.indexOf("{");
        const e = body.lastIndexOf("}");
        if (s >= 0 && e > s) json = safeJson(body.slice(s, e + 1), null);
      }
      if (json == null) continue;
      const arr = Array.isArray(json) ? json : [json];
      arr.forEach((x) => {
        if (!x || typeof x !== "object") return;
        // 工具名可能在 tool / tool_name / name 上
        const nameKey = x.tool != null ? "tool" : x.tool_name != null ? "tool_name" : "name";
        const name = String(x[nameKey] || "").trim();
        if (!name) return;
        let parsed = parseArgs(x.args != null ? x.args : x.arguments != null ? x.arguments : x.input);
        if (!parsed.ok) {
          // 参数可能直接摊在顶层：{"tool":"create_page","name":"X","blocks":[...]}
          const extra = {};
          Object.keys(x).forEach((k) => {
            if (ACTION_RESERVED[k] || k === nameKey) return;
            extra[k] = x[k];
          });
          if (Object.keys(extra).length) parsed = { args: extra, ok: true, raw: parsed.raw };
        }
        out.push({
          id: "call_" + out.length + "_" + Math.random().toString(36).slice(2, 6),
          name: name,
          args: parsed.args,
          rawArgs: parsed.ok ? "" : parsed.raw,
        });
      });
    }
    return out;
  }

  function stripActions(text) {
    ACTION_RE.lastIndex = 0;
    return String(text || "").replace(ACTION_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  /** 把工具往返消息压平成纯 role/content（非原生工具的供应商用） */
  function flatten(messages) {
    const out = [];
    (messages || []).forEach((m) => {
      let role = m.role === "assistant" ? "assistant" : "user";
      let content;
      if (m.role === "tool") {
        content =
          '<tool_result name="' + (m.name || "") + '">\n' + String(m.content == null ? "" : m.content) + "\n</tool_result>";
        role = "user";
      } else if (m.tool_calls && m.tool_calls.length) {
        const blocks = m.tool_calls
          .map((tc) => "```akyuu\n" + JSON.stringify({ tool: tc.function.name, args: safeJson(tc.function.arguments, {}) }) + "\n```")
          .join("\n");
        content = (m.content ? m.content + "\n\n" : "") + blocks;
      } else {
        content = m.content == null ? "" : m.content;
      }
      const prev = out[out.length - 1];
      if (prev && prev.role === role) prev.content += "\n\n" + content; // Anthropic 要求角色交替
      else out.push({ role: role, content: content });
    });
    return out.filter((m) => m.content !== "");
  }

  const CALL_RESERVED = { id: 1, type: 1, index: 1, tool: 1, tool_name: 1, args: 1, arguments: 1, input: 1, function: 1 };

  /**
   * 把各种形态的 tool_calls 归一成 {id, name, args, rawArgs}。
   * 兼容：arguments 是对象 / JSON 字符串 / 缺失但参数摊平在顶层（部分网关与弱模型）。
   */
  function normalizeToolCalls(list) {
    const arr = Array.isArray(list)
      ? list
      : list && typeof list === "object"
      ? Object.keys(list)
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => list[k])
      : [];
    const out = [];
    arr.filter(Boolean).forEach((tc, i) => {
      // 标准形态有 function 子对象；有的网关直接给平铺的 name/args
      const hasFn = !!(tc.function && typeof tc.function === "object");
      const fn = hasFn ? tc.function : tc;
      const name = String((hasFn ? fn.name : tc.name) || "").trim();
      if (!name) return;
      const raw = fn.arguments != null ? fn.arguments : tc.args != null ? tc.args : tc.input;
      let parsed = parseArgs(raw);
      if (!parsed.ok && !hasFn) {
        const extra = {};
        Object.keys(tc).forEach((k) => {
          if (CALL_RESERVED[k] || k === "name") return;
          extra[k] = tc[k];
        });
        if (Object.keys(extra).length) parsed = { args: extra, ok: true, raw: parsed.raw };
      }
      out.push({
        id: tc.id || "call_" + i,
        name: name,
        args: parsed.args,
        rawArgs: parsed.ok ? "" : parsed.raw,
      });
    });
    return out;
  }

  /**
   * 一轮对话（可能带工具）。与 chat() 的区别：返回结构和消息形态都保留工具往返。
   * @param {{messages:object[], system?:string, tools?:object[], onDelta?:Function, signal?:AbortSignal}} opts
   * @returns {Promise<{text:string, reasoning:string, toolCalls:object[], usage:any, native:boolean}>}
   */
  async function chatTurn(opts) {
    const c = resolve();
    assertReady(c);
    if (opts.maxTokens) c.maxTokens = opts.maxTokens;
    if (Number.isFinite(opts.temperature)) c.temperature = opts.temperature;
    const useStream = typeof opts.onDelta === "function";
    const tools = Array.isArray(opts.tools) && opts.tools.length ? opts.tools : null;
    const native = !!(tools && supportsNativeTools(c));
    const raw = (opts.messages || []).filter(
      (m) => m && (m.role === "tool" || (m.tool_calls && m.tool_calls.length) || (m.content != null && m.content !== ""))
    );
    const messages = native ? raw : flatten(raw);

    const req =
      c.kind === "anthropic"
        ? anthropicRequest(c, opts.system, messages, useStream)
        : c.kind === "google"
        ? googleRequest(c, opts.system, messages, useStream)
        : openAIRequest(c, opts.system, messages, useStream, native ? tools : null);

    const res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: opts.signal,
    });
    if (!res.ok) throw await readError(res);

    let text = "";
    let reasoning = "";
    let usage = null;
    const partial = {};
    let finalCalls = [];

    if (!useStream) {
      const json = await res.json();
      let calls = [];
      if (c.kind === "anthropic") {
        text = (json.content || []).map((p) => p.text || "").join("");
        usage = json.usage || null;
      } else if (c.kind === "google") {
        const cand = (json.candidates || [])[0];
        text = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("");
        usage = json.usageMetadata || null;
      } else {
        const choice = (json.choices || [])[0] || {};
        const msg = choice.message || {};
        text = msg.content || "";
        reasoning = msg.reasoning_content || "";
        calls = normalizeToolCalls(msg.tool_calls);
        usage = json.usage || null;
      }
      if (opts.onReasoning && reasoning) opts.onReasoning(reasoning);
      if (opts.onDelta && text) opts.onDelta(text);
      return { text: text, reasoning: reasoning, toolCalls: calls, usage: usage, native: native };
    }

    await readSSE(
      res,
      (ev) => {
        if (ev.done) return;
        const j = ev.json || {};
        let delta = "";
        if (c.kind === "anthropic") {
          if ((ev.event === "content_block_delta" || j.type === "content_block_delta") && j.delta) {
            if (j.delta.type === "text_delta" || j.delta.text) delta = j.delta.text || "";
          }
          if (j.usage) usage = j.usage;
        } else if (c.kind === "google") {
          const cand = (j.candidates || [])[0];
          delta = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("");
          if (j.usageMetadata) usage = j.usageMetadata;
        } else {
          const choice = (j.choices || [])[0];
          if (choice) {
            const d = choice.delta || {};
            if (d.reasoning_content) {
              reasoning += d.reasoning_content;
              if (opts.onReasoning) opts.onReasoning(d.reasoning_content);
            }
            if (d.tool_calls) {
              d.tool_calls.forEach((tc) => {
                const idx = typeof tc.index === "number" ? tc.index : 0;
                const slot = (partial[idx] = partial[idx] || { id: "", name: "", args: "", obj: null });
                if (tc.id) slot.id = tc.id;
                const fn = tc.function || {};
                if (fn.name) slot.name += fn.name;
                if (fn.arguments != null && fn.arguments !== "") {
                  // 少数网关会把 arguments 直接给成对象，不能字符串拼接
                  if (typeof fn.arguments === "string") slot.args += fn.arguments;
                  else slot.obj = Object.assign(slot.obj || {}, fn.arguments);
                }
              });
            }
            delta = d.content || "";
            // 有的网关不是流式增量，而是最后一次性给 message.tool_calls
            if (!d.tool_calls && choice.message && choice.message.tool_calls) {
              finalCalls = normalizeToolCalls(choice.message.tool_calls);
            }
            if (!delta && choice.finish_reason && choice.message) delta = choice.message.content || "";
          }
          if (j.usage) usage = j.usage;
        }
        if (delta) {
          text += delta;
          opts.onDelta(delta);
        }
      },
      opts.signal
    );

    const streamed = Object.keys(partial)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => {
        const s = partial[k];
        return { id: s.id, function: { name: s.name, arguments: s.obj || s.args } };
      });
    let toolCalls = normalizeToolCalls(streamed);
    if (!toolCalls.length && finalCalls.length) toolCalls = finalCalls;
    if (!native) {
      const actions = parseActions(text);
      if (actions.length) {
        toolCalls = actions;
        text = stripActions(text);
      }
    }
    return { text: text, reasoning: reasoning, toolCalls: toolCalls, usage: usage, native: native };
  }

  /**
   * 发起一次对话。
   * @param {{messages: {role:string,content:string}[], system?: string, onDelta?: Function, signal?: AbortSignal}} opts
   */
  async function chat(opts) {
    const c = resolve();
    assertReady(c);
    // 支持单次调用覆盖（查询扩展用很小的 maxTokens / 温度 0，不必改用户设置）
    if (opts.maxTokens) c.maxTokens = opts.maxTokens;
    if (Number.isFinite(opts.temperature)) c.temperature = opts.temperature;
    const messages = (opts.messages || []).filter((m) => m && m.content && m.role !== "system");
    const useStream = typeof opts.onDelta === "function";
    const req =
      c.kind === "anthropic"
        ? anthropicRequest(c, opts.system, messages, useStream)
        : c.kind === "google"
        ? googleRequest(c, opts.system, messages, useStream)
        : openAIRequest(c, opts.system, messages, useStream);

    const res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: opts.signal,
    });
    if (!res.ok) throw await readError(res);

    let text = "";
    let reasoningText = "";
    let usage = null;

    if (!useStream) {
      const json = await res.json();
      if (c.kind === "anthropic") {
        text = (json.content || []).map((p) => p.text || "").join("");
        usage = json.usage || null;
      } else if (c.kind === "google") {
        const cand = (json.candidates || [])[0];
        text = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("");
        usage = json.usageMetadata || null;
      } else {
        const choice = (json.choices || [])[0] || {};
        text = (choice.message && choice.message.content) || "";
        reasoningText = (choice.message && choice.message.reasoning_content) || ""; // deepseek-reasoner
        usage = json.usage || null;
      }
      if (opts.onReasoning && reasoningText) opts.onReasoning(reasoningText);
      if (opts.onDelta && text) opts.onDelta(text);
      return { text: text, reasoning: reasoningText, usage: usage, model: c.model, provider: c.provider };
    }

    await readSSE(
      res,
      (ev) => {
        if (ev.done) return;
        const j = ev.json || {};
        let delta = "";
        if (c.kind === "anthropic") {
          if (ev.event === "content_block_delta" && j.delta && j.delta.type === "text_delta") delta = j.delta.text || "";
          else if (j.type === "content_block_delta" && j.delta) delta = j.delta.text || "";
          if (j.usage) usage = j.usage;
        } else if (c.kind === "google") {
          const cand = (j.candidates || [])[0];
          delta = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("");
          if (j.usageMetadata) usage = j.usageMetadata;
        } else {
          const choice = (j.choices || [])[0];
          if (choice) {
            const d = choice.delta || {};
            if (d.reasoning_content) {
              reasoningText += d.reasoning_content;
              if (opts.onReasoning) opts.onReasoning(d.reasoning_content);
            }
            delta = d.content || "";
            if (!delta && choice.finish_reason && choice.message) delta = choice.message.content || "";
          }
          if (j.usage) usage = j.usage;
        }
        if (delta) {
          text += delta;
          opts.onDelta(delta);
        }
      },
      opts.signal
    );

    return { text: text, reasoning: reasoningText, usage: usage, model: c.model, provider: c.provider };
  }

  CP.llm = {
    PRESETS: PRESETS,
    resolve: resolve,
    chat: chat,
    chatTurn: chatTurn,
    parseEvent: parseEvent,
    parseActions: parseActions,
    parseArgs: parseArgs,
    stripActions: stripActions,
    flatten: flatten,
    normalizeToolCalls: normalizeToolCalls,
    supportsNativeTools: supportsNativeTools,
    isLocal: isLocal,
    isReasoningModel: isReasoningModel,
  };
})(typeof window !== "undefined" ? window : globalThis);
