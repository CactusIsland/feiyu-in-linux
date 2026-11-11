# 架构

## 1. 进程与网络拓扑

```text
QQ App
  │  腾讯 IM 协议
  ▼
NapCat (QQ NT, Xvfb)                   root, 127.0.0.1:3000 (HTTP) / 3001 (WS) / 6099 (WebUI)
  │  OneBot 11
  ▼
DSH Web (dsh)                          dsh 用户, 127.0.0.1:5043
  │
  ├── dsh-aurabot-qq 宿主插件           aurabot-src/
  │     ├── chat/hub.js                 聊天中枢：会话、合并、工具、发送
  │     ├── persona/personas.js         人格与规则提示词变量
  │     ├── core/modules.js             模块加载、热重载、钩子
  │     └── features/*                  内置能力：memory / mood / qzone / voice ...
  │
  └── 自定义模块                         $DSH_HOME/plugins-data/aurabot/modules/
        └── 通过 api.tool/context/rule/route/on 扩展，不改宿主源码

Caddy                                  caddy 用户, :443
  └── /panel/*  →  127.0.0.1:5043/aurabot/api/ext/panel/*
```

只有 Caddy 的 443 对公网开放；DSH、NapCat、面板 admin API 都只监听回环。参考部署里还关闭了 Caddy admin API（`admin off`），SSH 仅密钥登录。

## 2. 一个 QQ 会话是怎么跑起来的

1. **入站**：NapCat 把消息推给 Aurabot 的 OneBot 客户端；`chat/inbound.js` 解析文本、图片、语音、引用、合并转发。
2. **准入**：`config.allow` 白名单 + `allow-manager` 模块；群聊还有唤醒词、冷却、每小时上限、静默时段、相关度门槛。
3. **合并**：`merge` 把短时间内的多条消息合成一轮，避免逐条回复。
4. **会话映射**：`chatId`（`private:<QQ>` / `group:<群号>`）映射到独立的 DSH session；会话过大时由 `session-budget` 提醒或轮转。
5. **上下文组装**：
   - 人格与规则通过 DSH 的 `systemPrompt.variable` 注入（`aurabot_persona`、`aurabot_rules_private/social`）。
   - 模块的 `api.context(fn)` 汇总成 `systemPrompt.context`（order 905），适合放“变化不频繁”的状态（心情、精力、连续性纸条等）。
   - 每轮消息前的 `prompt` 钩子负责动态块：相关记忆、线索召回、梗百科预查、跨聊天摘要、搜索结果等。
6. **调用模型**：每轮由 `hooks.model` 选择模型；支持按私聊/群覆盖，也可以在模块里做路由。
7. **回复解析**：文本按行拆成多条 QQ 消息；`<voice>`、`<sticker:...>`、`<face:...>`、`<at:...>`、`[沉默]` 等标记由 hub 解析。
8. **出站守卫**：`outbound-guard` 在 `send` 钩子上检查密钥、本机路径、主人私聊原话（群聊场景），命中就改写或拦截。
9. **发送与记录**：OneBot 发送；`chatlog` 写当天流水，`memory-archive` 写 append-only 月度存档。

## 3. 模块系统

自定义模块是一个 ESM 文件，默认导出：

```js
export default {
  id: 'example',
  name: '示例',
  version: '1.0.0',
  api: 1,
  defaults: { enabled: true },
  settings: [{ key: 'enabled', label: '开启', type: 'switch' }],
  setup(api) {
    api.tool((where) => where.level === 'full' ? [api.defineTool({ /* ... */ })] : [])
    api.context(({ chat }) => '')
    api.rule((kind) => kind === 'private' ? '...' : '')
    api.command({ name: '示例', desc: '...', run: async (arg) => '' })
    api.route('/state', async () => ({ ok: true }))
    api.on('message', (msg) => false)
  },
}
```

生命周期：

- 宿主启动时扫描 `modules/*/index.mjs`，按目录热加载；文件变化后重新加载，旧实例 dispose。
- `.aurabot-cache/` 保留最近 3 个版本，只用于热重载回滚，不属于源码。
- 模块可以覆盖内置模块（同 `id`，`useBuiltin: false`）；面板里能看到 `running: user/builtin`、版本和错误。
- 模块之间用 `api.use('模块 id')` 取导出，不要缓存实例（对方可能被替换）。
- 所有工具都按 `where.level` 收口：`full` = 主人私聊；群聊/别人私聊默认拿不到敏感工具。

## 4. 提示词分层

| 层 | 来源 | 变化频率 | 典型内容 |
|---|---|---|---|
| 人格 | `personas/*.md` | 手动 | 身份、性格、说话方式、底线 |
| 规则 | `rulesText()` + 模块 `api.rule` | 手动/模块 | QQ 输出格式、隐私边界、能力说明 |
| 运行时上下文 | `api.context`（order 905） | 每轮 | 心情、精力、连续性纸条、世界自述 |
| 每轮动态块 | `prompt` 钩子 | 每轮 | 相关记忆、线索召回、梗百科预查、跨聊天摘要 |
| 用户消息 | QQ 入站 | 每轮 | 带来源标注的原始消息 |

`budget-guard` 在请求前按优先级裁剪动态块（默认先丢跨聊天摘要，再丢连续性/线索，不丢内置记忆）。`memory-scope` 在群聊/别人私聊里把内置全库记忆替换为“本聊天可见”的记忆，失败时 fail-closed。

## 5. 记忆分层

| 模块 | 作用 | 存储 |
|---|---|---|
| 内置 `memory` | 热记忆、每日整理、人物小档案 | `memories.json` |
| `memory-archive` | 全量原文存档，按月分片，永不删除 | `modules-data/memory-archive/YYYY-MM.jsonl` |
| `memory-cold` | 淡出热库的记忆转冷存，按线索召回 | `cold-memories.jsonl` + `cold-state.json` |
| `memory-compact` | 合并压缩、按遗忘曲线淡化/遗忘 | 改写 `memories.json`，`removed.jsonl` 留底 |
| `memory-map` | 人物/关系/承诺/偏好图谱，输出 never/slow/normal/fast | `memory-map.json` |
| `memory-orchestrator` | 统一召回、去重、字段补齐（type/confidence/scope/protected） | 只读/补齐 `memories.json` |
| `memory-scope` | 群聊/别人私聊只召回本聊天记忆 | 运行时替换 prompt 块 |
| `cue-recall` | 对方明确提旧事时才查冷库/存档 | 运行时注入 |
| `continuity` | 跨天/跨重置的“纸条” | 按聊天存 JSON |
| `first-meet` | 初次相遇锚点、最初 30 天 | 按聊天存 JSON |
| `memory-share` | 主人挑出“可以公开说”的记忆，群聊/抖音可用 | `share.json` |

「永不遗忘」是三层保护：`memory-map` 的 never 判定 → `memory-compact` 跳过压缩/淡化/遗忘 → 内置每日整理前把 auto 条目重要度抬到 0.6。判定失败时默认保护（fail-closed）。

## 6. 消息索引

`message-index` 把 DSH 会话文件 `session.v4.jsonl.zstd` 增量索引进 SQLite：

- `messages` 存原文；`hash` 唯一去重。
- `messages_fts` 是 `content=''` 的 FTS5 表，只存预分词后的文本。
- 中文用 `Intl.Segmenter('zh', { granularity: 'word' })` 预分词，写入/查询同一套分词，避免把整句中文当一个 token。
- 搜索按 `chatId` 作用域：主人私聊全库，群聊只搜本群，别人私聊只搜本私聊；没有 `chatId` 的会话宁可不收。
- 跳过提示词脚手架、记忆前言、搜索结果等非聊天内容。

## 7. 面板与鉴权

- Caddy 只把 `/panel/*` 反代到 DSH；其他路径 404。
- `panel` 模块自己实现 scrypt 密码 + HMAC Cookie（HttpOnly、SameSite=Lax、TTL 7 天）。
- `auth.json` 只存 salt/hash，权限 600；失败 5 次锁 10 分钟。
- `/panel/data` 等接口未登录返回 401。

## 8. 资源与故障域

参考部署（2C2G）：

- `dsh-web`：`MemoryHigh=500M`、`MemoryMax=800M`、`CPUQuota=150%`、`OOMScoreAdjust=-500`。
- `napcat`：`MemoryHigh=900M`、`MemoryMax=1300M`、`CPUQuota=120%`、`OOMScoreAdjust=200`。
- `fish-guard.timer` 每 5 分钟检查服务、网关、内存、磁盘；异常通过 NapCat 私聊告警。
- `fish-backup.timer` 每日 04:30 备份数据、配置、SQLite 热备与 Caddy 证书，保留 7 份。

故障域：DSH/NapCat 各自 systemd 重启；Caddy 独立；面板与管理接口只在本机；备份与守护是独立的 systemd timer，不依赖 DSH 进程存活。
