/**
 * 自检：把「读图谱 / 检索 / 写回块 / 模型连通」四条链路逐项跑一遍，出一份 Markdown 报告。
 * 目的不是测模型智商，而是测「插件有没有接错线」——写回位置对不对、DataScript 通不通、Key 有没有效。
 */
(function (global) {
  const CP = (global.CP = global.CP || {});

  function ms(t) {
    return Math.max(1, Math.round(Date.now() - t)) + " ms";
  }

  function errText(e) {
    return String((e && (e.message || e)) || "未知错误").slice(0, 160);
  }

  async function check(name, fn) {
    const started = Date.now();
    try {
      const detail = await fn();
      return { name: name, ok: true, detail: detail || "", ms: Date.now() - started };
    } catch (e) {
      return { name: name, ok: false, detail: errText(e), ms: Date.now() - started };
    }
  }

  function icon(ok, skipped) {
    return skipped ? "⚠️" : ok ? "✅" : "❌";
  }

  async function run() {
    const ls = global.logseq;
    const settings = ls.settings || {};
    const results = [];
    const advice = [];

    // 0. 配置
    let cfg = null;
    results.push(
      await check("配置", async () => {
        cfg = CP.llm.resolve();
        if (!cfg.baseUrl) throw new Error("没有 baseUrl");
        const key = cfg.apiKey ? "Key 已填" : CP.llm.isLocal(cfg.baseUrl) ? "本地模型，无需 Key" : "缺少 API Key";
        return cfg.provider + " · " + cfg.model + " · " + key;
      })
    );
    if (!results[0].ok) advice.push("去 设置 → 插件 → Logseq Akyuu 填好供应商和 API Key。");

    // 1. 当前页面
    const page = await check("当前页面", async () => {
      const p = await ls.Editor.getCurrentPage();
      if (!p || !p.name) throw new Error("没有打开的页面（试试点开一篇笔记再跑）");
      return p.name;
    });
    results.push(page);

    // 2. 当前块
    results.push(
      await check("当前块", async () => {
        const b = await ls.Editor.getCurrentBlock();
        if (!b || !b.uuid) throw new Error("光标不在块里");
        const text = CP.ctx.cleanContent(b.content || "").slice(0, 40);
        return (text || "(空块)") + " …";
      })
    );

    // 3. 图谱查询
    let blockCount = 0;
    let caps = null;
    results.push(
      await check("图谱查询", async () => {
        const t = Date.now();
        const rows = await ls.DB.datascriptQuery("[:find (count ?b) :where [?b :block/uuid]]");
        blockCount = Number((rows && rows[0] && rows[0][0]) || 0);
        if (!blockCount) throw new Error("查询返回 0 个块");
        caps = CP.retrieval && CP.retrieval.capabilities ? await CP.retrieval.capabilities(true) : null;
        const kind = caps
          ? (caps.graph === "db" ? "DB 版图谱" : "文件版图谱") +
            " · 正文键 :block/" +
            caps.content +
            "（content " +
            caps.contentBlocks +
            " / title " +
            caps.titleBlocks +
            "）"
          : "";
        return blockCount.toLocaleString() + " 个块 · " + ms(t) + (kind ? " · " + kind : "");
      })
    );
    if (!results[3].ok) advice.push("DataScript 查询失败：新版 DB 图谱接口可能不同，检索会退化为只用当前页面。");

    // 4. 检索链路（含查询扩展，可能失败则退回本地切词，但不是硬错误）
    let retrieval = null;
    results.push(
      await check("检索", async () => {
        const q = page.ok ? page.detail : "test";
        const t = Date.now();
        retrieval = await CP.retrieval.retrieve(String(q), { maxK: 6, currentPage: page.ok ? page.detail : "" });
        const docs = retrieval.docs || [];
        if (!docs.length) {
          const d = CP.retrieval.diag ? CP.retrieval.diag() : null;
          const why = d && d.lastError ? "查询报错：" + d.lastError : "没有召回任何块（图谱可能太小，或关键词太泛）";
          throw new Error(why + (caps ? "｜正文键 :block/" + caps.content : ""));
        }
        return (
          "命中 " + docs.length + " 块 · " + ms(t) + " · 候选 " + retrieval.stats.candidates +
          " · 扩展=" + (retrieval.stats.source || "?") + (caps ? " · 键 :block/" + caps.content : "")
        );
      })
    );

    // 5. 写入链路：建临时页面 → 插块 → 改块 → 删页
    const tmpName = "Akyuu 自检 " + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    results.push(
      await check("写入（建页→插块→改块→删页）", async () => {
        await ls.Editor.createPage(tmpName, {}, { createFirstBlock: false });
        const b = await ls.Editor.appendBlockInPage(tmpName, "akyuu-selfcheck-1");
        if (!b || !b.uuid) throw new Error("插块没有返回 uuid");
        await ls.Editor.updateBlock(b.uuid, "akyuu-selfcheck-2");
        let back = await ls.Editor.getBlock(b.uuid);
        const readBack = () => !!(back && String(back.content || "").indexOf("akyuu-selfcheck-2") >= 0);
        if (!readBack()) {
          // DB 图谱可能有一拍延迟，等一下再判
          await new Promise((r) => setTimeout(r, 300));
          back = await ls.Editor.getBlock(b.uuid);
        }
        const ok = readBack();
        // deletePage 从不抛错（错误只在宿主里 console.error），所以删完要再查一次
        let cleaned = "已删除测试页（在 Recycle 里可找回）";
        try {
          await ls.Editor.deletePage(tmpName);
          const still = await ls.Editor.getPage(tmpName);
          if (still) cleaned = "测试页仍在，请手动删「" + tmpName + "」";
        } catch (e) {
          cleaned = "测试页未删除，请手动删「" + tmpName + "」";
        }
        if (!ok) throw new Error("改块后读回来的内容不对（" + cleaned + "）");
        return "插入+更新成功 · " + cleaned;
      })
    );
    if (!results[4].ok) advice.push("写入失败：检查是否有页面重名冲突，或当前图谱是只读的。");

    // 6. 模型连通（分答案与耗时）
    results.push(
      await check("模型连通", async () => {
        if (!cfg || (!cfg.apiKey && !CP.llm.isLocal(cfg.baseUrl))) throw new Error("跳过：没有可用 Key");
        const t = Date.now();
        const res = await CP.llm.chat({
          messages: [{ role: "user", content: "只回复两个字母：OK" }],
          maxTokens: 16,
          temperature: 0,
        });
        const text = String((res && res.text) || "").trim();
        if (!text) throw new Error("模型返回空内容");
        return cfg.model + " · " + (Date.now() - t) + " ms · 回复「" + text.slice(0, 20) + "」";
      })
    );
    if (!results[5].ok && results[5].detail.indexOf("跳过") !== 0) {
      advice.push("模型不通：看报错里的 HTTP 状态（401=Key 错，404=模型名/地址错，Failed to fetch=网络或 CORS）。");
    }

    // 7. 工具链：AI 真正改笔记走的就是这条路
    const tmpTool = "Akyuu 工具自检 " + new Date().toISOString().slice(11, 19).replace(/:/g, "-");
    results.push(
      await check("工具链（建页→插块→追加→读回→删页）", async () => {
        if (!CP.tools) throw new Error("工具模块没加载");
        const created = await CP.tools.run("create_page", { name: tmpTool, blocks: ["一级块", "  子块"] });
        if (!created.ok) throw new Error("create_page：" + created.message);
        const appended = await CP.tools.run("append_blocks", { page: tmpTool, blocks: ["二级块"] });
        if (!appended.ok) throw new Error("append_blocks：" + appended.message);
        const read = await CP.tools.run("read_page", { page: tmpTool });
        const hasChild = /子块/.test(read.message);
        let cleaned = "已删除测试页（在 Recycle 里可找回）";
        try {
          await ls.Editor.deletePage(tmpTool);
          const still = await ls.Editor.getPage(tmpTool);
          if (still) cleaned = "测试页仍在，请手动删「" + tmpTool + "」";
        } catch (e) {
          cleaned = "测试页未删除，请手动删「" + tmpTool + "」";
        }
        if (!hasChild) throw new Error("读回的页面里没有子块（缩进写入失效）· " + cleaned);
        return CP.tools.all().length + " 个工具 · 写读一致 · " + cleaned;
      })
    );
    if (!results[results.length - 1].ok) {
      advice.push("工具链失败：多半是 Logseq 版本对 insertBlock 的 {sibling} 支持不同，或测试页名冲突。");
    }

    // 8. 工作区：会话有没有真的落到图谱目录
    results.push(
      await check("工作区（会话存→列→读→删）", async () => {
        if (!CP.ws) throw new Error("工作区模块没加载");
        const id = "selfcheck-" + Date.now();
        const saved = await CP.ws.saveSession({
          id: id,
          title: "Akyuu 自检会话",
          messages: [
            { role: "user", content: "ping" },
            { role: "assistant", content: "pong" },
          ],
        });
        if (!saved || !saved.ok) throw new Error("会话文件写入失败（已回退到浏览器本地存储）");
        const list = await CP.ws.listSessions();
        if (!list.some((s) => String(s.id) === id)) throw new Error("索引里找不到刚写的会话");
        const back = await CP.ws.loadSession(id);
        await CP.ws.removeSession(id);
        if (!back || !back.messages.length) throw new Error("读回的会话是空的");
        const f = await CP.ws.folder();
        return f.graph + " · " + f.label + " · " + (f.dir || f.files);
      })
    );
    if (!results[results.length - 1].ok) {
      advice.push("会话没落盘：这个 Logseq 版本的插件文件存储不可用，已退回浏览器本地存储（换机器会丢）。");
    }

    // 9. 主题跟随：白天/暗夜 + 宿主色板有没有读进来
    results.push(
      await check("主题跟随", async () => {
        const t = CP.panel && CP.panel.themeInfo ? CP.panel.themeInfo() : null;
        if (!t) throw new Error("面板没有暴露主题信息");
        const src = t.source === "host" ? "已读到宿主色板" : "宿主色板读不到，用内置配色";
        return (t.mode === "dark" ? "暗夜" : "白天") + " · " + src + (t.accent ? " · 强调色 " + t.accent : "");
      })
    );

    // 汇总
    const failed = results.filter((r) => !r.ok && r.detail.indexOf("跳过") !== 0);
    const skipped = results.filter((r) => !r.ok && r.detail.indexOf("跳过") === 0);
    const lines = [];
    lines.push("### Akyuu 自检报告");
    lines.push("");
    lines.push("生成时间：" + new Date().toLocaleString());
    lines.push("");
    lines.push("| 检查项 | 结果 | 详情 | 耗时 |");
    lines.push("| --- | --- | --- | --- |");
    results.forEach((r) => {
      const skippedRow = !r.ok && r.detail.indexOf("跳过") === 0;
      lines.push("| " + r.name + " | " + icon(r.ok, skippedRow) + " | " + r.detail.replace(/\|/g, "\\|") + " | " + r.ms + " ms |");
    });
    lines.push("");
    if (!failed.length && !skipped.length) {
      lines.push("**结论：全部通过。** 读上下文、检索、写回块、模型连通都正常。");
      lines.push("");
      lines.push("建议下一步手工验证语义质量：在测试页里问一个只有某条笔记才知道的细节，看它能不能经检索答对。");
    } else if (failed.length) {
      lines.push("**结论：" + failed.length + " 项失败。**");
      failed.forEach((f) => lines.push("- " + f.name + "：" + f.detail));
    } else {
      lines.push("**结论：连通没问题，但有检查被跳过。**");
      skipped.forEach((f) => lines.push("- " + f.name + "：" + f.detail));
    }
    if (advice.length) {
      lines.push("");
      lines.push("**处理建议**");
      advice.forEach((a) => lines.push("- " + a));
    }
    lines.push("");
    lines.push("> 自检只验证链路，不验证答案质量。块数 " + blockCount.toLocaleString() + "。");

    const report = lines.join("\n");
    if (CP.panel && CP.panel.showReport) CP.panel.showReport(report);
    return { report: report, results: results, ok: !failed.length };
  }

  CP.selfcheck = { run: run };
})(typeof window !== "undefined" ? window : globalThis);
