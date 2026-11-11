# B 站学习 / vlog / 投稿

B 站能力分两块：

```text
modules/bili-study          读字幕、弹幕、热评、写学习笔记、做 vlog、可选投稿/互动
tools/bili-data/            扫码登录、vlog 渲染、视频投稿脚本
```

## 1. `bili-study` 模块

默认配置在 `conf/config.example.json` 的 `ext.bili-study`：

```json
{
  "enabled": true,
  "dailyMax": 10,
  "autoLearnHours": 6,
  "wakeHour": 8,
  "sleepHour": 23,
  "browseMax": 6,
  "browseChance": 0.35,
  "sharePerDay": 2,
  "subtitleChars": 5000,
  "commentsCount": 15,
  "topics": "AI,机器人,有意思的知识",
  "commentChance": 0.1,
  "replyComments": false
}
```

工具：

| 工具 | 作用 | 是否写操作 |
|---|---|---|
| `bili_search` | 搜视频 | 否 |
| `bili_watch` | 读字幕/弹幕/热评，写学习笔记 | 否 |
| `bili_subtitle` | 只取字幕原文（省钱） | 否 |
| `bili_recall` | 翻学过的内容 | 否 |
| `bili_report` | 汇总学习报告 | 否 |
| `make_vlog` | 生成竖屏 vlog，只给主人预览 | 否（本地生成） |
| `bili_my_videos` | 看自己视频的评论情况 | 否 |
| `bili_publish` | 投稿视频，必须 `confirm=true` | 是 |
| `bili_like` | 点赞/取消点赞 | 是 |
| `bili_follow` | 关注 UP 主 | 是 |
| `bili_comment` | 发评论（过隐私检查） | 是 |
| `bili_dm` | 发私信（过隐私检查） | 是 |

写操作需要 `tools/bili-data/cookies.txt`；默认只在主人私聊挂载。`bili_publish` 每天最多 2 条，且必须显式 `confirm`。自动回复自己视频下的评论默认关闭（`replyComments=false`）；`/vlog`、`做视频`、`发视频`、`录一段` 会触发固定 vlog 流程，不靠模型选工具。

## 2. `tools/bili-data`

| 文件 | 作用 |
|---|---|
| `login.mjs` | 扫码登录，本地生成二维码，写 `cookies.txt`（600） |
| `vlog.py` | 文字 → 豆包 TTS + 字幕 + 配图背景 → 720×1280 MP4（顶部主图 + 底部文字） |
| `upload.py` | 用 `bilibili-api-python` 投稿（自动生成封面，支持 dry 预上传） |
| `my_videos.py` | 列出自己账号的视频与评论数 |

安装：

```bash
cd tools/bili-data
npm install
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
sudo apt install -y ffmpeg fonts-wqy-zenhei
```

登录：

```bash
BILI_DATA_DIR=/opt/bili-data node login.mjs
# 扫 /opt/bili-data/login.png
```

详细参数见 [tools/bili-data/README.md](../tools/bili-data/README.md)。

## 3. 安全建议

- `cookies.txt` 等同账号控制权：600 权限、不要进 Git、不要发聊天、不要放公开目录。
- 建议用独立小号；不要把主号 Cookie 放在共享服务器上。
- 写操作先小规模测试；`bili_publish` 先本地预览再 `confirm`。
- 自动回复评论默认关闭；打开后每 10 分钟检查一次，第一条 100%、其余 70%，每次最多 3 条。建议先只开 `bili_my_videos` 观察。
- B 站自动化可能违反平台条款，存在风控/封号风险，风险自负。

## 4. 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `cookie file not found` | 没登录或路径不对 | 跑 `login.mjs`，确认 `BILI_COOKIE_FILE` |
| vlog 报字体错误 | 没装中文字体 | `apt install fonts-wqy-zenhei` |
| vlog 报 ffmpeg 错误 | 没装 ffmpeg | `apt install ffmpeg` |
| `bili_publish` 返回缺少模块 | 没装 `bilibili-api-python` | `.venv/bin/pip install -r requirements.txt` |
| 笔记没有模型总结 | 没有 Qwen key | 在 `$DSH_HOME/.credentials.yaml` 配 `QWEN_TOKEN_PLAN_CN_API_KEY`；没有就只存原文 |

## 5. 与官方内置 B 站模块的关系

`aurabot-src` 里还有一个内置 `bili` 模块（刷视频/点赞/评论）。参考配置把顶层 `bili.enabled` 设为 `false`；本仓库的 `bili-study` 是独立的用户模块，默认只读优先，写操作需要登录和确认。
