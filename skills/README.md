# Skills 技能系统

本目录包含应用运行时需要的skill资源，包括去 AI 味技能、写作技能和 SkillHub 资源。

## 目录结构

```
skills/
├── SkillHub/
├── good-writing/
├── qmai-mcp/
└── de-ai-writing/          # 去AI味skill参考文档
    └── references/
        ├── ai-trace-index.md       # AI痕迹轻量索引
        ├── ai-trace-detector.md    # 24项AI痕迹检测详解
        └── translation-guardrails.md # 翻译护栏规则
```

## 去AI味skill（de-ai-writing/）

通用去AI味技能的参考文档，供深入了解去AI味规则使用。

### 核心文件

- **ai-trace-index.md** - AI痕迹Top 5-10优先清单
- **ai-trace-detector.md** - 24项AI痕迹检测详解（词汇层、句式层、叙事层、逻辑层、风格层）
- **translation-guardrails.md** - 翻译任务的结构保真规则

### 去AI味规则使用

应用使用 `de-ai-skill.md`（项目根目录）作为默认去AI味规则。用户可通过以下方式自定义：

1. 在项目根目录创建 `de-ai-skill.txt`
2. 写入自定义规则
3. 系统会优先使用自定义规则

详见：[去AI味升级说明.md](../去AI味升级说明.md)
