# bili-data — B 站登录 / vlog / 投稿脚本

配合 `modules/bili-study` 使用。`login.mjs` 扫码登录，`vlog.py` 生成竖屏 vlog，`upload.py` 投稿。

> [!WARNING]
> `cookies.txt` 等同于 B 站账号控制权。不要提交到 Git、不要发聊天、不要放公开目录。写操作（投稿/点赞/关注/评论/私信）有账号风控风险，建议只用独立小号、低频、先预览再发。

## 文件

| 文件 | 作用 |
|---|---|
| `login.mjs` | B 站扫码登录，本地生成 `login.png`，成功后写 `cookies.txt`（600） |
| `vlog.py` | 文字 → 豆包 TTS + 字幕 + 配图背景 → 竖屏 MP4 |
| `upload.py` | 用 `bilibili-api-python` 投稿视频 |
| `package.json` | `login.mjs` 的 `qrcode` 依赖 |
| `requirements.txt` | `vlog.py` / `upload.py` 的 Python 依赖 |

## 安装

```bash
cd tools/bili-data
npm install
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
sudo apt install -y ffmpeg fonts-wqy-zenhei
```

## 登录

```bash
BILI_DATA_DIR=/opt/bili-data node login.mjs
# 用 B 站 App 扫 /opt/bili-data/login.png
```

成功后：

```text
/opt/bili-data/cookies.txt   (600)
```

`cookies_raw.txt` 是旧版路径，模块会兼容读取；新部署用 `cookies.txt`。

## vlog

```bash
/opt/bili-data/.venv/bin/python vlog.py '{"text":"今天想说的内容","out":"/opt/bili-data/videos/test.mp4"}'
```

依赖：

- 本机 TTS 接口（默认 `http://127.0.0.1:5043/aurabot/api/ext/tts-doubao/tts?text=`）
- `ffmpeg` / `ffprobe`
- `fonts-wqy-zenhei`
- 配图背景从 `$DSH_HOME/plugins-data/aurabot/imagegen` 随机取；没有就用纯色背景

## 投稿

```bash
/opt/bili-data/.venv/bin/python upload.py '{"file":"/opt/bili-data/videos/test.mp4","title":"标题","desc":"简介","tags":["日常"],"tid":21}'
```

`bili-study` 模块里的 `bili_publish` 会调用它，必须传 `confirm=true`；标题/简介/标签会先过隐私检查，每天最多 2 条。

## 模块环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BILI_DATA_DIR` | `/opt/bili-data` | 脚本与数据目录 |
| `BILI_COOKIE_FILE` | `$BILI_DATA_DIR/cookies.txt` | Cookie 文件 |
| `BILI_PYTHON` | `$BILI_DATA_DIR/.venv/bin/python` | 运行 vlog/upload 的 Python |
| `BILI_IMAGE_DIR` | `$DSH_HOME/plugins-data/aurabot/imagegen` | vlog 背景图目录 |
| `BILI_TTS_URL` | 本机豆包 TTS | vlog 配音接口 |
| `SEND_MEDIA_BIN` | 空 | 可选：自定义发视频脚本；不填用 `api.sendFile` |

## 安全

- Cookie 文件权限 600；目录 700；不要进 Git。
- 只在主人私聊挂工具；写操作需要登录态。
- 先 vlog 预览，再手动确认投稿；不要自动高频评论/关注/私信。
- B 站自动化可能违反平台条款；用独立小号，风险自负。
