/** Browser UI for the existing Codex OAuth flow; loaded by the DSH module table. */
window.__ModuleLoader__.load({
  id: '@local/dsh-openai-web-auth',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'openai-web-auth'
    const dictionaries = {
      en: {
        signIn: 'Sign in with ChatGPT', title: 'ChatGPT sign-in', cancel: 'Cancel sign-in', close: 'Close',
        waiting: 'Complete sign-in using the instructions below.', openLink: 'Open sign-in page', code: 'Device code',
        answer: 'Continue', choose: 'Choose an option',
        authorized: 'Signed in. The credential has been saved.',
        setup: 'Apply the Codex provider settings, then select a model to use it.',
        cancelled: 'Sign-in cancelled.', retry: 'Try again',
        LOGIN_FAILED: 'Sign-in failed. Check your OpenAI account and network connection, then try again.',
        NO_FLOW: 'Codex sign-in is unavailable. Enable the DSH pi-ai provider and authorization plugins.',
        ALREADY_IN_FLIGHT: 'Another sign-in is running. Finish or cancel it before trying again.',
        NOT_COMMITTED: 'The credential was not saved. Check the Host credential storage, then try again.',
        EXPIRED: 'Sign-in expired. Try again.',
        STALE_PROMPT: 'This question has ended. Follow the latest sign-in instructions.',
        NETWORK: 'Connection lost. Sign-in may still finish. Reconnect before trying again.',
        FORBIDDEN: 'Sign-in is available only from the authenticated DSH browser.',
      },
      zh: {
        signIn: '使用 ChatGPT 登录', title: 'ChatGPT 登录', cancel: '取消登录', close: '关闭',
        waiting: '请按下方说明完成登录', openLink: '打开登录页面', code: '设备代码',
        answer: '继续', choose: '选择一个选项',
        authorized: '已登录，凭据已保存', setup: '应用 Codex 提供商设置，然后选择模型即可使用',
        cancelled: '已取消登录', retry: '重试',
        LOGIN_FAILED: '登录失败。请检查 OpenAI 账号和网络连接，然后重试',
        NO_FLOW: 'Codex 登录不可用。请启用 DSH 的 pi-ai 提供商和授权插件',
        ALREADY_IN_FLIGHT: '另一个登录正在进行。请先完成或取消该登录',
        NOT_COMMITTED: '凭据未保存。请检查 Host 凭据存储，然后重试',
        EXPIRED: '登录已过期，请重试', STALE_PROMPT: '此问题已结束，请按照最新登录说明操作',
        NETWORK: '连接已断开，登录仍可能完成。请恢复连接后再重试',
        FORBIDDEN: '仅可在已认证的 DSH 浏览器中登录',
      },
    }
    const CSS = `
.owauth-button { box-sizing:border-box; min-height:36px; padding:6px 14px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; font-size:14px; cursor:pointer; }
.owauth-button:disabled { opacity:.55; cursor:default; }
.owauth-button:focus-visible,.owauth-input:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.owauth-card { margin-top:12px; }
.owauth-dialog { pointer-events:auto; box-sizing:border-box; width:min(480px,calc(100vw - 32px)); max-height:calc(100dvh - 32px - var(--dsh-frame-top-clearance,0px)); margin:auto; padding:24px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary); font:inherit; font-size:14px; line-height:1.6; overflow:auto; overscroll-behavior:contain; }
.owauth-dialog::backdrop { background:var(--dsw-alias-bg-base); opacity:.65; }
.owauth-dialog h2 { margin:0 0 12px; font-size:16px; font-weight:500; }
.owauth-dialog p { margin:8px 0; overflow-wrap:anywhere; }
.owauth-dialog a { color:var(--dsw-alias-brand-primary); overflow-wrap:anywhere; }
.owauth-dialog code { display:block; padding:8px 12px; border-radius:8px; background:var(--dsw-alias-bg-layer-2); font-size:18px; user-select:all; }
.owauth-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; margin-top:20px; }
.owauth-input { box-sizing:border-box; display:block; width:100%; min-height:36px; margin:8px 0; padding:6px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; }
.owauth-error { color:var(--dsw-alias-state-error-primary); }
.owauth-success { color:var(--dsw-alias-state-success-primary); }
`
    const errorKey = code => Object.hasOwn(dictionaries.en, code) ? code : 'LOGIN_FAILED'
    function safeLink(value) {
      try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null }
      catch (error) { return null /* A provider notice with no navigable URL remains plain text. */ }
    }
    function Question({ prompt, busy, answer, t }) {
      const [value, setValue] = React.useState('')
      return h('form', { onSubmit(event) { event.preventDefault(); void answer(prompt.id, value) } },
        h('label', null, prompt.message,
          prompt.kind === 'select'
            ? h('select', { className: 'owauth-input', value, disabled: busy, required: true, onChange: event => setValue(event.target.value) },
              h('option', { value: '', disabled: true }, t('choose')),
              ...prompt.options.map(option => h('option', { key: option.id, value: option.id }, option.label)))
            : h('input', { className: 'owauth-input', type: prompt.kind === 'secret' ? 'password' : 'text',
              value, autoComplete: 'off', spellCheck: false, disabled: busy, maxLength: 16384,
              onChange: event => setValue(event.target.value) })),
        h('button', { className: 'owauth-button', type: 'submit', disabled: busy || (prompt.kind === 'select' && value.length === 0) }, t('answer')))
    }
    function ProviderButton({ provider, useAuth, start, t }) {
      const state = useAuth(value => value)
      if (provider.provider !== 'openai-codex') return null
      return h('div', { className: 'owauth-card' },
        h('style', null, CSS),
        h('button', { className: 'owauth-button', type: 'button', onClick: start, disabled: state.open }, t('signIn')))
    }
    function Dialog({ useAuth, start, close, answer, t }) {
      const state = useAuth(value => value)
      const ref = React.useRef(null)
      React.useEffect(() => {
        const dialog = ref.current
        if (state.open && !dialog.open) dialog.showModal()
        if (!state.open && dialog.open) dialog.close()
        return () => { if (dialog.open) dialog.close() }
      }, [state.open])
      const view = state.view
      const active = view?.phase === 'running' || state.starting
      return h(React.Fragment, null, h('style', null, CSS),
        h('dialog', { ref, className: 'owauth-dialog', 'aria-labelledby': 'owauth-title',
          onCancel(event) { event.preventDefault(); if (!state.busy) void close() },
          onClick(event) { if (event.target === event.currentTarget && !state.busy) {
            const box = event.currentTarget.getBoundingClientRect()
            if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) void close()
          } } },
        h('h2', { id: 'owauth-title' }, t('title')),
        active ? h('p', { role: 'status' }, t('waiting')) : null,
        ...(view?.notices ?? []).map((notice, index) => {
          const url = notice.url && safeLink(notice.url)
          return h('div', { key: `${index}:${notice.message}` },
            h('p', null, notice.message),
            url ? h('p', null, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, t('openLink'))) : null,
            notice.code ? h('p', null, t('code'), h('code', null, notice.code)) : null)
        }),
        view?.prompt ? h(Question, { key: view.prompt.id, prompt: view.prompt, busy: state.busy, answer, t }) : null,
        view?.phase === 'authorized' ? h('div', { role: 'status', className: 'owauth-success' },
          h('p', null, t('authorized')), h('p', null, t('setup'))) : null,
        view?.phase === 'cancelled' && !view.error ? h('p', { role: 'status' }, t('cancelled')) : null,
        state.error || view?.error ? h('p', { role: 'alert', className: 'owauth-error' }, t(errorKey(state.error || view.error))) : null,
        h('div', { className: 'owauth-actions' },
          !active && view?.phase !== 'authorized' ? h('button', { type: 'button', className: 'owauth-button', disabled: state.busy, onClick: start }, t('retry')) : null,
          h('button', { type: 'button', className: 'owauth-button', disabled: state.busy, onClick: close }, t(active ? 'cancel' : 'close')))))
    }
    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.locale.register(NS, dictionaries)
        let snapshot = { open: false, view: null, busy: false, starting: false, error: null }
        const listeners = new Set()
        const source = { getSnapshot: () => snapshot, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } }
        const publish = change => { snapshot = { ...snapshot, ...change }; for (const fn of listeners) fn() }
        let operation = null
        const call = async (op, method, args = {}, signal = op.controller.signal) => {
          let result
          try { result = await ctx.connection.rpc.call('/openai-web-auth', method, { token: op.token, ...args }, signal) }
          catch (error) { throw { code: 'NETWORK' } /* Transport errors may contain responses; never display them. */ }
          if (!result.ok) throw { code: result.error.code }
          const view = result.value
          if (!view || !Number.isSafeInteger(view.revision) || !['running', 'authorized', 'cancelled', 'failed'].includes(view.phase)
            || !Array.isArray(view.notices)) throw { code: 'NETWORK' }
          return view
        }
        const update = (op, view) => {
          if (operation === op && (!snapshot.view || view.revision >= snapshot.view.revision)) {
            publish({ view, ...(view.phase === 'running' ? {} : { error: null }) })
          }
        }
        const start = async () => {
          if (snapshot.busy || snapshot.view?.phase === 'running') return
          operation?.controller.abort()
          const op = { token: crypto.randomUUID(), controller: new AbortController(), closing: false, task: null }
          operation = op
          publish({ open: true, view: null, error: null, busy: true, starting: true })
          op.task = (async () => {
            try {
              update(op, await call(op, 'start', {}, AbortSignal.any([op.controller.signal, AbortSignal.timeout(15000)])))
              if (operation !== op) return
              publish({ busy: false, starting: false })
              while (!op.controller.signal.aborted && snapshot.view.phase === 'running') {
                update(op, await call(op, 'wait', { revision: snapshot.view.revision }))
              }
            } catch (error) {
              if (!op.controller.signal.aborted && operation === op && !op.closing) {
                publish({ error: error.code ?? 'LOGIN_FAILED', busy: false, starting: false })
              }
            }
          })()
          await op.task
        }
        const answer = async (promptId, value) => {
          const op = operation
          if (!op || snapshot.busy) return
          publish({ busy: true, error: null })
          try { update(op, await call(op, 'answer', { promptId, value }, AbortSignal.any([op.controller.signal, AbortSignal.timeout(15000)]))) }
          catch (error) { if (operation === op) publish({ error: error.code ?? 'LOGIN_FAILED' }) }
          finally { if (operation === op) publish({ busy: false }) }
        }
        const close = async () => {
          if (snapshot.busy) return
          const op = operation
          if (op && snapshot.view?.phase === 'running') {
            op.closing = true
            publish({ busy: true })
            try { update(op, await call(op, 'cancel', {}, AbortSignal.any([op.controller.signal, AbortSignal.timeout(15000)]))) }
            catch (error) { publish({ error: error.code ?? 'NETWORK', busy: false }); op.closing = false; return }
          }
          op?.controller.abort()
          publish({ open: false, busy: false })
        }
        ctx.effect(() => () => { operation?.controller.abort(); return operation?.task })
        const inject = () => ({ hooks: { auth: source }, start, close, answer })
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
          name: 'settings.models.provider-card', key: 'llm-pi-ai', locale: NS, inject,
        }, ProviderButton))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: NS, locale: NS, inject,
        }, Dialog))
      },
    }
  },
})
