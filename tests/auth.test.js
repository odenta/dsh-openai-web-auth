/** Keyless protocol tests for browser-private Codex authorization; no DSH runtime or network. */
import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { createAuthBridge, AuthFault } from '../auth.js'

// Bound failed protocol waits; each fixture still owns and awaits bridge disposal.
const test = (name, run) => nodeTest(name, { timeout: 5000 }, run)
const KEY = 'llm-pi-ai/openai-codex'
const TOKEN = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const defer = () => Promise.withResolvers()
const requestSignal = () => new AbortController().signal
const fault = code => error => error instanceof AuthFault && error.code === code && error.message === code

/** Model begin's signal-aware settlement without implementing any provider protocol. */
function fixture(t, run, { timeoutMs = 60_000, flow = { methods: [{ id: 'oauth' }] } } = {}) {
  const entered = defer()
  const calls = []
  const authorization = {
    describe(key) { assert.equal(key, KEY); return flow },
    async begin(request) {
      calls.push(request)
      assert.equal(request.key, KEY)
      assert.equal(request.method, 'oauth')
      const cancelled = defer()
      const abort = () => cancelled.resolve({ status: 'cancelled' })
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) abort()
      const running = Promise.resolve().then(() => {
        const result = run(request)
        entered.resolve(request)
        return result
      })
      try { return await Promise.race([running, cancelled.promise]) }
      finally { request.signal.removeEventListener('abort', abort) }
    },
  }
  const bridge = createAuthBridge(authorization, KEY, { timeoutMs })
  t.after(() => bridge.dispose())
  const call = (method, payload, signal = requestSignal()) => bridge.call(method, payload, signal)
  const start = (token = TOKEN) => call('start', { token })
  const wait = (view, token = TOKEN, signal) => call('wait', { token, revision: view.revision }, signal)
  return { bridge, call, start, wait, entered: entered.promise, calls }
}

/** Every iteration is a revision-triggered blocking wait, never a timer or polling loop. */
async function until(f, view, predicate, token = TOKEN) {
  while (!predicate(view)) {
    assert.equal(view.phase, 'running', 'attempt ended before expected state')
    view = await f.wait(view, token)
  }
  return view
}
const terminal = (f, view, token) => until(f, view, value => value.phase !== 'running', token)
const question = (f, view) => until(f, view, value => value.prompt !== null)

test('reports a stored grant outcome without returning provider credentials', async t => {
  const grant = { accessToken: 'private-access-token', refreshToken: 'private-refresh-token' }
  let stored
  const f = fixture(t, async ({ interaction }) => {
    interaction.notify({ message: 'Continue in your browser', url: 'https://auth.example/login', code: 'ABCD' })
    stored = grant
    return { status: 'authorized', credential: grant }
  })
  const initial = await f.start()
  const done = await terminal(f, initial)
  assert.equal(done.phase, 'authorized')
  assert.equal(stored, grant)
  assert.deepEqual(done.notices, [{ message: 'Continue in your browser', url: 'https://auth.example/login', code: 'ABCD' }])
  assert.equal(done.prompt, null)
  assert.equal(done.error, null)
  assert.doesNotMatch(JSON.stringify(done), /private-access-token|private-refresh-token|credential/)
})

test('repeating start with the same capability preserves a completed outcome', async t => {
  const f = fixture(t, async () => ({ status: 'authorized' }))
  const done = await terminal(f, await f.start())
  assert.deepEqual(await f.start(), done)
  assert.equal(f.calls.length, 1)
})

test('retains only eight notices and bounds each displayed field', async t => {
  const finish = defer()
  const f = fixture(t, async ({ interaction }) => {
    for (let n = 0; n < 10; n++) interaction.notify({ message: `${n}:` + 'm'.repeat(9000), url: 'u'.repeat(17000), code: 'c'.repeat(1100) })
    return finish.promise
  })
  const initial = await f.start()
  await f.entered
  const view = await f.wait(initial)
  assert.equal(view.notices.length, 8)
  assert.ok(view.notices[0].message.startsWith('2:'))
  assert.ok(view.notices[7].message.startsWith('9:'))
  for (const notice of view.notices) {
    assert.equal(notice.message.length, 8192)
    assert.equal(notice.url.length, 16384)
    assert.equal(notice.code.length, 1024)
  }
  finish.resolve({ status: 'authorized' })
  await terminal(f, view)
})

test('select and text prompts accept valid answers and reject invalid or stale answers', async t => {
  const answers = []
  const f = fixture(t, async ({ interaction }) => {
    answers.push(await interaction.prompt({ kind: 'select', message: 'Choose login', options: [{ id: 'browser', label: 'Browser' }] }))
    answers.push(await interaction.prompt({ kind: 'text', message: 'Paste redirect' }))
    return { status: 'authorized' }
  })
  let view = await question(f, await f.start())
  assert.equal(view.prompt.kind, 'select')
  assert.deepEqual(view.prompt.options, [{ id: 'browser', label: 'Browser' }])
  const firstId = view.prompt.id
  for (const value of ['not-an-option', 1, null, 'x'.repeat(16385)]) {
    await assert.rejects(f.call('answer', { token: TOKEN, promptId: firstId, value }), fault('INVALID_REQUEST'))
  }
  await assert.rejects(f.call('answer', { token: TOKEN, promptId: OTHER, value: 'browser' }), fault('STALE_PROMPT'))
  view = await f.call('answer', { token: TOKEN, promptId: firstId, value: 'browser' })
  view = await question(f, view)
  assert.equal(view.prompt.kind, 'text')
  assert.notEqual(view.prompt.id, firstId)
  await assert.rejects(f.call('answer', { token: TOKEN, promptId: firstId, value: 'duplicate' }), fault('STALE_PROMPT'))
  const redirect = 'http://localhost/callback?code=private-code'
  view = await f.call('answer', { token: TOKEN, promptId: view.prompt.id, value: redirect })
  view = await terminal(f, view)
  assert.deepEqual(answers, ['browser', redirect])
  assert.doesNotMatch(JSON.stringify(view), /private-code/)
  await assert.rejects(f.call('answer', { token: TOKEN, promptId: firstId, value: 'browser' }), fault('STALE_PROMPT'))
})

test('text answers accept an empty string and the exact size limit', async t => {
  const answers = []
  const f = fixture(t, async ({ interaction }) => {
    for (let n = 0; n < 2; n++) answers.push(await interaction.prompt({ kind: 'text', message: 'Text' }))
    return { status: 'authorized' }
  })
  let view = await f.start()
  for (const value of ['', 'a'.repeat(16384)]) {
    view = await question(f, view)
    view = await f.call('answer', { token: TOKEN, promptId: view.prompt.id, value })
  }
  await terminal(f, view)
  assert.deepEqual(answers, ['', 'a'.repeat(16384)])
})

test('a withdrawn prompt rejects without preventing the next question', async t => {
  const controller = new AbortController()
  let withdrawal
  let answer
  const f = fixture(t, async ({ interaction }) => {
    try { await interaction.prompt({ kind: 'text', message: 'First', signal: controller.signal }) }
    catch (error) { withdrawal = error }
    answer = await interaction.prompt({ kind: 'text', message: 'Next' })
    return { status: 'authorized' }
  })
  let view = await question(f, await f.start())
  const staleId = view.prompt.id
  const reason = new Error('manual input withdrawn')
  controller.abort(reason)
  view = await until(f, view, value => value.prompt !== null && value.prompt.id !== staleId)
  assert.equal(withdrawal, reason)
  assert.equal(view.prompt.message, 'Next')
  await assert.rejects(f.call('answer', { token: TOKEN, promptId: staleId, value: 'late' }), fault('STALE_PROMPT'))
  view = await f.call('answer', { token: TOKEN, promptId: view.prompt.id, value: 'next answer' })
  await terminal(f, view)
  assert.equal(answer, 'next answer')
})

test('browser callback wins and withdraws its losing manual-input prompt', async t => {
  const callback = defer()
  const manual = new AbortController()
  let manualRejection
  const f = fixture(t, async ({ interaction }) => {
    const input = interaction.prompt({ kind: 'text', message: 'Paste redirect', signal: manual.signal })
    const observed = input.catch(error => { manualRejection = error; throw error })
    const winner = await Promise.race([observed, callback.promise])
    manual.abort()
    await input.catch(() => {})
    assert.equal(winner, 'browser callback')
    return { status: 'authorized' }
  })
  let view = await question(f, await f.start())
  const promptId = view.prompt.id
  callback.resolve('browser callback')
  view = await terminal(f, view)
  assert.equal(view.phase, 'authorized')
  assert.equal(view.prompt, null)
  assert.equal(manualRejection.name, 'AbortError')
  await assert.rejects(f.call('answer', { token: TOKEN, promptId, value: 'late' }), fault('STALE_PROMPT'))
})

test('isolates private tokens, refuses another start, and makes an active start idempotent', async t => {
  const finish = defer()
  const f = fixture(t, () => finish.promise)
  const initial = await f.start()
  await f.entered
  assert.deepEqual(await f.start(), initial)
  assert.equal(f.calls.length, 1)
  await assert.rejects(f.start(OTHER), fault('ALREADY_IN_FLIGHT'))
  for (const method of ['wait', 'cancel', 'answer']) {
    await assert.rejects(f.call(method, { token: OTHER, revision: 0, promptId: OTHER, value: 'private' }), fault('STALE_ATTEMPT'))
  }
  assert.equal(f.calls[0].signal.aborted, false)
  finish.resolve({ status: 'authorized' })
  await terminal(f, initial)
})

test('a new attempt replaces a finished attempt and rejects its old capability', async t => {
  const f = fixture(t, async () => ({ status: 'authorized' }))
  await terminal(f, await f.start())
  const next = await f.start(OTHER)
  await assert.rejects(f.call('wait', { token: TOKEN, revision: 0 }), fault('STALE_ATTEMPT'))
  await terminal(f, next, OTHER)
  assert.equal(f.calls.length, 2)
})

test('sanitizes provider exceptions and only exposes approved error codes', async t => {
  for (const code of [undefined, 'SENSITIVE_PROVIDER_CODE', 'NO_FLOW', 'UNKNOWN_METHOD', 'ALREADY_IN_FLIGHT', 'NOT_COMMITTED']) {
    const f = fixture(t, async () => { throw Object.assign(new Error('private token response'), { code, body: 'private-refresh-token' }) })
    const view = await terminal(f, await f.start())
    assert.equal(view.phase, 'failed')
    assert.equal(view.error, ['NO_FLOW', 'UNKNOWN_METHOD', 'ALREADY_IN_FLIGHT', 'NOT_COMMITTED'].includes(code) ? code : 'LOGIN_FAILED')
    assert.doesNotMatch(JSON.stringify(view), /private|SENSITIVE_PROVIDER_CODE/)
  }
})

test('aborting a pending wait cancels its attempt and rejects only that request as disconnected', async t => {
  const f = fixture(t, async ({ interaction }) => {
    await interaction.prompt({ kind: 'text', message: 'Answer' })
    return { status: 'authorized' }
  })
  let view = await question(f, await f.start())
  const controller = new AbortController()
  const waiting = f.wait(view, TOKEN, controller.signal)
  const rejected = assert.rejects(waiting, fault('DISCONNECTED'))
  controller.abort()
  await rejected
  assert.equal(f.calls[0].signal.aborted, true)
  view = await terminal(f, view)
  assert.equal(view.phase, 'cancelled')
  assert.equal(view.error, null)
  assert.equal(view.prompt, null)
})

test('expiry aborts the provider and wakes pending waits with EXPIRED', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, () => new Promise(() => {}), { timeoutMs: 100 })
  const initial = await f.start()
  await f.entered
  const waiting = f.wait(initial)
  t.mock.timers.tick(99)
  assert.equal(f.calls[0].signal.aborted, false)
  t.mock.timers.tick(1)
  const view = await waiting
  assert.equal(view.phase, 'cancelled')
  assert.equal(view.error, 'EXPIRED')
  assert.equal(f.calls[0].signal.aborted, true)
})

test('explicit cancellation wakes all pending waits and remains idempotent', async t => {
  const f = fixture(t, () => new Promise(() => {}))
  const initial = await f.start()
  await f.entered
  const waits = [f.wait(initial), f.wait(initial)]
  const cancelled = await f.call('cancel', { token: TOKEN })
  assert.equal(cancelled.phase, 'cancelled')
  for (const view of await Promise.all(waits)) assert.deepEqual(view, cancelled)
  assert.deepEqual(await f.call('cancel', { token: TOKEN }), cancelled)
})

test('dispose aborts pending work, settles waiting callers, and rejects further calls', async t => {
  const f = fixture(t, () => new Promise(() => {}))
  const initial = await f.start()
  await f.entered
  const waits = [f.wait(initial), f.wait(initial)]
  await f.bridge.dispose()
  for (const view of await Promise.all(waits)) assert.equal(view.phase, 'cancelled')
  assert.equal(f.calls[0].signal.aborted, true)
  await f.bridge.dispose()
  await assert.rejects(f.start(), fault('UNAVAILABLE'))
  await assert.rejects(f.call('wait', { token: TOKEN, revision: 0 }), fault('UNAVAILABLE'))
})

test('rejects malformed payloads, invalid tokens, unknown methods, and invalid revisions', async t => {
  const f = fixture(t, () => new Promise(() => {}))
  for (const payload of [undefined, null, [], 1, 'token']) {
    await assert.rejects(f.call('start', payload), fault('INVALID_REQUEST'))
  }
  for (const token of [undefined, null, 1, '', 'not-a-uuid', '11111111-1111-1111-1111-111111111111']) {
    await assert.rejects(f.start(token === undefined ? null : token), fault('INVALID_REQUEST'))
  }
  const view = await f.start()
  await assert.rejects(f.call('unsupported', { token: TOKEN }), fault('UNKNOWN_METHOD'))
  for (const revision of [undefined, -1, 0.1, '0', Number.MAX_SAFE_INTEGER + 1, view.revision + 1]) {
    await assert.rejects(f.call('wait', { token: TOKEN, revision }), fault('INVALID_REQUEST'))
  }
})

test('a pre-aborted request starts no provider work', async t => {
  const f = fixture(t, () => new Promise(() => {}))
  const controller = new AbortController()
  const reason = new Error('request already gone')
  controller.abort(reason)
  await assert.rejects(f.call('start', { token: TOKEN }, controller.signal), error => error === reason)
  assert.equal(f.calls.length, 0)
})

test('refuses an absent flow or a flow without OAuth before calling begin', async t => {
  for (const flow of [undefined, null, { methods: [] }, { methods: [{ id: 'api-key' }] }]) {
    const f = fixture(t, () => { throw new Error('must not begin') }, { flow: flow === undefined ? null : flow })
    await assert.rejects(f.start(), fault('NO_FLOW'))
    assert.equal(f.calls.length, 0)
  }
})
