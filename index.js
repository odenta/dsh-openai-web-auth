/** Web-only consumer of the existing DSH Codex OAuth flow. */
import z from '@deepseek-ai/schemastery'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { AuthFault, createAuthBridge } from './auth.js'
import { warnVersionDrift } from './compatibility.js'

export const name = 'openai-web-auth'
export const inject = ['authorization', 'connection', 'webServer']
export const Config = z.object({
  timeoutMs: z.natural().min(1000).max(3600000).default(600000)
    .description('Maximum sign-in attempt lifetime in milliseconds.'),
})

/** Register an authenticated browser-only channel; abort attempts before releasing its handlers. */
export async function apply(ctx, config) {
  await warnVersionDrift(ctx.logger)
  ctx.effect(() => {
    const bridge = createAuthBridge(ctx.authorization, credentialKey('llm-pi-ai', 'openai-codex'), config)
    const browserPeer = ctx.connection.browserPeer
    // Connection's channel registrar reads webServer through its calling Context.
    const rpcContext = ctx.extend({ webServer: ctx.webServer })
    const remove = rpcContext.connection.rpc.handle('/openai-web-auth', async (method, payload, signal, peer) => {
      if (peer.id !== browserPeer.id || peer.principal.kind !== 'owner') {
        return { ok: false, error: { code: 'FORBIDDEN', message: 'Browser sign-in only.', details: {} } }
      }
      try {
        return { ok: true, value: await bridge.call(method, payload, signal) }
      } catch (error) {
        return { ok: false, error: {
          code: error instanceof AuthFault ? error.code : 'LOGIN_FAILED',
          message: 'Sign-in did not complete.', details: {},
        } }
      }
    })
    return async () => { await bridge.dispose(); await remove() }
  })
}
