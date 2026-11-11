import sys
import json
import os
import random
import subprocess
import tempfile
import urllib.parse
import urllib.request
import glob

from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 720, 1280
DSH = os.environ.get('DSH_HOME', '/var/lib/dsh')
IMGDIR = os.environ.get('BILI_IMAGE_DIR', os.path.join(DSH, 'plugins-data/aurabot/imagegen'))
FONT = os.environ.get('BILI_FONT', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc')
OUTDIR = os.environ.get('BILI_VIDEO_DIR', os.path.join(os.environ.get('BILI_DATA_DIR', '/opt/bili-data'), 'videos'))
TTS_URL = os.environ.get('BILI_TTS_URL', 'http://127.0.0.1:5043/aurabot/api/ext/tts-doubao/tts?text=')
FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')
FFPROBE = os.environ.get('FFPROBE', (os.path.join(os.path.dirname(FFMPEG), 'ffprobe') if os.path.dirname(FFMPEG) else 'ffprobe'))


def tts(text, out):
    url = TTS_URL + urllib.parse.quote(text)
    with urllib.request.urlopen(url, timeout=120) as r:
        open(out, 'wb').write(r.read())


def duration(p):
    r = subprocess.run(
        [FFPROBE, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p],
        capture_output=True,
        text=True,
    )
    try:
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def background():
    files = glob.glob(os.path.join(IMGDIR, '*.png')) + glob.glob(os.path.join(IMGDIR, '*.jpg'))
    random.shuffle(files)
    for f in files:
        try:
            im = Image.open(f).convert('RGB')
            s = max(W / im.width, H / im.height)
            im = im.resize((int(im.width * s) + 1, int(im.height * s) + 1))
            x = (im.width - W) // 2
            y = (im.height - H) // 2
            im = im.crop((x, y, x + W, y + H)).filter(ImageFilter.GaussianBlur(16))
            return Image.eval(im, lambda v: int(v * 0.42))
        except Exception:
            continue
    return Image.new('RGB', (W, H), (24, 32, 64))


def wrap(draw, text, font, maxw):
    lines, cur = [], ''
    for ch in text:
        if ch == '\n':
            lines.append(cur)
            cur = ''
            continue
        if draw.textlength(cur + ch, font=font) > maxw and cur:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def render(text, path):
    im = background()
    d = ImageDraw.Draw(im, 'RGBA')
    size = 54
    lines = []
    while size >= 24:
        f = ImageFont.truetype(FONT, size)
        lines = wrap(d, text, f, W - 130)
        if len(lines) * int(size * 1.55) <= 760:
            break
        size -= 4
        lines = []
    if not lines:
        f = ImageFont.truetype(FONT, 24)
        lines = wrap(d, text, f, W - 130)
    f = ImageFont.truetype(FONT, size)
    lh = int(size * 1.55)
    th = lh * len(lines)
    y0 = max(160, (H - th) // 2)
    pad = 36
    d.rounded_rectangle([46, y0 - pad, W - 46, y0 + th + pad], radius=28, fill=(0, 0, 0, 120))
    for i, ln in enumerate(lines):
        tw = d.textlength(ln, font=f)
        d.text(((W - tw) // 2, y0 + i * lh), ln, font=f, fill=(255, 255, 255, 255),
               stroke_width=2, stroke_fill=(0, 0, 0, 190))
    ft = ImageFont.truetype(FONT, 30)
    d.text((48, 56), '大肥鱼', font=ft, fill=(255, 255, 255, 210))
    im.save(path)


def main():
    a = json.loads(sys.argv[1])
    text = a['text'].strip()
    out = a.get('out') or os.path.join(OUTDIR, 'vlog-%d.mp4' % os.getpid())
    os.makedirs(os.path.dirname(out) or OUTDIR, exist_ok=True)
    tmp = tempfile.mkdtemp()
    audio = os.path.join(tmp, 'a.mp3')
    tts(text, audio)
    total = duration(audio) or max(5.0, len(text) / 6.0)
    png = os.path.join(tmp, 'one.png')
    render(text, png)
    r = subprocess.run(
        [FFMPEG, '-y', '-loop', '1', '-i', png, '-i', audio, '-t', '%.2f' % total,
         '-vf', 'scale=720:1280,format=yuv420p',
         '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-threads', '2',
         '-r', '25', '-c:a', 'aac', '-shortest', out],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        print(json.dumps({'ok': False, 'error': r.stderr[-400:]}, ensure_ascii=False))
        return
    print(json.dumps({'ok': True, 'file': out, 'seconds': round(total, 1)}, ensure_ascii=False))


main()
