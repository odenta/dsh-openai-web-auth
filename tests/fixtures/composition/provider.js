/** Test-only external provider: real authorization and storage, never an OAuth network request. */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { credentialKey } = await import(pathToFileURL(resolve(process.env.DSH_CHECKOUT,
  'packages/credentials/credentials/lib/index.js')).href)
export const name = 'composition-external-provider-fixture'
export const inject = ['authorization', 'credentials', 'connection', 'webServer']

/** Expose deterministic provider barriers only inside the private test process. */
export function apply(ctx) {
  const state = {
    mode: 'success',
    token: 'composition-private-access-token',
    response: 'composition-private-provider-response',
    writing: Promise.withResolvers(),
    release: Promise.withResolvers(),
  }
  ctx.provide('compositionFixture', state)
  ctx.authorization.registerFlow({
    key: credentialKey('llm-pi-ai', 'openai-codex'),
    label: 'Keyless Codex fixture',
    methods: [{ id: 'oauth', label: 'Fixture login' }],
    async run(session) {
      if (state.mode === 'no-commit') return
      if (state.mode === 'failure') throw new Error(state.response)
      session.notify({ message: 'Continue with the keyless fixture', code: 'FIXTURE' })
      await session.prompt({ kind: 'text', message: 'Confirm fixture login' })
      session.signal.throwIfAborted()
      if (state.mode === 'cancel') throw new Error('Cancelled flow must not receive an answer')
      // Like provider-owned OAuth adapters, write through the real credential store.
      await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), async () => {
        state.writing.resolve()
        await state.release.promise
        session.signal.throwIfAborted()
        return { kind: 'grant', payload: { accessToken: state.token } }
      })
    },
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/',
    handler(req, res) {
      if (ctx.connection.authorizeIndex(req, res)) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('Test-only authenticated index\n')
      }
    },
  }))
  // Always release a failed assertion's provider write before shared storage is disposed.
  ctx.effect(() => () => { state.release.resolve() })
}
