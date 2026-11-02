/** Client orchestration tests: exercise injected actions without rendering or emulating a browser. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { createAuthBridge, AuthFault } from '../auth.js'

const code = await readFile(new URL('../client.js', import.meta.url), 'utf8')
function client(bridge, transport) {
  let plugin
  const registrations = []
  const effects = []
  runInNewContext(code, {
    window: { __ModuleLoader__: { load(row) {
      assert.equal(row.id, '@local/dsh-openai-web-auth')
      plugin = row.factory(name => {
        assert.equal(name, 'react')
        return { createElement() { throw new Error('These tests do not render UI') } }
      })
    } } },
    URL, crypto, AbortController, AbortSignal,
  })
  plugin.apply({
    locale: { register(namespace, dictionaries) {
      assert.equal(namespace, 'openai-web-auth')
      assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort())
    } },
    slots: { inject(_slot, install) { return install() }, register(options, component) {
      registrations.push({ options, component })
      return () => {}
    } },
    effect(acquire) { effects.push(acquire()) },
    connection: { rpc: { async call(channel, method, payload, signal) {
      assert.equal(channel, '/openai-web-auth')
      if (transport) return transport(method, payload, signal)
      try { return { ok: true, value: await bridge.call(method, payload, signal) } }
      catch (error) { return { ok: false, error: { code: error instanceof AuthFault ? error.code : 'LOGIN_FAILED' } } }
    } } },
  })
  const injected = registrations[0].options.inject()
  const source = injected.hooks.auth
  return {
    ...injected, source, registrations,
    async dispose() { await Promise.all(effects.reverse().map(release => release())) },
    until(predicate) {
      if (predicate(source.getSnapshot())) return Promise.resolve(source.getSnapshot())
      return new Promise(resolve => {
        const release = source.subscribe(() => {
          const view = source.getSnapshot()
          if (predicate(view)) { release(); resolve(view) }
        })
      })
    },
  }
}
function bridgeFor(run) {
  return createAuthBridge({ describe: () => ({ methods: [{ id: 'oauth' }] }), async begin(request) {
    const stopped = new Promise(resolve => {
      if (request.signal.aborted) resolve({ status: 'cancelled' })
      else request.signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true })
    })
    return Promise.race([run(request).then(() => ({ status: 'authorized' })), stopped])
  } }, 'llm-pi-ai/openai-codex', { timeoutMs: 600000 })
}

test('registers only the Codex-family extension and a separate persistent dialog', async () => {
  const ui = client(null, async () => { throw new Error('no request expected') })
  assert.equal(ui.registrations.length, 2)
  assert.equal(ui.registrations[0].options.name, 'settings.models.provider-card')
  assert.equal(ui.registrations[0].options.key, 'llm-pi-ai')
  assert.equal(ui.registrations[1].options.name, 'shell.overlay')
  assert.equal(ui.registrations[1].options.id, 'openai-web-auth')
  assert.equal(ui.source.getSnapshot().open, false)
  await ui.dispose()
})

test('runs questions through the Host, publishes the saved outcome, and closes', { timeout: 5000 }, async t => {
  const bridge = bridgeFor(async request => {
    request.interaction.notify({ message: 'Open the verification page', url: 'https://example.test', code: 'ABCD' })
    assert.equal(await request.interaction.prompt({ kind: 'select', message: 'Method', options: [{ id: 'browser', label: 'Browser' }] }), 'browser')
    assert.equal(await request.interaction.prompt({ kind: 'text', message: 'Redirect URL' }), 'redirect-value')
  })
  const ui = client(bridge)
  t.after(async () => { await ui.dispose(); await bridge.dispose() })
  const run = ui.start()
  const first = await ui.until(state => state.view?.prompt?.kind === 'select')
  await ui.answer(first.view.prompt.id, 'browser')
  const second = await ui.until(state => state.view?.prompt?.kind === 'text')
  await ui.answer(second.view.prompt.id, 'redirect-value')
  await run
  assert.equal(ui.source.getSnapshot().view.phase, 'authorized')
  assert.equal(ui.source.getSnapshot().busy, false)
  await ui.close()
  assert.equal(ui.source.getSnapshot().open, false)
})

test('closing an active dialog cancels the exact attempt', { timeout: 5000 }, async t => {
  const bridge = bridgeFor(async request => { await request.interaction.prompt({ kind: 'text', message: 'Code' }) })
  const ui = client(bridge)
  t.after(async () => { await ui.dispose(); await bridge.dispose() })
  const run = ui.start()
  await ui.until(state => !!state.view?.prompt)
  await ui.close()
  await run
  assert.equal(ui.source.getSnapshot().open, false)
  assert.equal(ui.source.getSnapshot().view.phase, 'cancelled')
})

test('unload aborts the outstanding wait and releases the Host attempt', { timeout: 5000 }, async t => {
  let signal
  const bridge = bridgeFor(async request => {
    signal = request.signal
    await request.interaction.prompt({ kind: 'text', message: 'Code' })
  })
  const ui = client(bridge)
  t.after(() => bridge.dispose())
  const run = ui.start()
  await ui.until(state => !!state.view?.prompt)
  await ui.dispose()
  await run
  assert.equal(signal.aborted, true)
})

test('a confirmed saved outcome clears an earlier stale-question error', { timeout: 5000 }, async t => {
  const finish = Promise.withResolvers()
  const view = { revision: 0, phase: 'running', notices: [], prompt: { id: 'question', kind: 'text', message: 'Code' }, error: null }
  const ui = client(null, async method => {
    if (method === 'start') return { ok: true, value: view }
    if (method === 'wait') return finish.promise
    return { ok: false, error: { code: 'STALE_PROMPT' } }
  })
  t.after(() => ui.dispose())
  const run = ui.start()
  await ui.until(state => state.view?.prompt && !state.busy)
  await ui.answer('question', 'code')
  assert.equal(ui.source.getSnapshot().error, 'STALE_PROMPT')
  finish.resolve({ ok: true, value: { ...view, revision: 1, phase: 'authorized', prompt: null } })
  await run
  assert.equal(ui.source.getSnapshot().view.phase, 'authorized')
  assert.equal(ui.source.getSnapshot().error, null)
})

test('start failures retain safe codes and never expose raw transport messages', async () => {
  const ui = client(null, async () => { throw new Error('private-provider-response') })
  await ui.start()
  assert.equal(ui.source.getSnapshot().error, 'NETWORK')
  assert.equal(ui.source.getSnapshot().starting, false)
  assert.equal(JSON.stringify(ui.source.getSnapshot()).includes('private-provider-response'), false)
  await ui.dispose()
})
