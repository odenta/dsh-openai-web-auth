/** Private test executable: boot a real Loader tree and exercise actual HTTP RPC without a GUI. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const checkout = process.env.DSH_CHECKOUT
const home = process.env.DSH_HOME
const artifact = path => pathToFileURL(resolve(checkout, path)).href
const plugin = new URL('../../../index.js', import.meta.url).href
const peers = createRequire(artifact('packages/client/connection/package.json'))
// The real profile resolver normally supplies external plugins' shared peers.
// This private app-boot fixture supplies only the same two imports, without installing anything.
const peerNames = new Set(['@deepseek-ai/schemastery', '@deepseek-ai/dsh-credentials'])
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === plugin && peerNames.has(specifier)) {
      return next(pathToFileURL(peers.resolve(specifier)).href, context)
    }
    return next(specifier, context)
  },
})
let ctx
let stage = 'boot'
let failed = false
const wire = []
const report = { successAfterStorage: false, cancellation: false, privateAttempt: false,
  apiPeerDenied: false, unauthenticatedDenied: false, noCommitRejected: false,
  privateProviderFailure: false, disposed: false }
try {
  const { boot } = await import(artifact('packages/boot/app-boot/lib/index.js'))
  const template = await readFile(new URL('./cordis.yml', import.meta.url), 'utf8')
  const substitutions = {
    CREDENTIALS: artifact('packages/credentials/credentials-local/lib/index.js'),
    AUTHORIZATION: artifact('packages/credentials/authorization/lib/index.js'),
    WEBSERVER: artifact('packages/host/webserver/lib/index.js'),
    CONNECTION: artifact('packages/client/connection/lib/index.js'),
    PROVIDER: new URL('./provider.js', import.meta.url).href,
    PLUGIN: plugin,
    STORE: join(home, '.credentials.yaml'),
  }
  const configuration = template.replace(/"@([A-Z]+)@"/g, (_, key) => JSON.stringify(substitutions[key]))
  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, configuration)
  ctx = await boot('external-auth-composition-test', configPath)
  assert.ok(ctx.get('compositionFixture'), 'Loader fixture must activate')
  assert.ok(ctx.get('authorization'), 'Real authorization must activate')
  const fixture = ctx.get('compositionFixture')
  const origin = ctx.get('webServer').getOrigin()
  const connection = ctx.get('connection')
  const deadline = AbortSignal.timeout(20000)
  const fetchLocal = (url, init = {}) => {
    assert.equal(new URL(url).origin, origin, 'Test transport must stay on its ephemeral loopback listener')
    return fetch(url, { ...init, signal: deadline, redirect: 'manual' })
  }
  const exchange = async path => {
    const response = await fetchLocal(connection.authenticatedUrl(origin + path))
    assert.ok(response.status === 302 || response.status === 303, 'Real launch-token exchange must redirect')
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, 'Real launch-token exchange must issue a cookie')
    await response.arrayBuffer()
    return cookie
  }
  stage = 'authenticated HTTP exchange'
  const browser = await exchange('/')
  const api = await exchange('/connect')
  const rpc = async (method, payload, cookie = browser) => {
    const id = randomUUID()
    const response = await fetchLocal(`${origin}/openai-web-auth/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }),
    })
    const text = await response.text()
    wire.push(text)
    if (response.status !== 200) return { status: response.status }
    const envelope = JSON.parse(text)
    assert.equal(envelope.rpcId, id, 'RPC must retain request correlation')
    assert.equal(envelope.type, 'server-response')
    return envelope.result
  }
  const call = async (method, payload) => {
    const result = await rpc(method, payload)
    assert.equal(result.ok, true, `Browser ${method} RPC must succeed`)
    return result.value
  }
  const until = async (token, view, predicate) => {
    while (!predicate(view)) {
      assert.equal(view.phase, 'running', 'Attempt ended before the expected transition')
      view = await call('wait', { token, revision: view.revision })
    }
    return view
  }
  const terminal = (token, view) => until(token, view, value => value.phase !== 'running')
  const question = (token, view) => until(token, view, value => value.prompt !== null)
  const stored = () => readFile(join(home, '.credentials.yaml'), 'utf8')
  const requireCode = (result, code) => {
    assert.equal(result.ok, false, 'Request must be denied')
    assert.equal(result.error.code, code)
  }

  stage = 'transport admission'
  assert.equal((await rpc('start', { token: randomUUID() }, null)).status, 401)
  report.unauthenticatedDenied = true
  for (const method of ['start', 'wait', 'answer', 'cancel']) {
    requireCode(await rpc(method, { token: randomUUID() }, api), 'FORBIDDEN')
  }
  report.apiPeerDenied = true

  stage = 'storage-gated success'
  const token = randomUUID()
  let view = await question(token, await call('start', { token }))
  assert.equal(view.prompt.kind, 'text')
  for (const method of ['wait', 'answer', 'cancel']) {
    requireCode(await rpc(method, { token: randomUUID(), revision: view.revision,
      promptId: view.prompt.id, value: 'fixture answer' }), 'STALE_ATTEMPT')
  }
  report.privateAttempt = true
  view = await call('answer', { token, promptId: view.prompt.id, value: 'fixture answer' })
  await fixture.writing.promise
  assert.equal(view.phase, 'running', 'Sign-in must not succeed while persistence is blocked')
  assert.ok(!(await stored()).includes(fixture.token), 'Blocked persistence must not expose a stored grant')
  fixture.release.resolve()
  view = await terminal(token, view)
  assert.equal(view.phase, 'authorized')
  assert.ok((await stored()).includes(fixture.token), 'Authorized result requires the grant on disk')
  report.successAfterStorage = true

  stage = 'cancelled reauthorization'
  const beforeCancel = await stored()
  fixture.mode = 'cancel'
  const cancelToken = randomUUID()
  view = await question(cancelToken, await call('start', { token: cancelToken }))
  view = await call('cancel', { token: cancelToken })
  assert.equal(view.phase, 'cancelled')
  assert.ok((await stored()) === beforeCancel, 'Cancellation must preserve the prior credential file')
  report.cancellation = true

  stage = 'stale stored credential cannot authorize a no-write flow'
  fixture.mode = 'no-commit'
  const noCommitToken = randomUUID()
  view = await terminal(noCommitToken, await call('start', { token: noCommitToken }))
  assert.equal(view.phase, 'failed')
  assert.equal(view.error, 'NOT_COMMITTED')
  assert.ok((await stored()) === beforeCancel, 'No-write flow must preserve the prior credential file')
  report.noCommitRejected = true

  stage = 'private provider failure'
  fixture.mode = 'failure'
  const failureToken = randomUUID()
  view = await terminal(failureToken, await call('start', { token: failureToken }))
  assert.equal(view.phase, 'failed')
  assert.equal(view.error, 'LOGIN_FAILED')
  assert.ok(!wire.join('').includes(fixture.token), 'RPC must not expose stored grant payloads')
  assert.ok(!wire.join('').includes(fixture.response), 'RPC must not expose provider error bodies')
  report.privateProviderFailure = true
} catch (error) {
  failed = true
  process.exitCode = 1
  // Do not forward raw errors, cookies, launch URLs, or provider/token values to test output.
  process.send?.({ type: 'composition-failure', stage, error: error.name,
    location: error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).join('\n'),
    assertion: error.name === 'AssertionError' ? error.message.split('\n')[0] : undefined })
} finally {
  stage = stage === 'private provider failure' ? 'disposal' : stage
  ctx?.get('compositionFixture')?.release.resolve()
  await ctx?.fiber.dispose()
  hooks.deregister()
}
report.disposed = true
if (!failed) process.send?.({ type: 'composition-result', report })
process.disconnect?.()
