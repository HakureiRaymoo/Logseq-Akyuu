/**
 * 极简 Markdown 渲染器（无依赖、纯字符串，可在 Node 里直接测试）。
 * 支持：代码块、标题、引用、有序/无序/任务列表、分隔线、表格外的常见行内语法。
 */
(function (global) {
  const CP = (global.CP = global.CP || {});

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
  }

  function inline(text) {
    const codes = [];
    // 行内代码先挖出来，避免被后续规则破坏
    let s = text.replace(/`([^`\n]+)`/g, (_, code) => {
      codes.push(code);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });

    s = escapeHtml(s);

    // 链接 [text](url)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
    });

    // 粗体 / 斜体 / 删除线
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

    // 还原行内代码
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + escapeHtml(codes[Number(i)]) + "</code>");
    return s;
  }

  function renderList(lines) {
    // lines: [{indent, ordered, text}]
    let html = "";
    const stack = []; // {indent, tag}

    lines.forEach((item) => {
      const tag = item.ordered ? "ol" : "ul";
      while (stack.length && item.indent < stack[stack.length - 1].indent) {
        html += "</li></" + stack.pop().tag + ">";
      }
      if (!stack.length || item.indent > stack[stack.length - 1].indent) {
        stack.push({ indent: item.indent, tag: tag });
        html += "<" + tag + ">";
      } else if (stack[stack.length - 1].tag !== tag) {
        html += "</li></" + stack.pop().tag + "><" + tag + ">";
        stack.push({ indent: item.indent, tag: tag });
      } else {
        html += "</li>";
      }

      let body = inline(item.text);
      if (/^\[[ xX]\]\s+/.test(item.text)) {
        const checked = /^\[[xX]\]/.test(item.text);
        body = inline(item.text.replace(/^\[[ xX]\]\s+/, ""));
        body =
          '<span class="cp-task' + (checked ? " done" : "") + '">' +
          (checked ? "☑" : "☐") +
          "</span> " +
          body;
      }
      html += "<li>" + body;
    });

    while (stack.length) html += "</li></" + stack.pop().tag + ">";
    return html;
  }

  function render(source) {
    const text = String(source == null ? "" : source).replace(/\r\n?/g, "\n");
    const lines = text.split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 代码块
      const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/);
      if (fence) {
        const marker = fence[1][0];
        const lang = fence[2] || "";
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp("^\\s*" + marker + "{3,}\\s*$").test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // 跳过结束围栏
        out.push(
          '<div class="cp-code"><div class="cp-code-head"><span>' +
            escapeHtml(lang || "text") +
            '</span><button class="cp-copy" data-copy-code="1" title="复制代码">复制</button></div><pre><code>' +
            escapeHtml(buf.join("\n")) +
            "</code></pre></div>"
        );
        continue;
      }

      // 空行
      if (!line.trim()) {
        i++;
        continue;
      }

      // 分隔线
      if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && /^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
        out.push("<hr/>");
        i++;
        continue;
      }

      // 标题
      const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = Math.min(heading[1].length + 2, 6); // 面板里不需要 h1 那么大
        out.push("<h" + level + ">" + inline(heading[2].trim()) + "</h" + level + ">");
        i++;
        continue;
      }

      // 引用
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        out.push("<blockquote>" + render(buf.join("\n")) + "</blockquote>");
        continue;
      }

      // 列表（含嵌套）
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
          const m = lines[i].match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);
          items.push({
            indent: Math.floor((m[1] || "").replace(/\t/g, "  ").length / 2),
            ordered: !!m[3],
            text: m[4],
          });
          i++;
        }
        out.push(renderList(items));
        continue;
      }

      // 段落
      const buf = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*(```+|~~~+)/.test(lines[i]) &&
        !/^\s*(#{1,6})\s+/.test(lines[i]) &&
        !/^\s*>/.test(lines[i]) &&
        !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push("<p>" + inline(buf.join("\n").replace(/\n/g, "<br/>")) + "</p>");
    }

    return out.join("\n");
  }

  CP.md = { render: render, escapeHtml: escapeHtml, inline: inline };
})(typeof window !== "undefined" ? window : globalThis);
