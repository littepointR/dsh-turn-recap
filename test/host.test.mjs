/** Scratch harness: exercises the Host half without installing the bundle. */
const mod = await import('../index.js')

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

// ---------------------------------------------------------------- resolveConfig
const defaults = mod.resolveConfig(undefined)
check('defaults.enabled', defaults.enabled, true)
check('defaults.maxTokens', defaults.maxTokens, 200)
check('bad type falls back', mod.resolveConfig({ maxTokens: 'lots', timeoutMs: -1 }).maxTokens, 200)
check('override', mod.resolveConfig({ maxTokens: 64, enabled: false }).maxTokens, 64)
check('override.enabled', mod.resolveConfig({ enabled: false }).enabled, false)

// ---------------------------------------------------------------- turn events
const events = [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { role: 'user', content: [{ type: 'text', text: 'older turn' }] } },
  { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 4, data: { turn: 2 } },
  { type: 'user/message', seq: 5, data: { role: 'user', content: [{ type: 'text', text: 'add a recap plugin' }] } },
  {
    type: 'assistant/message',
    seq: 6,
    data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  },
  { type: 'tool/call', seq: 7, data: { turn: 2, step: 1, callId: 'c1', name: 'write', arguments: '{"path":"index.js"}' } },
  { type: 'tool/result', seq: 8, data: { turn: 2, step: 1, message: { role: 'tool', toolCallId: 'c1' } } },
  { type: 'tool/call', seq: 9, data: { turn: 2, step: 1, callId: 'c2', name: 'pwsh', arguments: '{"command":"pnpm test"}' } },
  { type: 'tool/result', seq: 10, data: { turn: 2, step: 1, message: { role: 'tool', toolCallId: 'c2' }, error: { name: 'x', code: 'y' } } },
]
const session = { ownEvents: () => events }
const scoped = mod.turnEvents(session, 2)
check('turnEvents seq window', scoped.map((e) => e.seq), [5, 6, 7, 8, 9, 10])
check('turnEvents missing turn', mod.turnEvents(session, 9), [])

const digest = mod.buildDigest(scoped, 6000)
console.log('--- digest ---\n' + digest + '\n--------------')
check('digest has user text', digest.includes('add a recap plugin'), true)
check('digest has final reply', digest.includes('Final reply:') && digest.includes('Done.'), true)
check('digest marks failure', digest.includes('pwsh pnpm test (failed)'), true)
check('digest lists successful call', digest.includes('- write index.js'), true)
check('digest excludes other turns', digest.includes('older turn'), false)
check('empty turn has no digest', mod.buildDigest([], 6000), null)

// The closing reply wins over intermediate narration.
const longTurn = [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { role: 'user', content: [{ type: 'text', text: 'build it' }] } },
  { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'NEXT STEP IS TO BUILD' }] } } },
  { type: 'assistant/message', seq: 4, data: { turn: 1, step: 9, message: { role: 'assistant', content: [{ type: 'text', text: 'Built and installed the plugin.' }] } } },
]
const longDigest = mod.buildDigest(longTurn, 6000)
check('only the last assistant message is used', longDigest.includes('NEXT STEP IS TO BUILD'), false)
check('the closing reply is used', longDigest.includes('Built and installed the plugin.'), true)

// A long tool list must not push the closing reply out of the digest.
const manyTools = [{ type: 'turn/start', seq: 1, data: { turn: 1 } }]
for (let index = 0; index < 80; index += 1) {
  manyTools.push({ type: 'tool/call', seq: 10 + index * 2, data: { turn: 1, step: 1, callId: `c${index}`, name: 'read', arguments: '{"path":"src/some/quite/long/path/number/' + index + '.ts"}' } })
  manyTools.push({ type: 'tool/result', seq: 11 + index * 2, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: `c${index}` } } })
}
manyTools.push({ type: 'assistant/message', seq: 500, data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'All files were reviewed and the conclusion is reached.' }] } } })
const crowdedDigest = mod.buildDigest(manyTools, 3000)
check('crowded digest stays within budget', crowdedDigest.length <= 3000, true)
check('crowded digest keeps the closing reply', crowdedDigest.includes('the conclusion is reached'), true)
check('crowded digest notes omissions', crowdedDigest.includes('earliest omitted'), true)
check('crowded digest keeps the newest call', crowdedDigest.includes('/79.ts'), true)

// ---------------------------------------------------------------- normalizeRecap
check('drops fenced code', mod.normalizeRecap('```js\ncode\n```\n**done**'), 'done')
check('drops heading marks', mod.normalizeRecap('## Summary\nFinished the plugin.'), 'Summary\nFinished the plugin.')
check('empty stays empty', mod.normalizeRecap('   '), '')

// ---------------------------------------------------------------- fake runtime
const liveSession = (id, header = {}) => ({
  ...session,
  id,
  header,
  requestHeader: () => ({ config: { provider: 'p', model: 'm1' } }),
})

function createRuntime({ llm } = {}) {
  const handlers = new Map()
  const runtime = {
    definition: undefined,
    llm:
      llm ??
      {
        async prepareCall(config) {
          return {
            config: { provider: config.provider, model: config.model, maxTokens: config.maxTokens },
            stream() {
              return (async function* () {
                yield { type: 'text-delta', index: 0, text: '**Built** the plugin ' }
                yield { type: 'text-delta', index: 0, text: 'and wired the projection.' }
                yield { type: 'finish', reason: { kind: 'stop' } }
              })()
            },
          }
        },
      },
    logger: { warn() {} },
    sessionProjections: {
      register(definition) {
        runtime.definition = definition
      },
    },
    command: undefined,
    commands: {
      register(definition) {
        runtime.command = definition
        return () => {}
      },
    },
    on(name, listener) {
      handlers.set(name, listener)
      return () => handlers.delete(name)
    },
    inject(names, callback) {
      const available = new Set(['sessionProjections', 'llm', 'commands'])
      if (names.every((name) => available.has(name))) callback(runtime)
    },
    fire(name, payload) {
      return handlers.get(name)(payload)
    },
  }
  return runtime
}

// ---------------------------------------------------------------- happy path
const runtime = createRuntime()
mod.apply(runtime, {})
check('projection registered', runtime.definition?.key, 'recap')

let state = runtime.definition.init({ id: 's1' })
check('init state', state.turns, {})

await runtime.fire('agent/turn-stopping', { agent: { session: liveSession('s1') }, turn: 2, signal: new AbortController().signal })
check('recap hidden before turn/end', runtime.definition.wire.view(state).turns, {})

state = runtime.definition.apply(state, { type: 'turn/end', seq: 11, data: { turn: 2, reason: { kind: 'completed' } } })
const published = runtime.definition.wire.view(state)
check('recap visible after turn/end', Object.keys(published.turns), ['2'])
check('recap text normalized', published.turns['2'].text, 'Built the plugin and wired the projection.')
check('recap carries model', published.turns['2'].model, 'm1')

await runtime.fire('agent/turn-stopping', { agent: { session: liveSession('s1') }, turn: 2, signal: new AbortController().signal })
check('aborted turn unchanged', runtime.definition.apply(state, { type: 'turn/end', seq: 12, data: { turn: 2, reason: { kind: 'aborted' } } }), state)

await runtime.fire('agent/turn-stopping', { agent: { session: liveSession('s2', { origin: 'subagent' }) }, turn: 2, signal: new AbortController().signal })
check('subagent turn unchanged', runtime.definition.apply(state, { type: 'turn/end', seq: 13, data: { turn: 2, reason: { kind: 'completed' } } }), state)

// A second session keeps its own recap entries.
await runtime.fire('agent/turn-stopping', { agent: { session: liveSession('s2') }, turn: 2, signal: new AbortController().signal })
let otherState = runtime.definition.init({ id: 's2' })
otherState = runtime.definition.apply(otherState, { type: 'turn/end', seq: 14, data: { turn: 2, reason: { kind: 'completed' } } })
check('session isolation', Object.keys(runtime.definition.wire.view(otherState).turns), ['2'])
check('session isolation does not leak', runtime.definition.wire.view(state).turns['2'].text.startsWith('Built'), true)

// ---------------------------------------------------------------- failures
const failing = createRuntime({
  llm: {
    async prepareCall() {
      throw new Error('provider offline')
    },
  },
})
mod.apply(failing, {})
let threw = false
try {
  await failing.fire('agent/turn-stopping', { agent: { session: liveSession('s3') }, turn: 1, signal: new AbortController().signal })
} catch {
  threw = true
}
check('llm failure is swallowed', threw, false)
check('failed turn publishes nothing', failing.definition.apply(
  failing.definition.init({ id: 's3' }),
  { type: 'turn/end', seq: 20, data: { turn: 1, reason: { kind: 'completed' } } },
).turns, {})

// An error finish reason also yields no recap.
const errorFinish = createRuntime({
  llm: {
    async prepareCall(config) {
      return {
        config: { provider: config.provider, model: config.model },
        stream() {
          return (async function* () {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'x', code: 'y' } } }
          })()
        },
      }
    },
  },
})
mod.apply(errorFinish, {})
await errorFinish.fire('agent/turn-stopping', { agent: { session: liveSession('s4') }, turn: 1, signal: new AbortController().signal })
check('error finish publishes nothing', errorFinish.definition.apply(
  errorFinish.definition.init({ id: 's4' }),
  { type: 'turn/end', seq: 21, data: { turn: 1, reason: { kind: 'completed' } } },
).turns, {})

// Disabled config registers nothing at all.
const disabled = createRuntime()
mod.apply(disabled, { enabled: false })
check('disabled registers nothing', disabled.definition, undefined)
check('disabled registers no command', disabled.command, undefined)

// ---------------------------------------------------------------- /recap command
check('latestTurn reads the newest turn', mod.latestTurn({ ownEvents: () => events }), 2)
check('latestTurn on an empty session', mod.latestTurn({ ownEvents: () => [] }), undefined)

const commandRuntime = createRuntime()
mod.apply(commandRuntime, {})
check('command registered', commandRuntime.command?.name, 'recap')
check('command describes itself', typeof commandRuntime.command?.description, 'string')

const invocation = (session) => ({
  commandId: 'c1',
  agent: { session },
  rawInput: '',
  attachments: [],
  signal: new AbortController().signal,
})

const commandResult = await commandRuntime.command.handler(invocation(liveSession('s1')))
check('command returns the recap text', commandResult, { kind: 'success', text: 'Built the plugin and wired the projection.' })

const emptyResult = await commandRuntime.command.handler(invocation({ ...liveSession('s9'), ownEvents: () => [] }))
check('command without turns is an error', emptyResult.kind, 'error')

const failedResult = await failing.command.handler(invocation(liveSession('s3')))
check('command reports a failed request', failedResult.kind, 'error')

// A re-registered unit re-seeds from recaps this process already produced:
// the log cannot reproduce model-written text, so a toggle or config change
// must not silently drop cards the session already showed.
const reloaded = createRuntime()
mod.apply(reloaded, {})
check('re-registration keeps known recaps', Object.keys(reloaded.definition.init({ id: 's1' }).turns), ['2'])
check('re-registration keeps the text', reloaded.definition.init({ id: 's1' }).turns['2'].text, 'Built the plugin and wired the projection.')
check('unknown session starts empty', reloaded.definition.init({ id: 'never-seen' }).turns, {})
check('disposal forgets the session', (() => {
  reloaded.fire('session/disposed', { id: 's1' })
  return Object.keys(reloaded.definition.init({ id: 's1' }).turns)
})(), [])

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
