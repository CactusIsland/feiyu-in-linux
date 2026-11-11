// 面板 —— 给大肥鱼做一个网页前端（Aurabot 扩展接口 v1）
//
// 地址：<DSH地址>/aurabot/api/ext/dashboard/
// 页面本身是同源的，所以直接 fetch 插件自带的 /aurabot/api/*，不需要额外后端。

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'dashboard',
  name: '网页面板',
  version: '1.0.0',
  api: 1,
  description: '一个大肥鱼的网页前端：状态、记忆、模块、语音、空间、日志',

  setup(api) {
    const page = () => readFileSync(join(HERE, 'page.html'), 'utf8')

    api.route('/', async (req, res) => {
      api.core.http.send(res, 200, page(), 'text/html; charset=utf-8')
    })

    api.route('/data', async () => {
      const hub = api.core.hub
      const state = (() => {
        try {
          return {
            version: api.config().version || '',
            onebot: hub?.onebot?.state || '',
            sessions: Object.keys(hub?.sessions?.() || {}).length,
          }
        } catch (error) {
          return { error: String(error.message || error) }
        }
      })()
      return { ok: true, state }
    })

    api.log.info('网页面板已挂上：/aurabot/api/ext/dashboard/')
    return {}
  },
}
