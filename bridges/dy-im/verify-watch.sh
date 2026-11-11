#!/bin/bash
# 盯日志：一出现 VERIFY_URL 就在 VNC 浏览器里打开它
LOG=/tmp/dy-bridge.log
LAST=""
tail -n 0 -F "$LOG" 2>/dev/null | while read -r line; do
  case "$line" in
    *VERIFY_URL*)
      URL=$(echo "$line" | sed 's/.*VERIFY_URL //')
      [ "$URL" = "$LAST" ] && continue
      LAST="$URL"
      echo "$(date '+%F %T') open $URL" >> /opt/dy-im/verify-watch.log
      su -s /bin/bash dsh -c "DISPLAY=:98 /usr/bin/google-chrome --user-data-dir=/opt/douyin/data/vnc-profile --no-first-run --no-default-browser-check '$URL'" >/dev/null 2>&1 &
      ;;
  esac
done
