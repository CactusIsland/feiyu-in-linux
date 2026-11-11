# 记忆系统

目标：记得住、想得起、会淡忘，但不把别人的隐私串进来，也不把「永不遗忘」弄丢。

## 1. 数据布局

```text
$DSH_HOME/plugins-data/aurabot/
├── memories.json                    热记忆（内置 memory 模块）
├── chatlog/YYYY-MM-DD.jsonl         当天聊天流水（会被定期整理）
├── modules-data/
│   ├── memory-archive/YYYY-MM.jsonl 全量原文存档（append-only）
│   ├── memory-cold/cold-memories.jsonl
│   ├── memory-cold/cold-state.json
│   ├── memory-compact/removed.jsonl 被遗忘的原文
│   ├── memory-map/memory-map.json
│   ├── memory-map/overrides.json
│   └── memory-share/share.json      可公开记忆 id
└── sessions/                        DSH 会话（message-index 的索引源）
```

## 2. 分层

### 热记忆（内置 `memory`）

- `memories.json` 是对象：`items[]`、`profiles`、`insights`、`styles` 等。
- 每条记忆有 `id/text/about/aboutName/tags/importance/source/chatId/at/hits/hitDays/lastHit`。
- 每日整理会把 `auto` 且重要度低的旧条目合并/删除；这是内置行为，自定义模块只能在外围兜底。

### 全量存档（`memory-archive`）

- 收到/发出的每条消息都写 `YYYY-MM.jsonl`，append-only，不删不改。
- 搜索是关键词/二字词打分；适合“想不起细节时翻旧账”，不适合高频全库扫描。
- 可用 `/存档 导入` 把旧 `chatlog` 补进来。

### 冷记忆（`memory-cold`）

- 热库里越来越淡的条目先冷存，再从热库移走；`removed.jsonl` 留原文。
- 对账：内置整理把某条删了，但快照里还有，就补写进冷库。
- 支持结构化线索：年份、月份、地点、人物、来源，多候选时先反问用户。

### 压缩与遗忘（`memory-compact`）

- 每几小时把同一人/同一代的旧记忆合并压缩，长度按比例缩短。
- 遗忘曲线 `R = e^(-Δ天 / τ)`；`τ` 随重要度和被想起次数变长。
- `R < forgetBelow` 才真忘；原文进 `removed.jsonl`。
- 面板/导入来源默认不参与遗忘。

### 记忆图谱（`memory-map`）

- 人物节点、关系边、约定、偏好、最近事件、快忘记。
- 权重：`never / slow / normal / fast`。
- `never` 的判定：
  - 手动 pin id
  - 面板/导入来源
  - 关于主人且重要度 ≥ 0.8
  - 文本含“第一次/约定/答应/发誓/不要忘”等
- `isProtected(id)` 在模块缺失或异常时返回 `true`（fail-closed）。

### 编排与作用域（`memory-orchestrator` / `memory-scope`）

- `memory-orchestrator` 补齐字段（type/confidence/scope/protected），提供 `memory_recall` / `memory_audit`，只读/补齐 `memories.json`。
- `memory-scope` 在群聊/别人私聊里替换内置全库召回：
  - 主人私聊：全库
  - 群聊：本群 + 她的公开经历
  - 别人私聊：本私聊 + 她的公开经历
- 识别/替换失败时剔除记忆块，绝不放全库过去。

### 线索召回（`cue-recall`）

- 只有出现“还记得/上次/以前/那年/答应过”等明确线索才查冷库和存档。
- 群聊只查本群，私聊只查本私聊，主人私聊才可查全部。
- 找不到就说记不清，不编；多候选先反问。

### 连续性与初次相遇（`continuity` / `first-meet`）

- `continuity` 每 15 分钟看最近聊天，写一张 200 字以内的第一人称纸条：心情、没聊完的事、细节、下次怎么接。
- `first-meet` 保存初次相遇锚点和最初 30 天的片段。
- 都按聊天隔离，不跨聊天注入。

### 可公开记忆（`memory-share`）

- 主人可以挑少量记忆设为“可以公开说”，群聊/抖音只看到这部分。
- 未列入的仍然只在主人私聊可见。

## 3. 召回路径

1. 用户消息进来，`memory` 内置模块先做全库相关记忆召回（主人私聊安全）。
2. `memory-scope` 在非主人聊天里把这段替换成本聊天可见记忆。
3. `cue-recall` 检测到旧事线索时，追加冷库/存档片段。
4. `continuity` 注入当前聊天的纸条。
5. `budget-guard` 按优先级裁剪，避免上下文虚胖。
6. `outbound-guard` 在发送前防止记忆原文/路径/密钥泄露。

## 4. 永不遗忘

三层保护：

1. `memory-map` 判定 `never`，并把 auto 条目重要度抬到 0.6。
2. `memory-compact` 在压缩、淡化、遗忘前都调用 `mapProtected`；模块没开/异常 → 全保护。
3. 内置每日整理只跳过 `source != auto` 或重要度 ≥ 0.6 的条目；抬重要度后才能真的挡住。

## 5. 配置建议

```json
{
  "memory": { "enabled": true, "recallCount": 6, "dailyConsolidate": true },
  "ext": {
    "memory-archive": { "enabled": true, "searchMonths": 12, "maxSearchResults": 8 },
    "memory-cold": { "enabled": true, "coldBelow": 0.18, "coldAfterDays": 30 },
    "memory-compact": { "enabled": true, "countCap": 100, "countTarget": 50, "forgetEnabled": true },
    "memory-map": { "enabled": true, "ownerNeverForget": true, "protectPanelImport": true },
    "memory-scope": { "enabled": true, "maxItems": 4, "maxChars": 300 },
    "cue-recall": { "enabled": true, "maxItems": 3, "maxChars": 480 },
    "memory-orchestrator": { "recallLimit": 6 },
    "memory-share": { "enabled": true, "injectLimit": 3 }
  }
}
```

## 6. 已知限制

- 中文召回目前是二字词 + 子串打分，同义/转述召回弱；2C2G 上不建议上本地 embedding，4G 后再考虑。
- `memory-archive` 搜索是全量线性扫描，数据量大后要用 `message-index` 的 FTS5 或给存档建索引。
- 多模块召回有重叠，`budget-guard` 会裁剪，但优先级是显式配置的；调参时看日志里的“丢掉 X 块”。
- `memory-scope`/`budget-guard` 仍依赖提示词块的文本特征；更稳的做法是给 prompt item 加结构化 `kind/priority` 元数据（roadmap）。
