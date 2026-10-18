window.__ModuleLoader__.load({
  id: '@local/dsh-turn-recap',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'turn-recap'
    /** Host projection key owned by this bundle's Host half. */
    const PROJECTION = 'recap'
    /** Command whose lifecycle row renders through the custom card below. */
    const COMMAND = 'recap'

    /** Component-local styles; render as an element so unmounting removes them. */
    const CSS = [
      '.dsh-turn-recap{display:flex;flex-direction:column;gap:6px;margin-top:8px;padding:10px 12px;',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);',
      'box-sizing:border-box;min-width:0;}',
      '.dsh-turn-recap__head{display:flex;align-items:center;gap:6px;min-width:0;',
      'color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:16px;}',
      '.dsh-turn-recap__icon{display:inline-flex;flex:0 0 auto;color:var(--dsw-alias-brand-primary);}',
      '.dsh-turn-recap__title{flex:1 1 auto;min-width:0;letter-spacing:.01em;}',
      '.dsh-turn-recap__meta{flex:0 1 auto;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:var(--dsw-alias-label-secondary);font-weight:400;opacity:.75;}',
      '.dsh-turn-recap__text{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.65;',
      'white-space:pre-wrap;overflow-wrap:anywhere;}',
      '.dsh-turn-recap__text[data-error]{color:var(--dsw-alias-state-error-primary);}',
      '.dsh-turn-recap__text[data-pending]{color:var(--dsw-alias-label-secondary);font-style:italic;}',
    ].join('')

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      title: '本轮小结',
      pending: '正在生成小结…',
      failed: '未能生成小结',
    }

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      title: 'Turn recap',
      pending: 'Generating a recap…',
      failed: 'No recap available',
    }

    /** Four-point spark, drawn in the current text color. */
    function Sparkle() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'currentColor', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M8 1.5l1.35 3.4a2 2 0 0 0 1.15 1.15L13.9 7.4l-3.4 1.35a2 2 0 0 0-1.15 1.15L8 13.3l-1.35-3.4a2 2 0 0 0-1.15-1.15L2.1 7.4l3.4-1.35A2 2 0 0 0 6.65 4.9z',
        }),
        h('circle', { cx: 12.6, cy: 12.4, r: 1.2, opacity: 0.55 }),
      )
    }

    /** Shared card chrome: icon, title, trailing meta, and one body line. */
    function Card({ label, meta, body, state }) {
      return h(
        'section',
        { className: 'dsh-turn-recap', 'aria-label': label },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dsh-turn-recap__head' },
          h('span', { className: 'dsh-turn-recap__icon' }, h(Sparkle, null)),
          h('span', { className: 'dsh-turn-recap__title' }, label),
          typeof meta === 'string' && meta !== '' ? h('span', { className: 'dsh-turn-recap__meta' }, meta) : null,
        ),
        h('p', { className: 'dsh-turn-recap__text', 'data-error': state === 'error' || undefined, 'data-pending': state === 'pending' || undefined }, body),
      )
    }

    /**
     * The closing turn's number.
     *
     * The slot hands this entry a `TurnLocation`, not a bare number: reading it
     * as a turn number silently produced `"[object Object]"` and every lookup
     * missed. Accept either shape, and fall back through the plausible numeric
     * fields the location carries.
     * @param turn - owner `TurnLocation` or a plain turn number.
     * @returns the turn number, or undefined when nothing numeric is found.
     */
    function turnNumberOf(turn) {
      if (typeof turn === 'number' && Number.isFinite(turn)) return turn
      if (turn !== null && typeof turn === 'object') {
        for (const field of ['turn', 'index', 'number', 'id']) {
          const value = turn[field]
          if (typeof value === 'number' && Number.isFinite(value)) return value
          if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value)
        }
      }
      const numeric = Number(turn)
      return Number.isFinite(numeric) ? numeric : undefined
    }

    /**
     * One in-flight direct read per session.
     *
     * The pushed `recap` projection is the live channel, but a page can end up
     * holding a stale copy: the Host only broadcasts a unit when its view
     * changes, so a client that re-seeded from an older baseline has nothing to
     * correct it. When the pushed value has no entry for a closed turn, the
     * component asks the Host directly and renders from that answer.
     */
    const projectionReads = new Map()

    /** Direct read of this session's recap projection, deduplicated per page. */
    function readProjectionTurns(sessionId, loadRecap) {
      const existing = projectionReads.get(sessionId)
      if (existing !== undefined) return existing
      const request = Promise.resolve()
        .then(() => loadRecap())
        .then(
          (value) => (value !== null && typeof value === 'object' ? value : undefined),
          () => undefined,
        )
        .then((value) => {
          projectionReads.delete(sessionId)
          return value
        })
      projectionReads.set(sessionId, request)
      return request
    }

    /**
     * Closing-turn recap over the Host's `recap` projection.
     *
     * The Host wrote the text before the turn boundary committed. Whether the
     * card may show is decided by wall-clock time — `revealAt`, the end of the
     * configured quiet window — and by the Host's `superseded` mark, which a
     * prompt arriving inside that window sets. Nothing here holds a one-shot
     * timer: a throttled or missed timer would have hidden the card for good,
     * so the rule is re-evaluated on every render and a ticker only nudges the
     * page while the window is still running.
     * @param props - closing turn, projection hook, and localized copy.
     * @returns the recap row, or null while it is held back or absent.
     */
    function TurnRecap(props) {
      const turn = props.turn
      const useProjection = props.useProjection
      const loadRecap = props.loadRecap
      const t = props.t
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const projection = typeof useProjection === 'function' ? useProjection(PROJECTION) : undefined
      const pushedTurns = projection !== null && typeof projection === 'object' ? projection.turns : undefined
      const turnNumber = turnNumberOf(turn)
      const pickEntry = (map) =>
        map !== null && typeof map === 'object' && turnNumber !== undefined ? map[String(turnNumber)] : undefined
      const [readTurns, setReadTurns] = React.useState(undefined)
      const pushedEntry = pickEntry(pushedTurns)
      const entry = pushedEntry ?? pickEntry(readTurns)
      const ready = entry !== null && typeof entry === 'object' && typeof entry.text === 'string' && entry.text !== ''
      // An entry cached before reveal timing existed has no `revealAt`; 0 keeps
      // it visible instead of hiding history behind a window it predates.
      const revealAt = ready && typeof entry.revealAt === 'number' ? entry.revealAt : 0
      const superseded = ready && entry.superseded === true
      const due = ready && !superseded && Date.now() >= revealAt
      const [, tick] = React.useState(0)
      const attemptedRead = React.useRef(false)

      React.useEffect(() => {
        if (ready || attemptedRead.current || typeof loadRecap !== 'function' || sessionId === '') return undefined
        attemptedRead.current = true
        let alive = true
        readProjectionTurns(sessionId, loadRecap).then((value) => {
          if (alive && value !== undefined) setReadTurns(value)
        })
        return () => {
          alive = false
        }
      }, [ready, loadRecap, sessionId])

      React.useEffect(() => {
        if (ready === false || superseded || due) return undefined
        const timer = setInterval(() => tick((value) => value + 1), 1000)
        return () => clearInterval(timer)
      }, [ready, superseded, due])

      if (!due) return null
      const label = typeof t === 'function' ? t('title') : 'Turn recap'
      const model = typeof entry.model === 'string' && entry.model !== '' ? entry.model : null
      return h(Card, { label, meta: model, body: entry.text, state: 'ok' })
    }

    /**
     * `/recap` lifecycle row. The command runs outside any turn, so its result
     * arrives as `command/done` text rather than a projection value.
     * @param props - command node (`outcome` is null until it settles) and copy.
     * @returns the recap row for the running, failed, or settled command.
     */
    function RecapCommandCard(props) {
      const t = props.t
      const node = props.node
      const outcome = node !== null && typeof node === 'object' ? node.outcome ?? null : null
      const label = typeof t === 'function' ? t('title') : 'Turn recap'
      const failed = typeof t === 'function' ? t('failed') : 'No recap available'
      if (outcome === null) {
        return h(Card, {
          label,
          meta: `/${COMMAND}`,
          body: typeof t === 'function' ? t('pending') : 'Generating a recap…',
          state: 'pending',
        })
      }
      const text = typeof outcome.text === 'string' && outcome.text !== '' ? outcome.text : failed
      return h(Card, {
        label,
        meta: `/${COMMAND}`,
        body: text,
        state: outcome.kind === 'error' ? 'error' : 'ok',
      })
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the dictionaries, the completed-turn entry, and the command view.
       * @param ctx - client root context.
       */
      apply(ctx) {
        // A previous diagnostic build wrote into the window title; clear it so
        // the shell can own the title again.
        try {
          if (typeof document !== 'undefined' && String(document.title).startsWith('RCDIAG')) document.title = ''
        } catch {}
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'turn-recap: dictionaries')
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: '@local/dsh-turn-recap',
              order: 40,
              locale: NS,
              // Repair path for a stale pushed copy: read the session's exact
              // projections straight from the Host when the entry is missing.
              // Both hops stay optional, so a composition without the session
              // remote still loads this entry.
              inject: (sessionId) => ({
                loadRecap: async () => {
                  const sessionRemote = ctx.remote?.session
                  if (sessionRemote === undefined) return undefined
                  const result = await sessionRemote.projections({ sessionId })
                  if (result === null || typeof result !== 'object' || result.ok !== true) return undefined
                  const value = result.value
                  if (value === null || typeof value !== 'object' || value.kind !== 'sequenced') return undefined
                  const recap = value.values?.[PROJECTION]
                  return recap !== null && typeof recap === 'object' ? recap.turns : undefined
                },
              }),
            },
            TurnRecap,
          ),
        )
        ctx.slots.inject('conversation.chat.commandview', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.commandview',
              key: COMMAND,
              locale: NS,
            },
            RecapCommandCard,
          ),
        )
      },
    }
  },
})
