# 模块清单

`modules/` 下是可直接放进 `$DSH_HOME/plugins-data/aurabot/modules/` 的自定义模块（Aurabot 扩展接口 v1）。除特别说明外，敏感工具只对主人私聊（`level === 'full'`）挂载。

## 对话与人格

| 模块 | 作用 |
|---|---|
| `persona-switch` | 人格快捷切换 |
| `proactive-gate` | 主动找你时先判断旧事该不该提；事实/猜想分开 |
| `shared-context` | 跨聊天近期上下文；群聊只看群，别人私聊不串 |
| `continuity` | 跨天/跨重置的连续性纸条 |
| `first-meet` | 初次相遇锚点与最初 30 天 |
| `capability-notice` | 新能力通告：写进记忆、可选推进会话/通知主人 |
| `budget-guard` | 请求前按优先级裁剪记忆/摘要块 |
| `life-state` | 精力、饥饿、睡觉/喂食状态 |
| `world` | 每日回顾、日记、自我叙事、翻旧账 |
| `dashboard` | 面板总览页 |

## 记忆

| 模块 | 作用 |
|---|---|
| `memory-archive` | 全量原文存档，按月分片，append-only |
| `memory-cold` | 冷记忆库、线索召回、对账兜底 |
| `memory-compact` | 合并压缩、遗忘曲线、淡化/遗忘 |
| `memory-map` | 人物/关系/承诺/偏好图谱，never/slow/normal/fast |
| `memory-orchestrator` | 统一召回、去重、字段补齐、审计工具 |
| `memory-scope` | 群聊/别人私聊只召回本聊天记忆 |
| `memory-share` | 主人挑“可以公开说”的记忆给群聊/抖音 |
| `cue-recall` | 对方明确提旧事时才查冷库/存档 |

## 检索与知识

| 模块 | 作用 |
|---|---|
| `message-index` | SQLite FTS5 + Intl.Segmenter 消息索引，按 chatId 作用域检索 |
| `memewiki` | 6792 条本地梗百科 + 群内自定义黑话 |
| `hot-topics` | 百度/B站/抖音热榜，定时刷新 |
| `link-reader` | 链接内容阅读（含 SSRF 防护） |
| `forward-reader` | 合并转发聊天记录展开 |
| `web-tools` | 联网搜索：千问检索 + 缓存 + 预算 + 去重 + 不可信内容隔离 |
| `bili-study` | B 站搜索、读简介/热评、写学习笔记（知识库） |

## 声音、表情、图片

| 模块 | 作用 |
|---|---|
| `tts-doubao` | 豆包语音合成，变调/语速/音量参数 |
| `image-studio` | 画图工坊：生图、画廊、额度、成本 |
| `wallet` | 生图/模型余额记账与低余额提醒 |

## 群聊、白名单与权限

| 模块 | 作用 |
|---|---|
| `allow-manager` | 用自然语言改白名单（“可以和某某聊”“只和我聊”） |
| `auto-allow` | 自动把好友/群写进白名单；默认关闭，避免陌生人自动获得回应 |
| `outbound-guard` | 出站 DLP：密钥、路径、主人私聊原话 |
| `session-budget` | 会话 token 监控与轮转（先留纸条再重置） |
| `self-inspect` | 让她查自己的状态、余额、记忆、日志（仅主人） |

## 外部平台

| 模块 | 作用 |
|---|---|
| `douyin` | 抖音接口模式：热榜/搜索/评论/豆包总结 + 私信 `/dm`；写操作仅主人 |
| `bili-study` | B 站学习，见上 |

## 运维

| 模块 | 作用 |
|---|---|
| `panel` | 状态面板：登录、总览、会话、记忆、日志、画图、钱包 |
| `dashboard` | 面板总览页（旧版/独立页） |
| `self-inspect` | 后台自检与上下文统计 |
| `wallet` | 余额与成本 |
| `capability-notice` | 能力变更留痕 |

## 模块开发约定

- 一个目录一个模块，入口 `index.mjs`，默认导出 `{ id, name, version, api: 1, defaults, settings, setup }`。
- `setup(api)` 里注册 `tool/context/rule/command/route/on`，返回的对象可被 `api.use(id)` 使用。
- 任何会写外部平台、读隐私、执行命令的工具，都必须按 `where.level` 只给主人。
- 失败要 fail-closed：拿不到权限/映射/配置时，宁可不做，也不要放全量数据过去。
- 数据写到 `api.dataDir()`（即 `modules-data/<id>/`），不要写模块源码目录。
- 不要依赖模块加载顺序；需要协作时用显式事件或 `api.use` 取导出。
- 提交前跑 `node --check <file>`；不要提交 `.aurabot-cache/`、日志、数据库或真实配置。
