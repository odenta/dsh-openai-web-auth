/** Browser-private interaction for the existing Codex authorization flow. No token payloads leave DSH. */
import { randomUUID } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const safeCodes = new Set(['NO_FLOW', 'UNKNOWN_METHOD', 'ALREADY_IN_FLIGHT', 'NOT_COMMITTED'])

/** Expected protocol failure; messages contain no provider responses or user answers. */
export class AuthFault extends Error {
  constructor(code) { super(code); this.code = code }
}

/**
 * Own one bounded login and its cancellable questions. The token is a page-private capability.
 * @param {object} authorization DSH authorization service.
 * @param {string} key Existing provider-owned credential record address.
 * @param {{timeoutMs: number}} config Maximum lifetime of an attempt, including a disconnected page.
 * @returns {{call: Function, dispose: Function}} RPC dispatcher and asynchronous shutdown.
 */
export function createAuthBridge(authorization, key, config) {
  let current = null
  let disposed = false
  const requireAttempt = (payload) => {
    if (!current || payload.token !== current.token) throw new AuthFault('STALE_ATTEMPT')
    return current
  }
  const publish = (attempt, change) => {
    attempt.view = { ...attempt.view, ...change, revision: attempt.view.revision + 1 }
    for (const wake of [...attempt.listeners]) wake()
  }
  const cancel = async (attempt) => {
    attempt.controller.abort()
    await attempt.done
    return attempt.view
  }
  const start = (token) => {
    if (typeof token !== 'string' || !UUID.test(token)) throw new AuthFault('INVALID_REQUEST')
    if (current?.token === token) return current.view
    if (current?.view.phase === 'running') throw new AuthFault('ALREADY_IN_FLIGHT')
    const flow = authorization.describe(key)
    if (!flow?.methods.some(method => method.id === 'oauth')) throw new AuthFault('NO_FLOW')
    const attempt = {
      token, controller: new AbortController(), listeners: new Set(), pending: null,
      view: { revision: 0, phase: 'running', notices: [], prompt: null, error: null },
      done: null,
    }
    current = attempt
    const timer = setTimeout(() => {
      attempt.timedOut = true
      attempt.controller.abort()
    }, config.timeoutMs)
    timer.unref?.()
    const interaction = {
      notify(notice) {
        if (attempt.controller.signal.aborted || attempt.view.phase !== 'running') return
        publish(attempt, { notices: [...attempt.view.notices.slice(-7), {
          message: notice.message.slice(0, 8192),
          ...(notice.url === undefined ? {} : { url: notice.url.slice(0, 16384) }),
          ...(notice.code === undefined ? {} : { code: notice.code.slice(0, 1024) }),
        }] })
      },
      async prompt(prompt) {
        const signal = AbortSignal.any([attempt.controller.signal, ...prompt.signal ? [prompt.signal] : []])
        signal.throwIfAborted()
        if (attempt.pending) throw new AuthFault('CONCURRENT_PROMPT')
        const id = randomUUID()
        const question = { id, kind: prompt.kind, message: prompt.message,
          ...(prompt.options === undefined ? {} : { options: prompt.options }) }
        const answer = Promise.withResolvers()
        const abort = () => answer.reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        attempt.pending = { id, question, resolve: answer.resolve }
        publish(attempt, { prompt: question })
        try { return await answer.promise } finally {
          signal.removeEventListener('abort', abort)
          if (attempt.pending?.id === id) {
            attempt.pending = null
            publish(attempt, { prompt: null })
          }
        }
      },
    }
    attempt.done = Promise.resolve().then(() => authorization.begin({
      key, method: 'oauth', signal: attempt.controller.signal, interaction,
    })).then(outcome => {
      publish(attempt, { phase: outcome.status, prompt: null,
        error: attempt.timedOut && outcome.status === 'cancelled' ? 'EXPIRED' : null })
    }, error => {
      publish(attempt, { phase: 'failed', prompt: null,
        error: safeCodes.has(error?.code) ? error.code : 'LOGIN_FAILED' })
    }).finally(() => { clearTimeout(timer); attempt.controller.abort() })
    return attempt.view
  }
  return {
    async call(method, payload, signal) {
      if (disposed) throw new AuthFault('UNAVAILABLE')
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AuthFault('INVALID_REQUEST')
      signal.throwIfAborted()
      if (method === 'start') return start(payload.token)
      const attempt = requireAttempt(payload)
      if (method === 'cancel') return cancel(attempt)
      if (method === 'answer') {
        const pending = attempt.pending
        if (!pending || pending.id !== payload.promptId) throw new AuthFault('STALE_PROMPT')
        if (typeof payload.value !== 'string' || payload.value.length > 16384) throw new AuthFault('INVALID_REQUEST')
        if (pending.question.kind === 'select' && !pending.question.options.some(option => option.id === payload.value)) {
          throw new AuthFault('INVALID_REQUEST')
        }
        pending.resolve(payload.value)
        // A duplicate answer must never resolve a subsequent question.
        attempt.pending = null
        publish(attempt, { prompt: null })
        return attempt.view
      }
      if (method !== 'wait') throw new AuthFault('UNKNOWN_METHOD')
      if (!Number.isSafeInteger(payload.revision) || payload.revision < 0 || payload.revision > attempt.view.revision) {
        throw new AuthFault('INVALID_REQUEST')
      }
      if (payload.revision !== attempt.view.revision || attempt.view.phase !== 'running') return attempt.view
      return new Promise((resolve, reject) => {
        const release = () => {
          attempt.listeners.delete(wake)
          signal.removeEventListener('abort', abort)
        }
        const wake = () => { release(); resolve(attempt.view) }
        const abort = () => {
          release()
          attempt.controller.abort()
          reject(new AuthFault('DISCONNECTED'))
        }
        attempt.listeners.add(wake)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    },
    async dispose() {
      disposed = true
      if (current) await cancel(current)
    },
  }
}
