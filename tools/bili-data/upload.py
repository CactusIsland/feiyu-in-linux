import os
import sys
import json
import asyncio

from bilibili_api import video_uploader, Credential

DIR = os.environ.get('BILI_DATA_DIR', '/opt/bili-data')
CK = os.environ.get('BILI_COOKIE_FILE') or os.path.join(DIR, 'cookies.txt')
if not os.path.exists(CK):
    print(json.dumps({'ok': False, 'error': 'cookie file not found: ' + CK}, ensure_ascii=False))
    sys.exit(1)

raw = open(CK, encoding='utf-8').read()
kv = dict(p.split('=', 1) for p in raw.split('; ') if '=' in p)
cred = Credential(
    sessdata=kv.get('SESSDATA', ''),
    bili_jct=kv.get('bili_jct', ''),
    buvid3=kv.get('buvid3', ''),
    dedeuserid=kv.get('DedeUserID', ''),
)


async def main():
    a = json.loads(sys.argv[1])
    page = video_uploader.VideoUploaderPage(
        path=a['file'],
        title=a.get('page_title') or a['title'],
        description=a.get('desc', ''),
    )
    meta = video_uploader.VideoMeta(
        tid=int(a.get('tid', 21)),
        title=a['title'],
        desc=a.get('desc', ''),
        cover=a.get('cover', ''),
        tags=a.get('tags', ['日常']),
        original=True,
        no_reprint=False,
        open_elec=False,
    )
    up = video_uploader.VideoUploader([page], meta, credential=cred, max_retry=3)
    res = await up.start()
    print(json.dumps({'ok': True, 'result': str(res)[:400]}, ensure_ascii=False))


try:
    asyncio.run(main())
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)[:300]}, ensure_ascii=False))
    sys.exit(1)
