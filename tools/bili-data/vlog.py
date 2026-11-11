import sys, json, os, random, subprocess, tempfile, urllib.parse, urllib.request, glob
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 720, 1280
DSH = os.environ.get('DSH_HOME', '/var/lib/dsh')
BILI_DIR = os.environ.get('BILI_DATA_DIR', '/opt/bili-data')
IMGDIR = os.environ.get('BILI_IMAGE_DIR', os.path.join(DSH, 'plugins-data/aurabot/imagegen'))
FONT = os.environ.get('BILI_FONT', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc')
OUTDIR = os.environ.get('BILI_VIDEO_DIR', os.path.join(BILI_DIR, 'videos'))
TTS_URL = os.environ.get('BILI_TTS_URL', 'http://127.0.0.1:5043/aurabot/api/ext/tts-doubao/tts?text=')
FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')
FFPROBE = os.environ.get('FFPROBE', (os.path.join(os.path.dirname(FFMPEG), 'ffprobe') if os.path.dirname(FFMPEG) else 'ffprobe'))
BRAND = os.environ.get('BILI_BRAND', '仙肥鱼')


def tts(text, out):
    url = TTS_URL + urllib.parse.quote(text)
    with urllib.request.urlopen(url, timeout=120) as r:
        open(out, "wb").write(r.read())


def duration(p):
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def pick_bg(bg=None):
    if bg and os.path.exists(bg):
        return bg
    files = glob.glob(os.path.join(IMGDIR, "*.png")) + glob.glob(os.path.join(IMGDIR, "*.jpg"))
    random.shuffle(files)
    return files[0] if files else None


def wrap(draw, text, font, maxw):
    lines, cur = [], ""
    for ch in text:
        if ch == "\n":
            lines.append(cur); cur = ""
            continue
        if draw.textlength(cur + ch, font=font) > maxw and cur:
            lines.append(cur); cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def render(text, path, bg=None):
    canvas = Image.new("RGB", (W, H), (16, 22, 40))
    d = ImageDraw.Draw(canvas, "RGBA")
    # 背景：整屏模糊底
    src = pick_bg(bg)
    if src:
        try:
            base = Image.open(src).convert("RGB")
            s = max(W / base.width, H / base.height)
            base = base.resize((int(base.width * s) + 1, int(base.height * s) + 1))
            x = (base.width - W) // 2
            y = (base.height - H) // 2
            canvas.paste(base.crop((x, y, x + W, y + H)).filter(ImageFilter.GaussianBlur(24)), (0, 0))
            canvas = Image.eval(canvas, lambda v: int(v * 0.35))
        except Exception:
            pass
    d = ImageDraw.Draw(canvas, "RGBA")

    # 主图：顶部 58% 区域，保持比例，不遮挡
    if src:
        try:
            im = Image.open(src).convert("RGB")
            box_w, box_h = W - 90, int(H * 0.55)
            s = min(box_w / im.width, box_h / im.height)
            im = im.resize((int(im.width * s), int(im.height * s)))
            px = (W - im.width) // 2
            py = 80 + (box_h - im.height) // 2
            mask = Image.new("L", im.size, 0)
            ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.width, im.height], radius=26, fill=255)
            canvas.paste(im, (px, py), mask)
        except Exception:
            pass

    # 文字区：底部 34%，永远在图下面
    ty = int(H * 0.66)
    area_h = H - ty - 60
    size = 44
    lines = []
    while size >= 22:
        f = ImageFont.truetype(FONT, size)
        lines = wrap(d, text, f, W - 110)
        if len(lines) * int(size * 1.55) <= area_h - 40:
            break
        size -= 3
        lines = []
    if not lines:
        f = ImageFont.truetype(FONT, 22)
        lines = wrap(d, text, f, W - 110)
    f = ImageFont.truetype(FONT, size)
    lh = int(size * 1.55)
    th = lh * len(lines)
    d.rounded_rectangle([30, ty - 20, W - 30, ty + th + 24], radius=24, fill=(0, 0, 0, 165))
    for i, ln in enumerate(lines):
        tw = d.textlength(ln, font=f)
        d.text(((W - tw) // 2, ty + i * lh), ln, font=f, fill=(255, 255, 255, 255))
    ft = ImageFont.truetype(FONT, 26)
    d.text((40, 30), BRAND, font=ft, fill=(255, 255, 255, 220))
    canvas.save(path)


def main():
    a = json.loads(sys.argv[1])
    text = a["text"].strip()
    out = a.get("out") or os.path.join(OUTDIR, "vlog-%d.mp4" % os.getpid())
    outdir = os.path.dirname(out)
    if outdir:
        os.makedirs(outdir, exist_ok=True)
    tmp = tempfile.mkdtemp()
    audio = os.path.join(tmp, "a.mp3")
    tts(text, audio)
    total = duration(audio) or max(5.0, len(text) / 6.0)
    png = os.path.join(tmp, "one.png")
    render(text, png, a.get("bg"))
    r = subprocess.run([FFMPEG, "-y", "-loop", "1", "-i", png, "-i", audio, "-t", "%.2f" % total,
                        "-vf", "scale=720:1280,format=yuv420p",
                        "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage", "-threads", "2",
                        "-r", "25", "-c:a", "aac", "-shortest", out],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(json.dumps({"ok": False, "error": r.stderr[-400:]}, ensure_ascii=False))
        return
    print(json.dumps({"ok": True, "file": out, "seconds": round(total, 1)}, ensure_ascii=False))


main()