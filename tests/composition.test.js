/** Optional keyless built-DSH smoke: real Loader, HTTP RPC, authorization, and temporary disk storage. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkout = process.env.DSH_CHECKOUT

test('real Loader composition keeps authorization private and reports success only after durable storage', {
  skip: checkout ? false : 'Set DSH_CHECKOUT to a built DSH checkout to run the real-composition smoke.',
  timeout: 40000,
}, async t => {
  // Explicit opt-in must fail loudly when required artifacts are absent; never install or build DSH here.
  for (const artifact of ['packages/boot/app-boot/lib/index.js',
    'packages/credentials/credentials-local/lib/index.js',
    'packages/credentials/authorization/lib/index.js',
    'packages/client/connection/lib/index.js', 'packages/host/webserver/lib/index.js']) {
    await access(resolve(checkout, artifact))
  }
  const home = await mkdtemp(join(tmpdir(), 'dsh-external-auth-composition-'))
  let child
  let completion
  let expired = false
  let output = ''
  let result
  let failure
  // Cleanup is registered before launching; even a case timeout kills and reaps the child first.
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    try { await completion }
    finally { await rm(home, { recursive: true, force: true }) }
  })
  child = fork(fileURLToPath(new URL('./fixtures/composition/run.js', import.meta.url)), [], {
    cwd: home,
    execArgv: [],
    env: { ...process.env, DSH_CHECKOUT: resolve(checkout), DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  completion = new Promise((accept, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => accept({ code, signal }))
  })
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  child.on('message', message => {
    if (message.type === 'composition-result') result = message.report
    if (message.type === 'composition-failure') failure = message
  })
  const timer = setTimeout(() => { expired = true; child.kill('SIGKILL') }, 30000)
  t.after(() => clearTimeout(timer))
  const exit = await completion
  clearTimeout(timer)
  assert.equal(expired, false, 'Composition child exceeded its owned deadline')
  assert.equal(exit.signal, null, 'Composition child must exit without a kill signal')
  assert.ok(!output.includes('composition-private-access-token'), 'Child output must not contain a grant')
  assert.ok(!output.includes('composition-private-provider-response'), 'Child output must not contain provider response bodies')
  assert.ok(!output.includes('?token='), 'Child output must not contain launch-token URLs')
  assert.equal(exit.code, 0, failure
    ? `Composition failed during ${failure.stage}: ${failure.error}${failure.assertion ? ` (${failure.assertion})` : ''}${failure.location ?? ''}`
    : 'Composition child failed before reporting; inspect the built DSH prerequisites')
  assert.deepEqual(result, {
    successAfterStorage: true, cancellation: true, privateAttempt: true, apiPeerDenied: true,
    unauthenticatedDenied: true, noCommitRejected: true, privateProviderFailure: true, disposed: true,
  })
})
