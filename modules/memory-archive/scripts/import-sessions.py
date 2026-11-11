"""把 DSH 的历史会话导进全量存档。

用法（用带 zstandard 的 Python）：
  /usr/bin/python3 import-sessions.py --dry-run
  /usr/bin/python3 import-sessions.py

只读 session.v4.jsonl.zstd，不改会话文件；通过 Aurabot 的
POST /aurabot/api/ext/memory-archive/import/rows 写进存档。
"""
import argparse
import hashlib
import json
import re
import sys
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

import zstandard as zstd

HOME = Path.home() / ".dsh"
SESSIONS = HOME / "sessions"
SESSIONS_JSON = HOME / "plugins-data" / "aurabot" / "sessions.json"
ARCHIVE_DIR = HOME / "plugins-data" / "aurabot" / "modules-data" / "memory-archive"

PRIVATE_RE = re.compile(r"【(?:私聊|QQ 私聊)】(.+?)(?:\((\d+)\))?：(.+)")
GROUP_RE = re.compile(r"^\[(\d+)\] (.+?)(?:\((\d+)\))：(.+)$")


def load_mapping():
    try:
        data = json.loads(SESSIONS_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {}
    out = {}
    for chat_id, info in (data.get("chats") or {}).items():
        sid = str((info or {}).get("sessionId") or "")
        if sid:
            out[sid] = str(chat_id)
    return out


def archive_ids():
    seen = set()
    if not ARCHIVE_DIR.exists():
        return seen
    for f in sorted(ARCHIVE_DIR.glob("*.jsonl")):
        try:
            for line in f.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                if row.get("id"):
                    seen.add(str(row["id"]))
        except Exception:
            continue
    return seen


def stable_id(at, chat_id, kind, user_id, text):
    raw = "\u0001".join([str(at), str(chat_id), str(kind), str(user_id), str(text)])
    return "h:" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


def content_blocks(message):
    content = message.get("content")
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict) and b.get("type") == "text" and b.get("text")]
    return []


def extract_events(session_file, chat_id):
    events = []
    try:
        with open(session_file, "rb") as f:
            data = zstd.ZstdDecompressor().stream_reader(f).read().decode("utf-8", "replace")
    except Exception as error:
        print(f"  跳过 {session_file.name}: {error}")
        return events
    for line in data.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        kind = obj.get("type")
        at = int(obj.get("time") or 0)
        if kind == "assistant/message":
            msg = obj.get("data", {}).get("message") or {}
            text = "\n".join(b.get("text", "") for b in content_blocks(msg)).strip()
            if text:
                events.append({"at": at, "chatId": chat_id, "kind": "out", "nickname": "她", "text": text})
        elif kind == "user/message":
            msg = obj.get("data", {}).get("message") or obj.get("data") or {}
            for block in content_blocks(msg):
                for raw in str(block.get("text") or "").split("\n"):
                    s = raw.strip()
                    if not s:
                        continue
                    m = PRIVATE_RE.match(s)
                    if m:
                        events.append({
                            "at": at,
                            "chatId": chat_id,
                            "kind": "in",
                            "nickname": m.group(1).strip(),
                            "userId": (m.group(2) or "").strip(),
                            "text": m.group(3).strip(),
                        })
                        continue
                    m = GROUP_RE.match(s)
                    if m:
                        events.append({
                            "at": at,
                            "chatId": chat_id,
                            "kind": "in",
                            "nickname": m.group(2).strip(),
                            "userId": (m.group(3) or "").strip(),
                            "text": m.group(4).strip(),
                        })
    return events


def post_rows(base_url, rows):
    body = json.dumps({"rows": rows}, ensure_ascii=False).encode("utf-8")
    req = Request(
        base_url.rstrip("/") + "/aurabot/api/ext/memory-archive/import/rows",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--base-url", default="http://127.0.0.1:12331")
    parser.add_argument("--limit-sessions", type=int, default=0)
    parser.add_argument("--include-legacy", action="store_true", help="也导入没有映射到聊天的旧会话（默认只导 QQ 聊天）")
    args = parser.parse_args()

    mapping = load_mapping()
    seen = archive_ids()
    files = sorted(SESSIONS.rglob("session.v4.jsonl.zstd"), key=lambda p: p.stat().st_mtime, reverse=True)
    if args.limit_sessions:
        files = files[: args.limit_sessions]

    all_rows = []
    for f in files:
        sid = f.parent.name
        chat_id = mapping.get(sid)
        if chat_id and chat_id.startswith("system:"):
            continue
        if not chat_id:
            if not args.include_legacy:
                continue
            # 只补 Aurabot 工作区里没有映射的旧会话；别把 DSH 的编码/工具会话混进来
            if "Aurabot" not in f.parent.parent.name:
                continue
            chat_id = "legacy:" + sid
        events = extract_events(f, chat_id)
        added = 0
        for e in events:
            eid = stable_id(e["at"], e["chatId"], e["kind"], e.get("userId", ""), e["text"])
            if eid in seen:
                continue
            e["id"] = eid
            e["channel"] = "legacy"
            e["owner"] = False
            e["direct"] = e["chatId"].startswith("private:")
            seen.add(eid)
            all_rows.append(e)
            added += 1
        print(f"{f.parent.parent.name}/{sid} -> {chat_id}：{len(events)} 条，新增 {added} 条")

    print(f"\n合计待写入 {len(all_rows)} 条")
    if args.dry_run or not all_rows:
        return

    total_added = 0
    total_skipped = 0
    for i in range(0, len(all_rows), 500):
        batch = all_rows[i : i + 500]
        try:
            r = post_rows(args.base_url, batch)
            total_added += int(r.get("added") or 0)
            total_skipped += int(r.get("skipped") or 0)
            print(f"  批次 {i // 500 + 1}：新增 {r.get('added')}，跳过 {r.get('skipped')}")
        except Exception as error:
            print(f"  批次 {i // 500 + 1} 写入失败：{error}", file=sys.stderr)
            print("  可以把这一批先存成 staging 文件，等 Aurabot 起了再重跑。")
            raise SystemExit(1)
    print(f"\n完成：新增 {total_added} 条，跳过 {total_skipped} 条")


if __name__ == "__main__":
    main()
