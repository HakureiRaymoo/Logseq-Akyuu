# Changelog

版本号跟 `package.json` 走。0.1.x / 0.2.0 是开发过程中的内部迭代，下面合并记录；0.2.1 起对外发布。

## 0.2.1 — 首次公开发布

### 新增

- **工具调用**：17 个 Logseq 操作（读 4 / 写 13）——`list_pages`、`read_page`、`get_block`、`search_graph`、`create_page`、`insert_block`、`append_blocks`、`update_block`、`add_tags`、`set_todo`、`move_block`、`set_page_property`、`remove_page_property`、`move_page_blocks`、`delete_page`、`restore_page`、`delete_block`
- **确认卡片**：写操作先预览再执行，删除类强制确认；勾选「本会话内不再询问这类操作」可减少打扰
- **双协议**：OpenAI 兼容接口走原生 function calling；`deepseek-reasoner` / Anthropic / Gemini 走 ```` ```akyuu ```` 文本协议
- **工作区**：会话写入 `<图谱>/assets/storages/logseq-akyuu/sessions/`，每段两份（`.json` 给插件、`.md` 给人读），面板内 🕘 可切换/删除
- **检索诊断**：`Akyuu: 检索诊断（图谱查询）` 输出图谱类型、正文键、回收站页面数、命中数与报错
- **主题跟随**：跟随 Logseq 的白天/暗夜与主题色（`--ls-*` 变量），读不到时用内置亮/暗色板
- **工具轮数上限**可在设置里调（1~8），停手时提示发「继续」

### 修复

- **DB 版图谱检索恒为空**：DB 版块正文在 `:block/title` 而非 `:block/content`，改为自动探测字段；关键词从 `:in` 入参改为 EDN 字面量内联
- **已删除页面仍出现**：DB 版软删除只写 `:logseq.property/deleted-at`，而 `Editor.getAllPages()` 不过滤它，插件改为自行查询并排除（`list_pages` / 检索 / 上下文注入都不再出现回收站内容）
- **工具参数解析**：`arguments` 为对象、参数摊平在顶层、JSON 被截断——三种情况都能正确处理；参数不全时不再弹残废卡片，而是回喂错误让模型重试
- **短块被误杀**：召回的长度下限从 8 字符放宽到 2（中文短句不再被丢掉）
- **子块缩进写入**：`append_blocks` / `create_page` 按两个空格还原层级
- 页面属性写入、`move_page_blocks` 空页占位、`delete_page` 删除后校验等边界处理
