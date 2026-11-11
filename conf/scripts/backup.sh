#!/usr/bin/env bash
# 每日备份：数据 + 配置；sqlite 热备；排除可重建缓存。
# 备份包内含密钥与会话数据，文件权限必须是 600，目录 700。
set -u

DSH_HOME=${DSH_HOME:-/var/lib/dsh}
DEST=${BACKUP_DIR:-/opt/fish/backup}
STAMP=$(date +%Y%m%d-%H%M)
OUT="$DEST/dsh-$STAMP.tgz"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/dsh" "$WORK/conf" "$WORK/db"

# 1) sqlite 热备（避免打包正在写的库）
for db in $(find "$DSH_HOME/plugins-data" -name '*.db' 2>/dev/null); do
  name=$(echo "$db" | sed "s|$DSH_HOME/plugins-data/||; s|/|_|g")
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db" ".backup '$WORK/db/$name'" 2>/dev/null || cp -a "$db" "$WORK/db/$name" 2>/dev/null
  else
    cp -a "$db" "$WORK/db/$name" 2>/dev/null
  fi
done

# 2) 主数据（排除可重建缓存、缩略图、旧备份与日志）
tar czf "$WORK/data.tgz" -C "$(dirname "$DSH_HOME")" \
  --exclude="$(basename "$DSH_HOME")/plugins-data/aurabot/imagegen" \
  --exclude="$(basename "$DSH_HOME")/plugins-data/aurabot/stickers" \
  --exclude="$(basename "$DSH_HOME")/plugins-data/aurabot/modules-data/pet" \
  --exclude="$(basename "$DSH_HOME")/plugins-data/aurabot/modules-data/voice*" \
  --exclude="$(basename "$DSH_HOME")/plugins-data/aurabot/modules-data/*/thumbs" \
  --exclude="$(basename "$DSH_HOME")/plugins-data/aurabot/modules-data/web-tools/cache.json" \
  --exclude="$(basename "$DSH_HOME")/plugins-data/*/*.db" \
  --exclude="$(basename "$DSH_HOME")/backup-*" \
  --exclude='*.bak*' \
  --exclude='.aurabot-cache' \
  --exclude="$(basename "$DSH_HOME")/sessions" \
  --exclude='*.log' \
  "$(basename "$DSH_HOME")" 2>/dev/null

# 3) 会话单独打（压缩比高，不含日志）
tar czf "$WORK/sessions.tgz" -C "$(dirname "$DSH_HOME")" "$(basename "$DSH_HOME")/sessions" 2>/dev/null

# 4) 配置与密钥
for f in /etc/caddy/Caddyfile /etc/dsh/tts.env /root/.napcat-token; do
  [ -e "$f" ] && cp --parents -a "$f" "$WORK/conf/" 2>/dev/null
done
mkdir -p "$WORK/conf/systemd"
cp -a /etc/systemd/system/dsh-web.service /etc/systemd/system/napcat.service /etc/systemd/system/fish-backup.* "$WORK/conf/systemd/" 2>/dev/null
cp -a /etc/systemd/system/ssh.socket.d "$WORK/conf/systemd/" 2>/dev/null
cp -a /opt/fish/scripts "$WORK/conf/" 2>/dev/null
cp -a /etc/logrotate.d/dafeiyu /etc/logrotate.d/napcat "$WORK/conf/" 2>/dev/null
cp -a /etc/caddy/certs "$WORK/conf/certs" 2>/dev/null

tar czf "$OUT.part" -C "$WORK" . 2>/dev/null && mv "$OUT.part" "$OUT" && chmod 600 "$OUT"
ls -1t "$DEST"/dsh-*.tgz 2>/dev/null | tail -n +8 | xargs -r rm -f
echo "$(date '+%F %T') backup ok: $(du -h "$OUT" | cut -f1) -> $OUT"

# 热重载快照清理：每个模块只留最近 3 个
for d in "$DSH_HOME"/plugins-data/aurabot/modules/*/.aurabot-cache; do
  [ -d "$d" ] && ls -1t "$d" | tail -n +4 | xargs -r -I{} rm -rf "$d/{}"
done
