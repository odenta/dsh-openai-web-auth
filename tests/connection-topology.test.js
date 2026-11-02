/** Optional built-DSH regression: sibling services preserve RPC registration and cleanup. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire, registerHooks } from 'node:module'

const checkout = process.env.DSH_CHECKOUT

test('registers the actual plugin with sibling Connection and Web server providers', {
  skip: checkout ? false : 'Set DSH_CHECKOUT to a built DSH checkout to test Cordis topology.',
  timeout: 5000,
}, async t => {
  const artifact = path => pathToFileURL(resolve(checkout, path)).href
  const { Context } = await import(artifact('vendor/cordis/lib/index.js'))
  const { HostConnectionService } = await import(artifact('packages/client/connection/lib/index.js'))
  // The profile supplies these peers in production; use the same built packages without installing them here.
  const runtime = createRequire(artifact('packages/client/connection/package.json'))
  const entry = new URL('../index.js', import.meta.url).href
  const peers = new Set(['@deepseek-ai/schemastery', '@deepseek-ai/dsh-credentials'])
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === entry && peers.has(specifier)) {
        return nextResolve(pathToFileURL(runtime.resolve(specifier)).href, context)
      }
      return nextResolve(specifier, context)
    },
  })
  let plugin
  try { plugin = await import(entry) }
  finally { hooks.deregister() }
  const root = new Context()
  t.after(() => root.fiber.dispose())
  const routes = new Map()
  let removed = 0

  // Root-provided mocks hide the shadow-origin lookup that fails in real profiles.
  await root.plugin({
    name: 'fixture-web-server',
    apply(ctx) {
      ctx.provide('webServer', {
        register(route) {
          assert.equal(routes.has(route.path), false)
          routes.set(route.path, route)
          return () => { removed++; routes.delete(route.path) }
        },
      })
    },
  })
  await root.plugin({
    name: 'fixture-connection',
    apply(ctx) { new HostConnectionService(ctx, [], {}) },
  })
  await root.plugin({
    name: 'fixture-authorization',
    apply(ctx) {
      ctx.provide('authorization', {
        describe() { throw new Error('Registration must not start authorization.') },
        begin() { throw new Error('This regression must not run OAuth.') },
      })
    },
  })

  let unadaptedFailure
  await root.plugin({
    name: 'fixture-unadapted-consumer',
    inject: ['connection', 'webServer'],
    apply(ctx) {
      assert.ok(ctx.webServer)
      try {
        ctx.connection.rpc.handle('/unadapted-regression', async () => ({ ok: true, value: null }))
      } catch (error) { unadaptedFailure = error }
    },
  })
  assert.match(unadaptedFailure?.message ?? '', /cannot get property "webServer" without inject/)
  assert.equal(routes.size, 0)

  const consumer = root.plugin(plugin, { timeoutMs: 600000 })
  await consumer
  assert.deepEqual([...routes.keys()], ['/openai-web-auth'])
  assert.equal(typeof routes.get('/openai-web-auth').handler, 'function')
  await consumer.dispose()
  assert.equal(routes.size, 0)
  assert.equal(removed, 1)
  assert.ok(root.get('connection'), 'consumer cleanup must not dispose the shared Connection')
  assert.ok(root.get('webServer'), 'consumer cleanup must not dispose the shared Web server')
})
