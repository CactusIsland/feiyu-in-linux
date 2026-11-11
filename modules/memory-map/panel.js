// 记忆图谱面板 —— 记忆 / 关系 / 约定 / 快忘记
// 运行环境：面板会传入 React、h、ui、call。最后 return 一个 React 组件。

const { useState, useEffect } = React

const WEIGHT_LABEL = { never: '永不遗忘', slow: '慢慢淡', normal: '正常', fast: '可忘' }
const WEIGHT_COLOR = { never: '#b8860b', slow: '#4a90e2', normal: '#888', fast: '#c45' }

const short = (text, n) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

return function Panel({ settings, save, toast }) {
  const [map, setMap] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setBusy(true)
    try { setMap(await call('/map')) } catch (error) { toast && toast('加载失败：' + (error.message || error)) } finally { setBusy(false) }
  }

  useEffect(() => { load() }, [])

  const pin = async (item) => {
    const pinned = !(map && map.pinnedIds || []).includes(item.id)
    try {
      await call('/pin', { id: item.id, pinned })
      toast && toast(pinned ? '已设为永不遗忘' : '已取消保护')
      await load()
    } catch (error) { toast && toast('操作失败：' + (error.message || error)) }
  }

  const KINDS = ['熟人', '群友', '陌生人', '主人']
  const nextKind = (kind) => KINDS[(KINDS.indexOf(kind) + 1) % KINDS.length]
  const editPerson = async (p) => {
    try {
      await call('/person', { key: p.key, kind: nextKind(p.kind) })
      toast && toast(`${p.name} 的关系改成「${nextKind(p.kind)}」`)
      await load()
    } catch (error) { toast && toast('改关系失败：' + (error.message || error)) }
  }

  const badge = (w) => h('span', {
    key: 'w',
    style: {
      display: 'inline-block',
      padding: '1px 6px',
      marginLeft: '6px',
      borderRadius: '8px',
      fontSize: '11px',
      color: '#fff',
      background: WEIGHT_COLOR[w] || '#888',
    },
  }, WEIGHT_LABEL[w] || w)

  const itemRow = (item, section, allowPin = true) => {
    const pinned = Boolean(map && (map.pinnedIds || []).includes(item.id))
    return h('div', {
      key: section + ':' + item.id,
      style: { padding: '8px 0', borderBottom: '1px solid #eee' },
    },
      h('div', { style: { fontSize: '13px', lineHeight: 1.45 } }, short(item.text, 90), badge(item.weight)),
      h('div', { className: 'ab-muted ab-small', style: { marginTop: '2px' } },
        `${item.when || ''}${item.about ? ' · ' + item.about : ''}${item.retention !== undefined ? ' · 清晰度 ' + item.retention : ''}`),
      allowPin ? h('div', { style: { marginTop: '4px' } },
        h(ui.Btn, { onClick: () => pin(item), style: { fontSize: '11px', padding: '2px 8px' } },
          pinned ? '取消保护' : (item.weight === 'never' ? '已保护' : '设为永不遗忘')),
      ) : null,
    )
  }

  const peopleCard = (people) => h(ui.Card, { title: '人物', key: 'people' },
    people && people.length
      ? people.map((p) => h('div', {
        key: 'p:' + p.key,
        style: { padding: '8px 0', borderBottom: '1px solid #eee' },
      },
        h('div', { style: { fontSize: '13px' } },
          `${p.name}（${p.kind}）${p.count} 条${p.lastText ? ' · ' + short(p.lastText, 34) : ''}`,
          badge(p.weight)),
        p.note ? h('div', { className: 'ab-muted ab-small', style: { marginTop: '2px' } }, p.note) : null,
        p.key && p.key.indexOf('owner:') === 0
          ? null
          : h('div', { style: { marginTop: '4px' } },
            h(ui.Btn, { onClick: () => editPerson(p), style: { fontSize: '11px', padding: '2px 8px' } },
              `改关系：${nextKind(p.kind)}`)),
      ))
      : h('div', { className: 'ab-muted ab-small' }, '还没有关于别人的记忆'),
  )

  const sectionCard = (title, items, emptyText, key, allowPin = true) => h(ui.Card, { title, key },
    items && items.length
      ? items.map((item) => itemRow(item, key, allowPin))
      : h('div', { className: 'ab-muted ab-small' }, emptyText || '还没有'),
  )

  const graph = (data) => {
    const people = (data.people || []).slice(0, 12)
    const cx = 230
    const cy = 150
    const r = 104
    const nodes = people.map((p, i) => {
      const a = -Math.PI / 2 + (people.length ? i * 2 * Math.PI / people.length : 0)
      return {
        p,
        x: cx + r * Math.cos(a),
        y: cy + r * Math.sin(a),
      }
    })
    const colorOf = (kind) => kind === '主人' ? '#e0a800' : kind === '群友' ? '#4a90e2' : '#5aa469'
    return h('svg', { width: '100%', height: 300, viewBox: '0 0 460 300', style: { maxWidth: '460px' } },
      nodes.map((n) => h('line', {
        key: 'l:' + n.p.key,
        x1: cx, y1: cy, x2: n.x, y2: n.y,
        stroke: '#d0d7de', strokeWidth: 1.5,
      })),
      nodes.map((n) => h('g', { key: 'g:' + n.p.key },
        h('circle', {
          cx: n.x, cy: n.y, r: 17,
          fill: '#fff', stroke: colorOf(n.p.kind), strokeWidth: 2,
        }),
        h('text', {
          x: n.x, y: n.y + 4, textAnchor: 'middle', fontSize: 10, fill: '#333',
        }, short(n.p.name, 4)),
        h('text', {
          x: n.x, y: n.y + 30, textAnchor: 'middle', fontSize: 9, fill: '#888',
        }, n.p.kind + ' · ' + n.p.count),
        h('text', {
          x: (cx + n.x) / 2, y: (cy + n.y) / 2 - 3, textAnchor: 'middle', fontSize: 8, fill: '#aaa',
        }, n.p.kind),
      )),
      h('circle', { cx, cy, r: 28, fill: '#e8f3ff', stroke: '#4a90e2', strokeWidth: 2 }),
      h('text', { x: cx, y: cy + 4, textAnchor: 'middle', fontSize: 12, fill: '#235' }, '大肥鱼'),
    )
  }

  if (!map) return h(ui.Card, { title: '记忆图谱' }, h('div', { className: 'ab-muted' }, busy ? '正在加载…' : '没有数据'))

  const stats = map.stats || {}
  const stat = (label, value) => h('div', {
    key: label,
    style: { display: 'inline-block', minWidth: '92px', padding: '8px 10px' },
  },
    h('div', { style: { fontSize: '18px', fontWeight: 600 } }, String(value ?? 0)),
    h('div', { className: 'ab-muted ab-small' }, label),
  )

  return h('div', null,
    h(ui.Card, { title: '记忆图谱' },
      h('div', { className: 'ab-muted ab-small', style: { marginBottom: '8px' } },
        '一张只在你本机看的图：她记得谁、哪些是约定、哪些快忘了。点「永不遗忘」会写进保护名单，记忆压缩不会再动它。'),
      h('div', null,
        stat('有效记忆', stats.live),
        stat('人物', stats.people),
        stat('永不遗忘', stats.never),
        stat('快忘记', stats.fading),
        stat('过时', stats.outdated),
      ),
      h('div', { style: { marginTop: '8px' } },
        h(ui.Btn, { onClick: load, disabled: busy }, busy ? '刷新中…' : '刷新')),
      h('div', { style: { marginTop: '10px' } }, graph(map)),
    ),
    peopleCard(map.people),
    sectionCard('约定 / 第一次', map.promises, '还没有约定或第一次', 'promises'),
    sectionCard('偏好', map.preferences, '还没有明确的喜好', 'preferences'),
    sectionCard('最近的事', map.events, '还没有经历或日记', 'events'),
    sectionCard('快忘记', map.fading, '没有快忘记的记忆', 'fading'),
  )
}
