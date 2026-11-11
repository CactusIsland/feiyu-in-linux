"""读 DSH 会话文件，输出最近一轮与累计 token 用量（JSON）。"""
import json
import sys
from pathlib import Path

import zstandard as zstd

HOME = Path.home() / ".dsh" / "sessions"
sid = sys.argv[1]
target = None
for d in HOME.iterdir():
    if not d.is_dir():
        continue
    p = d / sid / "session.v4.jsonl.zstd"
    if p.is_file():
        target = p
        break
if target is None:
    print(json.dumps({"ok": False, "error": "session file not found"}))
    raise SystemExit(0)

with open(target, "rb") as f:
    data = zstd.ZstdDecompressor().stream_reader(f).read()

lines = data.decode("utf-8", "replace").split("\n")
parsed = 0
bad = 0
usage_lines = 0
last = None
total_in = total_out = total_cache = turns = 0
for line in lines:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except Exception:
        bad += 1
        continue
    parsed += 1
    usage = obj.get("usage")
    if not isinstance(usage, dict):
        usage = (obj.get("data") or {}).get("usage") if isinstance(obj.get("data"), dict) else None
    if not isinstance(usage, dict):
        continue
    usage_lines += 1
    turns += 1
    i = int(usage.get("inputTokens") or 0)
    o = int(usage.get("outputTokens") or 0)
    c = int(usage.get("cacheReadTokens") or 0)
    total_in += i
    total_out += o
    total_cache += c
    last = {
        "turn": turns,
        "inputTokens": i,
        "outputTokens": o,
        "cacheReadTokens": c,
        "promptTokens": i + c,
        "at": obj.get("time"),
        "type": obj.get("type"),
    }

print(json.dumps({
    "ok": True,
    "file": str(target),
    "diagnostics": {"lines": len(lines), "parsed": parsed, "bad": bad, "usageLines": usage_lines},
    "turns": turns,
    "last": last,
    "total": {"input": total_in, "output": total_out, "cacheRead": total_cache},
}, ensure_ascii=False))
