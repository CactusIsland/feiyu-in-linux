# 部署

以下步骤对应参考实现（Ubuntu 24.04 + Node 24 + DSH + NapCat + Caddy，2C2G）。路径用 `$DSH_HOME`（示例 `/var/lib/dsh`）和 `YOUR_*` 占位，按自己的环境替换。

## 0. 前置条件

- Ubuntu 24.04，2C2G 起步；50GB 磁盘更从容。
- Node.js 24（DSH 与 `node:sqlite` 的 FTS5 需要较新的 Node）。
- 一个 QQ 小号（机器人号）和一个主人 QQ 号。
- 一个能跑 NapCat 的 Linux 环境（Xvfb）。
- 一个域名或公网 IP（面板用；裸 IP 用自签证书也可以）。

## 1. 用户与目录

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin dsh
sudo mkdir -p /var/lib/dsh /var/lib/dsh/workspace /opt/fish/media/qq-chats
sudo chown -R dsh:dsh /var/lib/dsh /opt/fish/media
sudo chmod 750 /var/lib/dsh
```

不要把运行数据放在 `/root`：参考实现已经把 `DSH_HOME` 迁到 `/var/lib/dsh`，并用 systemd 沙箱限制写路径。

## 2. 安装 DSH

按 DeepSeek Harness 的官方方式安装，确认：

```bash
which dsh
dsh --version
```

把 `DSH_HOME` 指到 `/var/lib/dsh`，并准备 web profile。参考实现的 profile 目录是：

```text
/var/lib/dsh/profiles/web/
```

## 3. 安装宿主插件

把 `aurabot-src/` 放到：

```text
$DSH_HOME/profiles/web/node_modules/dsh-aurabot-qq/
```

或者按上游 README 安装 `dsh-aurabot-qq` 1.1.24。确认 `package.json` 的 `main` 是 `src/host.js`，并在 DSH 的 profile 里启用这个插件。

## 4. 安装自定义模块

```bash
sudo mkdir -p $DSH_HOME/plugins-data/aurabot/modules
sudo cp -r modules/* $DSH_HOME/plugins-data/aurabot/modules/
sudo chown -R dsh:dsh $DSH_HOME/plugins-data
```

注意：

- 不要复制 `.aurabot-cache/`（热重载缓存）。
- 模块目录里不要放 `modules-data`、日志或数据库。
- 自定义模块通过目录名识别；`index.mjs` 是入口。
- 如果某个模块覆盖内置模块（例如 `douyin`），在配置的 `modules` 里写 `useBuiltin: false`。

## 5. 配置

```bash
sudo cp conf/config.example.json $DSH_HOME/plugins-data/aurabot/config.json
sudo chown dsh:dsh $DSH_HOME/plugins-data/aurabot/config.json
sudo chmod 640 $DSH_HOME/plugins-data/aurabot/config.json
```

至少替换：

- `botQQ`、`ownerQQ`
- `allow.private` / `allow.groups`
- `snowluma.httpToken` / `wsToken`（如果用 SnowLuma）
- `bridge.token`（如果用桥接）
- 模型 provider / model
- `imageGen` / `bili` / `heybox` / `song` 的密钥（不用就保持空）

安全默认值：

```json
{
  "dryRun": false,
  "security": { "dangerConfirm": true },
  "diary": { "visibility": "friends" },
  "speakUp": { "enabled": false },
  "ext": {
    "auto-allow": { "enabled": false, "includeFriends": false, "includeGroups": false },
    "session-budget": { "autoRotate": false, "warnTokens": 20000, "rotateTokens": 35000 }
  }
}
```

首次上线建议先把 `dryRun` 设为 `true`，确认回复内容后再关。

## 6. NapCat

安装 NapCat Linux 版本（官方包或你自己的部署），让 QQ 在 Xvfb 下运行：

```bash
xvfb-run -a /opt/napcat/opt/QQ/qq --no-sandbox -q YOUR_BOT_QQ
```

OneBot 11 配置：

- HTTP：`127.0.0.1:3000`
- WS：`127.0.0.1:3001`
- WebUI：`127.0.0.1:6099`（只用 SSH 隧道访问）

把 HTTP/WS token 写到 `/root/.napcat-token`（600），并让 `guard.sh` 能读到。不要把 3000/3001/6099 暴露到公网。

参考 `conf/systemd/napcat.service`；NapCat 仍以 root 运行，这是 QQ NT 的限制，用防火墙和回环监听隔离。

## 7. systemd

```bash
sudo cp conf/systemd/dsh-web.service /etc/systemd/system/
sudo cp conf/systemd/napcat.service /etc/systemd/system/
sudo cp conf/systemd/fish-guard.service /etc/systemd/system/
sudo cp conf/systemd/fish-guard.timer /etc/systemd/system/
sudo cp conf/systemd/fish-backup.service /etc/systemd/system/
sudo cp conf/systemd/fish-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-web napcat
```

`dsh-web.service` 已经包含：

- `User=dsh` / `Group=dsh`
- `DSH_HOME=/var/lib/dsh`
- `NoNewPrivileges=yes`、`PrivateTmp=yes`、`ProtectSystem=strict`、`ProtectHome=read-only`
- `ReadWritePaths=/var/lib/dsh /opt/fish/media /tmp`
- `MemoryHigh=500M`、`MemoryMax=800M`、`CPUQuota=150%`

如果启用抖音模块，`dy-cli` 可能需要写 `/opt/douyin/data`，把该路径加进 `ReadWritePaths`，或者把 `DOUYIN_DATA_DIR` 指到 `$DSH_HOME` 下。

## 8. Caddy 面板

```bash
sudo cp conf/caddy/Caddyfile.example /etc/caddy/Caddyfile
sudo mkdir -p /etc/caddy/certs
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout /etc/caddy/certs/panel.key \
  -out /etc/caddy/certs/panel.crt \
  -subj "/CN=YOUR_DOMAIN_OR_IP"
sudo chown -R caddy:caddy /etc/caddy/certs
sudo chmod 600 /etc/caddy/certs/panel.key
sudo systemctl reload caddy
```

访问 `https://YOUR_DOMAIN_OR_IP/panel/ui`，首次设置面板账号密码。`panel` 模块会把 scrypt 哈希写到：

```text
$DSH_HOME/plugins-data/aurabot/modules-data/panel/auth.json   (600)
```

未登录访问 `/panel/data` 应返回 401。

## 9. 防火墙与 SSH

```bash
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

不要开放 `5043`、`3000`、`3001`、`6099`、`2019`。

SSH：

```bash
sudo cp conf/ssh/99-dafeiyu.conf /etc/ssh/sshd_config.d/
sudo sshd -t
sudo systemctl reload ssh
```

改之前先确认你的公钥已经在 `/home/ubuntu/.ssh/authorized_keys`；参考配置会关闭密码登录和 root 登录。

## 10. 守护与备份

```bash
sudo mkdir -p /opt/fish/scripts /opt/fish/backup
sudo cp conf/scripts/guard.sh conf/scripts/backup.sh /opt/fish/scripts/
sudo chmod 755 /opt/fish/scripts/*.sh
sudo chmod 700 /opt/fish/backup
sudo systemctl enable --now fish-guard.timer fish-backup.timer
```

- `guard.sh`：每 5 分钟检查 `napcat/dsh-web/caddy`、QQ 网关、可用内存、磁盘；异常通过 NapCat 私聊告警。
- `backup.sh`：每日 04:30 备份数据、会话、配置、SQLite 热备、Caddy 证书；保留 7 份；文件 600。
- 备份包含密钥和聊天数据，必须异地再存一份（COS/S3/另一台机器），并定期演练恢复。

## 11. 验证

```bash
systemctl is-active dsh-web napcat caddy
curl -s http://127.0.0.1:5043/aurabot/api/state | jq '{version,onebot:.onebot.state,modules:(.modules|length)}'
curl -k -s -o /dev/null -w '%{http_code}\n' https://YOUR_DOMAIN_OR_IP/panel/ui
curl -k -s -o /dev/null -w '%{http_code}\n' https://YOUR_DOMAIN_OR_IP/panel/data   # 期望 401
journalctl -u dsh-web -n 50 --no-pager
tail -n 50 /var/log/napcat.log
```

在主人私聊里发一条消息，确认能收到回复；再发 `/预算`、`/存档` 等命令确认模块加载。

## 12. 升级与回滚

1. 先触发一次备份：`sudo systemctl start fish-backup`。
2. 替换 `modules/` 下的模块文件；热加载会自动生效。
3. 看 `journalctl -u dsh-web` 是否有模块加载失败；`.aurabot-cache/` 保留最近 3 个版本，可手动回滚。
4. 大版本升级 DSH 前，先在测试目录验证 `node --check` 和模块 API 兼容性。
