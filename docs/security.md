# 安全模型

## 1. 资产

- QQ 机器人账号与好友/群关系
- 主人 QQ、微信、手机号、位置等现实身份信息
- 主人私聊内容、记忆、日记、图片、语音
- 模型 API Key、TTS Key、图床 Key、NapCat Token、面板密码哈希
- 服务器本身（DSH 拥有工具调用能力）

## 2. 威胁模型

| 威胁 | 入口 | 主要后果 |
|---|---|---|
| 陌生人/新群自动获得回应 | 加好友、拉群 | 成本、骚扰、提示词注入面 |
| 链接/搜索结果/抖音评论注入 | `web-tools`、`link-reader`、`douyin_watch` | 诱导模型调用工具、泄露信息 |
| 记忆串隐私 | 群聊/别人私聊召回全库 | 主人私聊内容外泄 |
| 回复泄露密钥/路径 | 模型复述上下文 | API Key、服务器路径外泄 |
| 日记公开外泄 | Qzone 可见范围 | 其他私聊内容被公开 |
| 服务器被拿下 | SSH/面板/依赖漏洞 | 全部数据与账号失守 |
| 数据丢失 | 磁盘故障/误删 | 记忆、会话、配置不可恢复 |
| 抖音风控/封号 | 高频搜索、评论、@豆包 | 账号受限 |

## 3. 控制

### 网络

- DSH 只监听 `127.0.0.1:5043`。
- NapCat HTTP/WS/WebUI 只监听 `127.0.0.1:3000/3001/6099`。
- Caddy 只暴露 `/panel/*`，其他路径 404；`admin off`。
- UFW 默认拒绝，只开 22/443；不要开 3000/3001/5043/6099/2019。
- 面板可继续收紧为 WireGuard/Tailscale 内网访问，或只允许固定来源 IP。

### 身份

- SSH 仅公钥：`PasswordAuthentication no`、`PermitRootLogin no`、`AllowUsers ubuntu`、`X11Forwarding no`。
- fail2ban 监控 SSH。
- 面板使用 scrypt 密码哈希 + HMAC Cookie（HttpOnly、SameSite=Lax、7 天 TTL），失败 5 次锁 10 分钟。
- 所有工具按 `where.level` 收口：`full` = 主人私聊；群聊/别人私聊默认拿不到敏感工具。

### 进程

`dsh-web.service` 参考配置：

```ini
User=dsh
Group=dsh
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/dsh /opt/fish/media /tmp
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
MemoryHigh=500M
MemoryMax=800M
CPUQuota=150%
```

- `DSH_HOME=/var/lib/dsh`，不要用 `/root/.dsh`。
- NapCat 仍以 root 运行（QQ NT 限制）；用回环监听 + 防火墙 + 独立服务隔离，长期可考虑容器/单独用户方案。
- 不要给群聊/别人私聊挂 bash/fs 等宿主工具。

### 应用

- 白名单默认关闭自动放行：`auto-allow.enabled=false`，新好友/新群需主人确认。
- 危险命令确认：`security.dangerConfirm=true`。
- `outbound-guard`：发送前拦 `sk-*`、`Bearer`、`*_API_KEY=...`、`/root/.dsh`、`/etc/caddy|dsh|systemd`、Windows 盘符、`base64://` 大块、主人 QQ、主人私聊原话（群聊场景）。
- `memory-scope`：群聊/别人私聊只召回本聊天记忆，失败 fail-closed。
- `bili-study` / `tools/bili-data`：B 站 Cookie 等同账号控制权，`cookies.txt` 600、不进 Git；投稿/点赞/关注/评论/私信只在主人私聊挂载，`bili_publish` 必须 `confirm=true`，建议独立小号、低频。
- `diary`：只从主人私聊 + 群聊取素材，默认 `visibility=friends`，避免把别人的私聊写进公开说说。
- `dy-im/bridge.mjs`：白名单 + 发送前隐私过滤（QQ/微信/手机号/邮箱/密钥/路径/URL/服务器词）。
- `message-index`：按 chatId 作用域检索，没有 chatId 的会话宁可不收。
- 所有模块的敏感 HTTP 路由只允许 `127.0.0.1/::1`。

### 数据

- `config.json` 640；`auth.json`、`key.txt`、`tts.env`、`.napcat-token`、`.credentials.yaml` 600。
- 备份目录 700、备份文件 600；备份包含密钥，必须异地加密存放。
- 仓库不包含任何运行数据；`.gitignore` 覆盖 `modules-data/`、`sessions/`、`memories.json`、`auth.json`、`key.txt`、`*.db`、`*.log` 等。
- 旧备份可能含旧 Key：轮换后删除或加密旧包。

## 4. 已知限制

- 模型 provider 能看到发给它的提示词与上下文；选择可信 provider，敏感数据尽量本地化。
- 提示词注入无法 100% 消除；出站守卫和工具权限是最后一道闸。
- NapCat 以 root 运行是现实限制；不要在同一台机器上跑不可信代码。
- 面板用自签证书，浏览器会提示；长期建议域名 + 正式证书或内网访问。
- 没有全盘加密；云厂商能看到磁盘。敏感数据可考虑应用层加密。
- 记忆/日志里可能残留敏感片段；定期审计 `outbound-guard` 样本与日志。

## 5. 上线检查清单

- [ ] `sshd -T`：密码登录关闭、root 登录关闭、只允许 ubuntu
- [ ] `ufw status`：只开 22/443
- [ ] `ss -ltnp`：5043/3000/3001/6099/2019 只在 127.0.0.1
- [ ] `systemctl show dsh-web -p User`：`dsh`
- [ ] `systemd-analyze security dsh-web`：确认沙箱项生效
- [ ] `config.json` 640，密钥文件 600
- [ ] `/panel/data` 无 Cookie 返回 401
- [ ] `auto-allow` 关闭，`dangerConfirm` 打开
- [ ] `diary.visibility` 不是 `all`
- [ ] 备份 700/600，异地副本可用
- [ ] 出站守卫开启，测试一条含 `sk-`/路径的消息被改写
- [ ] 群聊/别人私聊问主人私聊内容，确认召回不到

## 6. 事件响应

1. **疑似泄露**：立即轮换模型/TTS/图床/NapCat/面板密钥；检查 `outbound-guard` 日志与最近发送记录。
2. **账号异常**：停 `dsh-web` 或设 `dryRun=true`；检查 `allow` 与群列表；必要时改 QQ 密码、下线 NapCat。
3. **服务器入侵**：断网/快照、保留日志、轮换所有密钥、从干净备份恢复；不要在原机继续跑。
4. **数据误删**：停止写入，从最近备份恢复；检查 `removed.jsonl`、`cold-memories.jsonl`、`memory-archive` 是否还有原文。
