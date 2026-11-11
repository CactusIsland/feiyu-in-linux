import asyncio
import json
import os
import sys

from bilibili_api import user, Credential

DIR = os.environ.get('BILI_DATA_DIR', '/opt/bili-data')
CK = os.environ.get('BILI_COOKIE_FILE', '')
if not CK:
    for name in ('cookies.txt', 'cookies_raw.txt'):
        p = os.path.join(DIR, name)
        if os.path.exists(p):
            CK = p
            break
if not CK or not os.path.exists(CK):
    print(json.dumps({'ok': False, 'error': 'cookie file not found'}, ensure_ascii=False))
    sys.exit(1)

raw = open(CK, encoding='utf-8').read()
kv = dict(p.split('=', 1) for p in raw.split('; ') if '=' in p)
cred = Credential(
    sessdata=kv.get('SESSDATA', ''),
    bili_jct=kv.get('bili_jct', ''),
    buvid3=kv.get('buvid3', ''),
    dedeuserid=kv.get('DedeUserID', ''),
)
MID = int(kv.get('DedeUserID', '0') or 0)


async def main():
    if not MID:
        print(json.dumps({'ok': False, 'error': 'DedeUserID missing'}, ensure_ascii=False))
        return
    u = user.User(MID, credential=cred)
    res = await u.get_videos()
    out = []
    for v in (res.get('list', {}).get('vlist') or []):
        out.append({
            'bvid': v.get('bvid'),
            'aid': v.get('aid'),
            'title': v.get('title'),
            'comments': v.get('comment', 0),
            'created': v.get('created'),
        })
    print(json.dumps(out, ensure_ascii=False))


asyncio.run(main())
