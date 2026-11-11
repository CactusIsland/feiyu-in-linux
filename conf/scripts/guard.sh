#!/usr/bin/env bash
# 每 5 分钟巡检：服务 / 网关 / 内存 / 磁盘。异常时通过 NapCat 直接发 QQ 给主人。
#
# 设计要点：
# - DSH 只监听 127.0.0.1:5043，必须用回环地址探活；不要写内网 IP。
# - 主人 QQ 从 config.json 读取；读不到就只写日志，不猜测、不外发。
set -u

STATE=${STATE:-/opt/fish/guard.state}
COOLDOWN=${COOLDOWN:-1800}
DSH_HOME=${DSH_HOME:-/var/lib/dsh}
NAPCAT_TOKEN_FILE=${NAPCAT_TOKEN_FILE:-/root/.napcat-token}
NAPCAT_API=${NAPCAT_API:-http://127.0.0.1:3000}
DSH_API=${DSH_API:-http://127.0.0.1:5043}

TOKEN=$(cat "$NAPCAT_TOKEN_FILE" 2>/dev/null || true)
OWNER=$(DSH_HOME="$DSH_HOME" node -e "try{console.log(require(process.env.DSH_HOME + '/plugins-data/aurabot/config.json').ownerQQ)}catch{console.log('')}" 2>/dev/null)
OWNER=${OWNER:-${OWNER_QQ:-}}

mkdir -p "$(dirname "$STATE")"
touch "$STATE"

alert() {
  local key="$1" msg="$2" now last
  now=$(date +%s)
  last=$(grep -E "^$key " "$STATE" 2>/dev/null | awk '{print $2}' | tail -1)
  [ -n "${last:-}" ] && [ $((now - last)) -lt "$COOLDOWN" ] && return 0
  if [ -n "$TOKEN" ] && [ -n "$OWNER" ]; then
    curl -s -m 10 -X POST "$NAPCAT_API/send_private_msg" \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d "{\"user_id\":$OWNER,\"message\":\"【告警】$msg\"}" >/dev/null 2>&1 || true
  fi
  echo "$key $now" >>"$STATE"
  echo "$(date '+%F %T') ALERT[$key] $msg"
}

# 服务
for s in napcat dsh-web caddy; do
  systemctl is-active --quiet "$s" || alert "svc-$s" "$s 没在跑（已自动尝试重启）"
done
systemctl is-active --quiet napcat || systemctl restart napcat >/dev/null 2>&1
systemctl is-active --quiet dsh-web || systemctl restart dsh-web >/dev/null 2>&1
systemctl is-active --quiet caddy || systemctl restart caddy >/dev/null 2>&1

# 网关
GW=$(curl -s -m 8 "$DSH_API/aurabot/api/state" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log((JSON.parse(d).onebot||{}).state||'')}catch{console.log('')}})" 2>/dev/null)
[ "${GW:-}" = "connected" ] || alert "gateway" "QQ 网关不是 connected（当前：${GW:-无响应}）"

# 内存
AVAIL=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
[ "$AVAIL" -lt 120 ] && alert "mem" "可用内存只剩 ${AVAIL}MB"

# 磁盘
FREE=$(df -m / | awk 'NR==2{print $4}')
[ "$FREE" -lt 3000 ] && alert "disk" "磁盘只剩 ${FREE}MB"

echo "$(date '+%F %T') guard ok mem=${AVAIL}MB disk=${FREE}MB gw=${GW:-?}"
