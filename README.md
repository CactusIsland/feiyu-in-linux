# 大肥鱼 in Linux

把「大肥鱼」——一个住在 QQ 里的 AI 伙伴——完整跑在 Linux 服务器上的参考实现。

仓库包含：DSH（DeepSeek Harness）宿主插件、30+ 个可热加载的自定义模块、记忆分层、FTS5 消息检索、出站隐私守卫、抖音私信桥、面板、备份与守护脚本，以及一套经过 2C2G 小机器验证的部署配置。

> 这是脱敏后的开源版本：不含任何真实 QQ 号、群号、手机号、Cookie、API Key、面板密码、聊天记录、记忆、日记或服务器地址。所有私人字段都用 `YOUR_*` 占位。

## 它是什么

- **QQ 身份**：NapCat 提供 OneBot 11 网关，DSH 里的 Aurabot 插件把每个私聊/群映射成独立会话。
- **人格与表达**：人格卡 + 规则 + 运行时上下文 + 每轮记忆块；支持语音、表情包、图片、空间日记。
- **有自己的日子**：`purpose` 驱动力、心情、精力/饥饿、日记与自我叙事、主动搭话。
- **记忆分层**：热记忆、全量存档、冷记忆、压缩/遗忘、记忆图谱、线索召回、连续性纸条、可公开记忆。
- **消息检索**：`message-index` 用 SQLite FTS5 + `Intl.Segmenter` 预分词，按聊天作用域检索，不再全量解压会话。
- **安全边界**：dsh 降权运行、systemd 沙箱、出站 DLP、记忆作用域、面板 scrypt+HMAC、Caddy 只暴露 `/panel/*`。
- **外部世界**：联网搜索、链接阅读、梗百科、B 站学习、抖音接口模式（热榜/搜索/只读评论/豆包总结）。

> [!WARNING]
> **抖音模块默认关闭，仓库不含任何 Cookie 或登录态。** 不建议在服务器上登录抖音：自动化可能触发风控，已有 3 年封禁案例。开源版已移除评论/点赞/收藏/关注/自动召唤等写操作，只保留只读能力；确实要跑请用独立设备、独立小号、低频只读，风险自负。

## 架构

```text
QQ App
  │
  ▼
NapCat (QQ NT + OneBot 11)          127.0.0.1:3000 / 3001
  │
  ▼
DSH Web                             127.0.0.1:5043
  │  ▲
  │  └── Caddy :443  /panel/*  ──►  panel 模块 (scrypt + HMAC)
  ▼
dsh-aurabot-qq (宿主插件, MIT)      aurabot-src/
  │
  ├── 内置模块：memory / mood / purpose / diary / qzone / voice / stickers / douyin / ...
  │
  └── 自定义模块（modules/*，热加载）
        ├─ 记忆：memory-archive / cold / compact / map / orchestrator / scope
        │        cue-recall / continuity / first-meet / memory-share
        ├─ 检索：message-index (SQLite FTS5)
        ├─ 安全：outbound-guard / budget-guard / proactive-gate
        ├─ 工具：web-tools / link-reader / memewiki / bili-study / douyin
        └─ 运维：panel / dashboard / self-inspect / wallet / session-budget
  │
  ▼
$DSH_HOME/plugins-data/aurabot/       memories.json / chatlog / modules-data / sessions
```

完整说明见 [docs/architecture.md](docs/architecture.md)。

## 仓库结构

```text
aurabot-src/         上游 dsh-aurabot-qq 源码（MIT，保留原 LICENSE）
modules/             自定义模块，可直接放进 $DSH_HOME/plugins-data/aurabot/modules/
bridges/dy-im/       抖音私信桥（douyin-im，纯 Node）
conf/                systemd / Caddy / logrotate / SSH / 守护与备份脚本
  config.example.json
docs/                架构、部署、记忆、安全、抖音、模块清单
personas/            脱敏后的人格示例
```

## 快速开始

1. **准备机器**：Ubuntu 24.04，2C2G 起步；Node.js 24；一个 QQ 小号。
2. **安装 DSH**：按 DeepSeek Harness 的方式安装 `dsh`，准备 `DSH_HOME`（示例用 `/var/lib/dsh`）。
3. **安装宿主插件**：把 `aurabot-src/` 放进 DSH 的 web profile 的 `node_modules/dsh-aurabot-qq`（或按上游 README 安装 1.1.24）。
4. **放自定义模块**：`modules/*` → `$DSH_HOME/plugins-data/aurabot/modules/`；不要带 `.aurabot-cache`。
5. **生成配置**：复制 `conf/config.example.json`，把 `YOUR_*` 换成自己的值，放到 `$DSH_HOME/plugins-data/aurabot/config.json`，权限 `640`。
6. **接入 QQ**：NapCat + OneBot 11；把 HTTP/WS 地址指到 `127.0.0.1:3000/3001`。
7. **装服务**：参考 `conf/systemd/`；DSH 用专用用户 `dsh`，加沙箱；NapCat 单独服务。
8. **面板**：Caddy 反代 `/panel/*` 到 `127.0.0.1:5043`，首次访问 `/panel/ui` 设置账号密码。
9. **守护与备份**：`conf/scripts/guard.sh` + `backup.sh`，配 `fish-guard.timer` / `fish-backup.timer`。

详细步骤见 [docs/deployment.md](docs/deployment.md)。

## 安全与隐私

- 仓库只包含代码和脱敏配置，不含运行数据。
- `config.example.json` 里所有账号、令牌、Cookie、密钥都是空值或 `YOUR_*`。
- 建议：SSH 仅密钥、`PermitRootLogin no`、UFW 只开 22/443、DSH 只监听回环、面板独立鉴权、备份 700/600、定期异地备份。
- 记忆默认按聊天隔离；群聊和非主人私聊不会召回主人私聊内容；「永不遗忘」采用 fail-closed。
- 出站前统一过 `outbound-guard`：密钥、路径、主人私聊原话命中就改写或拦截。

安全模型与已知限制见 [docs/security.md](docs/security.md)。

## 文档

- [架构](docs/architecture.md)
- [部署](docs/deployment.md)
- [记忆系统](docs/memory.md)
- [安全模型](docs/security.md)
- [抖音模块与私信桥](docs/douyin.md)
- [模块清单](docs/modules.md)

## 许可

本仓库原创代码使用 MIT，见 [LICENSE](LICENSE)。`aurabot-src/`、`dy-cli`、`douyin-im` 等第三方组件的许可见 [NOTICE.md](NOTICE.md)。
