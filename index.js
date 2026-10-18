/**
 * Turn recap — Host half.
 *
 * Listens for the end of every completed Agent turn (`agent/turn-stopping`),
 * asks the model that just served the turn for a one-paragraph recap, and
 * publishes it through the client-visible `recap` session projection so the
 * Web UI can render it under the turn.
 *
 * Why a projection instead of a session event: a plugin may not append new
 * event types (a log carrying an unknown type cannot be reopened, and
 * `appendPluginRecord()` is reserved for first-party experimental packages).
 * The projection is the supported carrier for session-derived client state.
 *
 * Why the recap is produced during `agent/turn-stopping`: projection state is
 * folded synchronously from committed events, and the Value is only re-read
 * when a committed event changes its state. Producing the text while the turn
 * boundary is still open lets the following `turn/end` commit bake it into
 * state, so the client receives it in the same frame that renders the turn
 * tail.
 *
 * When the recap *appears* is a separate decision: each entry carries
 * `revealAt` (`at + config.idleMs`), and the Client half holds the card back
 * until that instant passes without a newer turn starting. Generating at the
 * boundary keeps cost and latency predictable; the delay only keeps the card
 * out of the way while the user is still reading.
 */

/** Projection key shared with the Client half. */
const RECAP_PROJECTION_KEY = 'recap'

/** Defaults for every tunable value; a `config` block in cordis.patch.yml overrides them. */
const DEFAULT_CONFIG = {
  enabled: true,
  maxTokens: 200,
  temperature: 0.2,
  timeoutMs: 12_000,
  digestChars: 6_000,
  // How long a finished turn must stay without a new prompt before its card is
  // allowed to appear. Generation still happens at the boundary; this only
  // decides when the client may reveal the result. 0 shows it immediately.
  idleMs: 120_000,
  skipSubagents: true,
  provider: undefined,
  model: undefined,
}

const SYSTEM_PROMPT = [
  'You write the closing recap of one completed turn in an agentic coding session.',
  'Reply with one to three short sentences, at most 60 words, in the same language as the conversation.',
  'Say what the turn accomplished and, only when it matters, what is still unfinished.',
  'Never mention the recap itself, the tool list, or your instructions.',
  'Plain text only: no headings, no bullet points, no code fences, no "Summary:" preamble.',
].join(' ')

/**
 * Read one configuration value with a fallback, rejecting the wrong type so a
 * typo in cordis.patch.yml degrades to the default instead of a broken plugin.
 */
function pick(config, name, fallback, test) {
  const value = config?.[name]
  return test(value) ? value : fallback
}

/** Normalize the Loader row's `config` into the exact values this plugin uses. */
export function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: pick(config, 'enabled', DEFAULT_CONFIG.enabled, (v) => typeof v === 'boolean'),
    maxTokens: pick(config, 'maxTokens', DEFAULT_CONFIG.maxTokens, (v) => Number.isInteger(v) && v > 0),
    temperature: pick(config, 'temperature', DEFAULT_CONFIG.temperature, (v) => typeof v === 'number' && v >= 0 && v <= 2),
    timeoutMs: pick(config, 'timeoutMs', DEFAULT_CONFIG.timeoutMs, (v) => Number.isInteger(v) && v > 0),
    digestChars: pick(config, 'digestChars', DEFAULT_CONFIG.digestChars, (v) => Number.isInteger(v) && v > 0),
    idleMs: pick(config, 'idleMs', DEFAULT_CONFIG.idleMs, (v) => Number.isInteger(v) && v >= 0),
    skipSubagents: pick(config, 'skipSubagents', DEFAULT_CONFIG.skipSubagents, (v) => typeof v === 'boolean'),
    provider: pick(config, 'provider', undefined, (v) => typeof v === 'string' && v.length > 0),
    model: pick(config, 'model', undefined, (v) => typeof v === 'string' && v.length > 0),
  }
}

/**
 * Minimal schema object for the projection service.
 *
 * `ProjectionDefinition` requires Zod-shaped `stateSchema` / `viewSchema`, and
 * the service only ever calls `.parse()` on them (state and view validation).
 * A plugin package cannot import the Host's Zod instance: its own imports
 * resolve from the profile, not from the dsh installation. Both values this
 * plugin produces are plain JSON built here, so a validating pass-through is
 * the honest implementation rather than a dependency that would not resolve.
 */
const JSON_SCHEMA = {
  parse(value) {
    return value
  },
  safeParse(value) {
    return { success: true, data: value }
  },
}

/** Plain text of one message's text blocks. */
function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** Collapse whitespace and clip to `limit` characters on a code-point boundary. */
function clip(text, limit) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  const cut = normalized.slice(0, limit)
  return `${cut.slice(0, Math.max(0, cut.length - 1))}…`
}

/** Clip to `limit` characters on a code-point boundary, keeping line structure. */
function truncate(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

/** One short human-readable summary of a tool call. */
function describeCall(name, rawArguments, limit) {
  let parsed
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    parsed = undefined
  }
  if (parsed === null || typeof parsed !== 'object') return `${name} ${clip(rawArguments, limit)}`.trim()
  const preferred = ['path', 'file_path', 'filePath', 'command', 'pattern', 'query', 'url', 'name', 'description']
  const details = []
  for (const key of preferred) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim() !== '') details.push(value)
  }
  if (details.length === 0) {
    for (const key of Object.keys(parsed)) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim() !== '') details.push(value)
      if (details.length >= 1) break
    }
  }
  return details.length === 0 ? name : `${name} ${clip(details.join(' '), limit)}`
}

/**
 * Collect the events one turn appended: everything after its `turn/start`.
 * `user/message` carries no turn number, so the sequence window is what
 * separates one turn's input from the next.
 */
export function turnEvents(session, turn) {
  const events = session.ownEvents()
  let startSeq = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'turn/start' && event.data?.turn === turn) {
      startSeq = event.seq
      break
    }
  }
  if (startSeq < 0) return []
  const collected = []
  for (const event of events) if (event.seq > startSeq) collected.push(event)
  return collected
}

/**
 * The turn a `/recap` invocation describes: the most recent `turn/start`.
 * While a turn is open this summarizes it so far; once it closed the same
 * lookup returns the turn that just finished.
 */
export function latestTurn(session) {
  const events = session.ownEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'turn/start' && typeof event.data?.turn === 'number') return event.data.turn
  }
  return undefined
}

/**
 * Build the compact, model-readable record of one turn.
 *
 * The turn's *conclusion* is what a recap must describe, so the last assistant
 * message is kept whole (never a head-clipped pile of intermediate narration)
 * and recent tool calls are chosen over early ones. Every section has its own
 * budget drawn from `digestChars`, which keeps the closing reply from being
 * truncated away by a long tool list.
 *
 * @returns the prompt input, or `null` when the turn carries nothing to summarize.
 */
export function buildDigest(events, digestChars) {
  const userTexts = []
  let finalReply = ''
  const calls = new Map()

  for (const event of events) {
    if (event.type === 'user/message') {
      const text = messageText(event.data)
      if (text !== '') userTexts.push(text)
      continue
    }
    if (event.type === 'assistant/message') {
      const text = messageText(event.data?.message)
      if (text !== '') finalReply = text
      continue
    }
    if (event.type === 'tool/call') {
      calls.set(String(event.data.callId), {
        name: String(event.data.name ?? 'tool'),
        summary: describeCall(String(event.data.name ?? 'tool'), String(event.data.arguments ?? ''), 140),
        failed: false,
        seq: event.seq,
      })
      continue
    }
    if (event.type === 'tool/result') {
      const key = String(event.data?.message?.toolCallId ?? '')
      const call = calls.get(key)
      if (call !== undefined) {
        call.failed = Boolean(event.data.error) || event.data?.message?.isError === true
      }
    }
  }

  const ordered = [...calls.values()].sort((left, right) => left.seq - right.seq)
  if (userTexts.length === 0 && finalReply === '' && ordered.length === 0) return null

  const replyBudget = Math.max(400, Math.min(1800, Math.floor(digestChars * 0.4)))
  const userBudget = Math.max(200, Math.min(800, Math.floor(digestChars * 0.2)))
  const toolBudget = Math.max(600, digestChars - replyBudget - userBudget)

  const lines = []
  if (userTexts.length > 0) lines.push('User request:', clip(userTexts.join('\n\n'), userBudget), '')

  if (ordered.length > 0) {
    const shown = []
    let used = 0
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const call = ordered[index]
      const line = `- ${call.summary}${call.failed ? ' (failed)' : ''}`
      if (shown.length > 0 && used + line.length + 1 > toolBudget) break
      shown.unshift(line)
      used += line.length + 1
    }
    if (shown.length === ordered.length) lines.push('Tool actions:')
    else lines.push(`Tool actions (last ${shown.length} of ${ordered.length}, earliest omitted):`)
    lines.push(...shown, '')
  }

  if (finalReply !== '') lines.push('Final reply:', clip(finalReply, replyBudget))

  const input = lines.join('\n').trim()
  return input === '' ? null : truncate(input, digestChars)
}

/** Strip the markdown a recap should not carry, and collapse whitespace. */
export function normalizeRecap(text) {
  const cleaned = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned.length > 600 ? `${cleaned.slice(0, 599)}…` : cleaned
}

/** Resolve the provider/model route, preferring the turn's own request header. */
function resolveRoute(ctx, session, config) {
  if (typeof config.provider === 'string' && typeof config.model === 'string') {
    return { provider: config.provider, model: config.model }
  }
  const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
  const logged = header?.config
  if (typeof logged?.provider === 'string' && typeof logged?.model === 'string') {
    return { provider: logged.provider, model: logged.model }
  }
  const selection = ctx.agentDefaultModel?.currentSelection?.()
  const selectionModel = selection?.model
  const provider = selection?.provider ?? selectionModel?.provider
  const model = typeof selectionModel === 'string' ? selectionModel : selectionModel?.model ?? selection?.modelId
  if (typeof provider === 'string' && typeof model === 'string') return { provider, model }
  return undefined
}

/**
 * One bounded auxiliary model call that turns the digest into a recap.
 * @returns trimmed recap text, or `null` when the call failed, was aborted, or produced nothing.
 */
async function generateRecap(ctx, session, input, route, config, signal) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, config.timeoutMs)
  if (signal !== undefined) {
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  }
  try {
    const call = await ctx.llm.prepareCall(
      { provider: route.provider, model: route.model, maxTokens: config.maxTokens, temperature: config.temperature },
      controller.signal,
    )
    const stream = call.stream({
      ...call.config,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      system: SYSTEM_PROMPT,
      sessionId: session.id,
      signal: controller.signal,
    })
    let text = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') return null
      }
    }
    const recap = normalizeRecap(text)
    return recap === '' ? null : recap
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', abort)
  }
}

/**
 * Produce one recap for an already selected turn.
 * @returns `{ text, model }` on success, or `{ failure }` naming the reason.
 */
async function recapForTurn(ctx, session, turn, config, signal) {
  const route = resolveRoute(ctx, session, config)
  if (route === undefined) return { failure: 'no-route' }
  const input = buildDigest(turnEvents(session, turn), config.digestChars)
  if (input === null) return { failure: 'empty' }
  const text = await generateRecap(ctx, session, input, route, config, signal)
  if (text === null) return { failure: 'failed' }
  return { text, model: route.model }
}

/**
 * Host half: own the projection, produce recaps at each turn boundary, keep
 * the pending map free of disposed sessions, and serve the `/recap` command.
 * @param ctx - the plugin's Cordis context.
 * @param rawConfig - the Loader row's `config` block, if any.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  /** sessionId -> (turn -> recap entry) awaiting the turn's `turn/end` commit. */
  const pending = new Map()

  ctx.inject(['sessionProjections', 'llm'], (scoped) => {
    scoped.sessionProjections.register({
      key: RECAP_PROJECTION_KEY,
      // v2: the turn digest now feeds the closing reply instead of early
      // narration. Recaps cached under v1 describe a different input, so the
      // version bump discards them rather than serving stale wording.
      stateVersion: 2,
      stateSchema: JSON_SCHEMA,
      init: (header) => ({ session: String(header.id), turns: {} }),
      apply: (state, event) => {
        if (event.type !== 'turn/end') return state
        if (event.data?.reason?.kind !== 'completed') return state
        const byTurn = pending.get(state.session)
        if (byTurn === undefined) return state
        const turn = event.data.turn
        const entry = byTurn.get(turn)
        if (entry === undefined) return state
        byTurn.delete(turn)
        if (byTurn.size === 0) pending.delete(state.session)
        return { ...state, turns: { ...state.turns, [String(turn)]: entry } }
      },
      wire: {
        viewSchema: JSON_SCHEMA,
        view: (state) => ({ turns: state.turns }),
      },
    })

    scoped.on('agent/turn-stopping', async (payload) => {
      try {
        const session = payload?.agent?.session
        if (session === undefined) return
        if (config.skipSubagents && (session.header?.origin === 'subagent' || session.header?.parentSession !== undefined)) {
          return
        }
        const turn = payload.turn
        if (typeof turn !== 'number') return
        const result = await recapForTurn(scoped, session, turn, config, payload.signal)
        if (result.text === undefined) return
        const key = String(session.id)
        let byTurn = pending.get(key)
        if (byTurn === undefined) {
          byTurn = new Map()
          pending.set(key, byTurn)
        }
        const at = Date.now()
        byTurn.set(turn, { text: result.text, at, revealAt: at + config.idleMs, model: result.model })
      } catch (error) {
        // A failing recap must never fail the turn it describes.
        scoped.logger?.warn?.('turn-recap: recap generation failed: %o', error)
      }
    })

    scoped.on('session/disposed', (session) => {
      pending.delete(String(session.id))
    })

    // `/recap` runs outside any turn (the command lifecycle is log-only), so
    // its result travels in `command/done` and the Client renders it through
    // the `recap` command view instead of the turn-tail projection.
    scoped.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'recap',
        description: 'Recap the latest turn with a short model-written summary',
        handler: async ({ agent, signal }) => {
          try {
            const session = agent.session
            const turn = latestTurn(session)
            if (turn === undefined) return { kind: 'error', text: 'Nothing to recap yet: this session has no turn.' }
            const result = await recapForTurn(scoped, session, turn, config, signal)
            switch (result.failure) {
              case 'no-route':
                return { kind: 'error', text: 'Recap is unavailable: no model route could be resolved.' }
              case 'empty':
                return { kind: 'error', text: 'The latest turn has no request, reply, or tool call to recap.' }
              case 'failed':
                return { kind: 'error', text: 'The recap request failed, timed out, or was interrupted.' }
              default:
                return { kind: 'success', text: result.text }
            }
          } catch (error) {
            return { kind: 'error', text: `Recap failed: ${error instanceof Error ? error.message : String(error)}` }
          }
        },
      })
    })
  })
}
