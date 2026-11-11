# 抖音模块与私信桥

抖音能力分成两条独立链路，登录态也不共用：

```text
① 接口模式（搜索 / 评论 / 豆包总结）
   modules/douyin  ──►  dy-cli（Python）  ──►  /opt/douyin
                         Cookie: /opt/douyin/data/home/.dy/cookies/default.json

② 私信桥（抖音私信自动回复）
   modules/douyin  /dm  ◄──  bridges/dy-im（Node, douyin-im）  ◄──  抖音私信
                             登录态: /opt/dy-im/data
```

## 1. 接口模式（`modules/douyin`）

### 工具

| 工具 | 作用 | 是否写操作 |
|---|---|---|
| `douyin_hot` | 抖音热榜，不需要登录 | 否 |
| `douyin_search` | 搜视频，返回标题/作者/点赞/评论数 | 否 |
| `douyin_watch` | 读评论区，找豆包总结；没有可召唤 | 可能写（召唤） |
| `douyin_recent` | 最近看过的视频 | 否 |
| `douyin_comment` | 发评论（过隐私检查） | 是 |
| `douyin_like` | 点赞 | 是 |
| `douyin_favorite` | 收藏 | 是 |
| `douyin_follow` | 关注 | 是 |
| `douyin_me` | 看自己的账号信息 | 否 |
| `douyin_notifications` | 看通知 | 否 |

所有工具只在主人私聊（`level === 'full'`）挂载。

### 安装 dy-cli

参考 `dsh-douyin-toolkit` 的 MIT 项目，放到 `/opt/douyin`（或改模块里的 `REPO` 常量）：

```bash
cd /opt/douyin
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m dy_cli.main login      # 扫码登录
.venv/bin/python -m dy_cli.main status     # 应显示“已登录”
```

模块通过：

```text
PY=/opt/douyin/.venv/bin/python
HOME=/opt/douyin/data/home
DOUYIN_DATA_DIR=/opt/douyin/data
```

调用 `python -m dy_cli.main search/comments/...`。确保 `dsh` 用户能读 `/opt/douyin`、执行 venv、写 `data` 目录（如果 systemd 用了 `ProtectSystem=strict`，把 `/opt/douyin/data` 加进 `ReadWritePaths`）。

### 配置

顶层 `douyin.enabled` 是功能总开关；`modules.douyin` 决定用内置还是自定义模块；`ext.douyin` 是自定义模块的设置：

```json
{
  "douyin": { "enabled": true },
  "modules": {
    "douyin": { "forkedFrom": "2.0.0", "enabled": true, "useBuiltin": false }
  },
  "ext": {
    "douyin": {
      "enabled": true,
      "dailyMax": 3,
      "dailyBudgetCny": 1,
      "commentCount": 20,
      "autoSummon": false
    }
  }
}
```

安全建议：

- `autoSummon=false`：不要自动发评论 `@豆包 总结一下这个视频`，只在主人明确要求时召唤。
- `dailyMax` 3 左右；`dailyBudgetCny` 1–2。
- 评论/点赞/收藏/关注属于写操作，先只读跑几天，确认账号没有风控再加。
- 风控命中会通过 `api.sendText` 私聊告警；`watched.json` 的 `alerts` 会记录 `risk:YYYY-MM-DDTHH`。
- 模块内置 `FORBID` 检查：评论内容含 QQ/微信/手机号/服务器/路径/长数字会拒绝。

### 已知边界

v4 是“接口模式”：搜索、读评论、找豆包总结，不下载视频、不抽帧、不看画面。如果要“真看视频内容”，需要另接 ASR/视觉。

## 2. 私信桥（`bridges/dy-im`）

### 文件

| 文件 | 作用 |
|---|---|
| `bridge.mjs` | 登录抖音私信、白名单、转发到 DSH `/dm`、发送前隐私过滤 |
| `login.mjs` | 扫码登录（二维码写到 `login.png`） |
| `login-sms.mjs` | 短信登录（手机号从 `DY_MOBILE` 环境变量取） |
| `login-pwd.mjs` | 密码登录（手机号 `DY_MOBILE`，密码写到 `.pwd` 后立即删除） |
| `qr.html` | 本地二维码展示页（可选，用 Chrome/VNC 打开） |
| `verify-watch.sh` | 盯日志，出现 `VERIFY_URL` 时在 VNC 浏览器打开验证页 |

### 配置

复制 `bridge.json.example` 为 `/opt/dy-im/bridge.json`：

```json
{
  "ownerNick": "YOUR_DOUYIN_NICKNAME",
  "allowUids": []
}
```

- `ownerNick`：只回复昵称包含这个字符串的人；留空则必须靠 `allowUids`。
- `allowUids`：精确 UID 白名单。
- 两者都为空时，所有私信都会被跳过（fail-closed）。

### 运行

```bash
cd /opt/dy-im
npm install
node bridge.mjs
```

首次登录会写 `/opt/dy-im/login.png`；用抖音 App 扫码。日志出现 `ONLINE <uid> <nickname>` 即成功。

建议做成 systemd 服务（Restart=always），不要用 `nohup`：

```ini
[Unit]
Description=Douyin IM bridge
After=network-online.target

[Service]
Type=simple
User=dsh
WorkingDirectory=/opt/dy-im
ExecStart=/usr/bin/node bridge.mjs
Restart=always
RestartSec=5
MemoryHigh=200M
MemoryMax=400M

[Install]
WantedBy=multi-user.target
```

### 隐私过滤

`bridge.mjs` 在发送前硬过滤：

- QQ / 微信 / 群号 / 聊天记录
- 5–12 位长数字（QQ/群号）
- 手机号、邮箱
- `sk-*`、`Bearer`、token、api key、密钥、密码
- 服务器/后台/面板/插件/模块/数据库/记忆/主人/NapCat/DSH/Aurabot/OneBot 等词
- `/root`、`/var`、`/opt`、`.dsh`、Windows 盘符、IPv4
- URL

命中就替换或拒绝发送。`/dm` 路由也只在 `127.0.0.1/::1` 可达。

### 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `/aurabot/api/ext/douyin/state` 返回 `moduleOff` | 顶层 `douyin.enabled=false` | 打开总开关；确认 `modules.douyin.enabled=true` |
| 私信桥扫码后没回复 | 没配白名单 / `/dm` 被 moduleOff 挡住 | 配 `ownerNick`/`allowUids`；打开总开关；看 `/tmp/dy-bridge.log` 是否 `ONLINE` |
| `dy-cli status` 已登录，但私信桥没登录 | 两套登录态 | 分别登录；私信桥看 `/opt/dy-im/data`，接口模式看 `/opt/douyin/data/home/.dy` |
| Playwright `Missing X server` | 旧的 creator 登录用了有头浏览器 | 私信桥用 `douyin-im` 纯 Node，不需要浏览器；旧的 creator 流程用 Xvfb 或 headless |
| 内存紧张 | Chrome/VNC 只是扫码展示 | 扫码成功后关 Chrome，保留 `bridge.mjs` 即可 |

## 3. 合规提醒

抖音自动化可能违反平台条款，存在限流、验证码、封号风险。建议使用独立小号、低频、只读优先，并遵守当地法律与平台规则。
