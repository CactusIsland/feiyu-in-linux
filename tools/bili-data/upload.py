import sys, json, asyncio, subprocess, os
from bilibili_api import video_uploader, Credential

DIR = os.environ.get('BILI_DATA_DIR', '/opt/bili-data')
FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')
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
cred = Credential(sessdata=kv.get('SESSDATA',''), bili_jct=kv.get('bili_jct',''), buvid3=kv.get('buvid3',''), dedeuserid=kv.get('DedeUserID',''))

def make_cover(video, out):
    if os.path.exists(out) and os.path.getsize(out) > 1000: return out
    subprocess.run([FFMPEG,"-y","-i",video,"-ss","1","-frames:v","1","-q:v","2",out], capture_output=True)
    return out if os.path.exists(out) and os.path.getsize(out) > 1000 else ''

async def main():
    a = json.loads(sys.argv[1])
    cover = a.get('cover') or make_cover(a['file'], '/tmp/cover-' + str(os.getpid()) + '.jpg')
    if not cover:
        print(json.dumps({'ok': False, 'error': '封面生成失败'}, ensure_ascii=False)); return
    page = video_uploader.VideoUploaderPage(path=a['file'], title=a.get('page_title') or a['title'], description=a.get('desc',''))
    meta = video_uploader.VideoMeta(tid=int(a.get('tid', 21)), title=a['title'], desc=a.get('desc',''),
                                    cover=cover, tags=a.get('tags') or ['日常'], original=True)
    up = video_uploader.VideoUploader([page], meta, credential=cred)
    if a.get('dry'):
        await up._preupload(up.pages[0])
        print(json.dumps({'ok': True, 'dry': True, 'bvid': up.bvid}, ensure_ascii=False)); return
    res = await up.start()
    print(json.dumps({'ok': True, 'result': str(res)[:300]}, ensure_ascii=False))

try:
    asyncio.run(main())
except Exception as e:
    import traceback; traceback.print_exc()
    print(json.dumps({'ok': False, 'error': type(e).__name__ + ': ' + str(e)[:200]}, ensure_ascii=False))