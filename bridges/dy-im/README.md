# dy-im — 抖音私信桥

把抖音私信转给 DSH 的 `douyin` 模块，再把生成的回复发回抖音。纯 Node，不依赖浏览器。

```text
抖音私信  ⇄  bridge.mjs (douyin-im)  ⇄  POST /aurabot/api/ext/douyin/dm  ⇄  DSH
```

## 安装

```bash
cd /opt/dy-im
npm install
cp bridge.json.example bridge.json
# 编辑 bridge.json：ownerNick / allowUids
node bridge.mjs
```

首次登录会把二维码写到 `login.png`；用抖音 App 扫码。日志出现：

```text
ONLINE <uid> <nickname>
```

即登录成功。

## 白名单

`bridge.json`：

```json
{
  "ownerNick": "YOUR_DOUYIN_NICKNAME",
  "allowUids": []
}
```

- `ownerNick`：只回复昵称包含这个字符串的人。
- `allowUids`：精确 UID 白名单。
- 两者都没配 → 全部跳过（fail-closed）。

## 两种备用登录

- 短信：`DY_MOBILE=你的手机号 node login-sms.mjs`，验证码写到 `sms.txt`。
- 密码：`DY_MOBILE=你的手机号 node login-pwd.mjs`，密码写到 `.pwd`（脚本会立即删除）。

二维码页面 `qr.html` 只是本地展示；扫码成功后可以关掉浏览器，`bridge.mjs` 继续跑。

## 隐私过滤

发送前会硬过滤 QQ/微信/群号、长数字、手机号、邮箱、`sk-*`/Bearer/token/key/密码、服务器/面板/插件/记忆/主人/NapCat/DSH/Aurabot/OneBot 等词、本机路径、IPv4、URL。

## systemd

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

## 注意

- `/dm` 需要 `douyin.enabled=true`；否则会返回 `moduleOff`。
- 抖音自动化可能违反平台条款，存在风控/封号风险；用独立小号、低频、只读优先。
- `login.png`、`bridge.json`、`sms.txt`、`.pwd` 都不要提交到 Git。
