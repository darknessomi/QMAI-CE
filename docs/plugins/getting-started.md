# 开发第一个 QMAI 插件

本例用 Node.js 开发一个字符计数工具。先在终端验证它能返回正确结果，再把它安装到 QMAI，让支持工具调用的模型在对话中使用它。以下命令从 QMAI 源码仓库根目录执行，只需要 Node.js，无需安装项目依赖。

## 1. 生成插件

```sh
node sdk/create.mjs ./text-counter --template with-tools --name "字符计数"
```

目标目录应为新目录或空目录。脚手架会生成一个可以直接运行的插件，插件 ID 为 `text-counter`。开发时主要改两个文件。

| 文件 | 修改内容 |
| --- | --- |
| `text-counter/plugin.json` | 设置插件名称、版本和说明。在 `contributes.tools` 中声明工具名称、用途和参数。 |
| `text-counter/index.js` | 在 `tools.my_tool.handler(args, ctx)` 中实现工具。模板读取 `args.text`，返回字符数。调试日志用 `ctx.log()`，标准输出用于协议消息。 |

例如，要让工具只统计汉字，可以保留模板对 `args.text` 的类型检查，把处理函数最后的 `return` 改成下面这一行，并把清单和入口中的工具说明都改为「统计输入文本中的汉字数」。如果另取工具名，也要同步修改清单和入口。

```js
return `汉字数：${(args.text.match(/\p{Script=Han}/gu) ?? []).length}`;
```

## 2. 在终端验证

```sh
node sdk/validate.mjs ./text-counter
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"my_tool","arguments":{"text":"QMAI"}}}' | node ./text-counter/index.js
```

第一条命令应显示「校验通过」。第二条命令直接调用工具，无需配置模型。原模板返回的 JSON 中，`result.content[0].text` 应为 `字符数：4`。如果改成了汉字计数，可将输入换成 `青幕AI`，预期为 `汉字数：2`。

## 3. 在 QMAI 中验证

1. 打开「插件 → 添加插件 → 本地目录」，点「选择目录」，选中直接包含 `plugin.json` 的 `text-counter` 目录，然后点「安装」。
2. 在「已安装」列表启用「字符计数」。打开写作对话，选择已启用工具调用的模型，输入「请调用字符计数工具统计 QMAI」，核对工具调用记录和结果。仅提供 AI 工具的插件通过对话调用，插件页的「插件能力」区展示的是可点击的动作和内容包。
3. 本地安装会复制插件目录。修改源码后，先重复终端验证，再到「已安装」卸载旧副本、重新安装并启用，才能在应用里测到新代码。

## 4. 分享与其他插件类型

分享工具时，把 `plugin.json`、`index.js`、`qmai-plugin.mjs` 和 `package.json` 放在插件根目录。可以直接分享该目录，也可以放在独立的公开 GitHub 仓库，让用户在「添加插件」里输入仓库地址。宿主直接运行随插件提供的文件，使用 TypeScript 时请先构建并附上入口产物。

| 想开发的功能 | 从哪里开始 |
| --- | --- |
| 灵感素材、表单或提示词动作 | 将创建命令中的模板改为 `content-only` 并使用新的目录名。编辑 `content/items.json` 和清单中的 `contributes`。可参考[灵感生成器示例](../../samples/plugins/idea-generator/)。 |
| 给 AI 增加工具 | 查看[章节体检示例](../../samples/plugins/chapter-metrics/)如何声明工具并分析用户传入的正文。 |
| 接入新的模型来源 | 阅读[插件作者指南](authoring-guide.md)中的 Provider 章节，并参照 [SDK 文档](../../sdk/README.md)实现模型列表、鉴权和流式响应。 |
