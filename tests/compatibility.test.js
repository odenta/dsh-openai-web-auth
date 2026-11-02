import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { developedAgainstDsh, warnVersionDrift } from '../compatibility.js'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('runtime peers are non-blocking and version detection is optional and packaged', () => {
  assert.deepEqual(manifest.peerDependencies, {
    '@deepseek-ai/cordis': '*',
    '@deepseek-ai/schemastery': '*',
    '@deepseek-ai/dsh-credentials': '*',
    '@deepseek-ai/dsh-app-boot': '*',
  })
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-app-boot'].optional, true)
  assert.equal(manifest.engines?.dsh, undefined)
  assert.ok(manifest.files.includes('compatibility.js'))
})

test('baseline is documented and does not warn', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(readme.includes(`| DSH | \`${developedAgainstDsh}\` |`))
  await warnVersionDrift({ warn() { assert.fail('Baseline must not warn') } }, async () => ({
    getDshRuntimeVersion: () => developedAgainstDsh,
  }))
})

test('version drift warns once with both versions and continues', async () => {
  for (const version of ['0.2.2-alpha.2', '0.1.0', '1.0.0']) {
    const messages = []
    await warnVersionDrift({ warn: message => messages.push(message) }, async () => ({
      getDshRuntimeVersion: () => version,
    }))
    assert.equal(messages.length, 1)
    assert.ok(messages[0].includes(developedAgainstDsh))
    assert.ok(messages[0].includes(version))
    assert.match(messages[0], /Compatibility is not guaranteed; continuing/)
  }
})

test('unavailable or failed detection silently preserves startup', async () => {
  const logger = { warn() { assert.fail('Unavailable detection must be silent') } }
  for (const load of [
    async () => { throw new Error('Module unavailable') },
    async () => ({}),
    async () => ({ getDshRuntimeVersion() { throw new Error('Unavailable metadata') } }),
    ...[undefined, null, '', 42].map(version => async () => ({ getDshRuntimeVersion: () => version })),
  ]) await warnVersionDrift(logger, load)
})

test('actual DSH compatibility gate accepts baseline, current, and future prereleases', {
  skip: process.env.DSH_CHECKOUT ? false : 'Set DSH_CHECKOUT to test the real compatibility gate.',
}, async () => {
  const bootUrl = pathToFileURL(resolve(
    process.env.DSH_CHECKOUT, 'packages/boot/app-boot/lib/index.js',
  )).href
  const { evaluatePluginCompatibility, getDshRuntimeVersion } = await import(bootUrl)
  // Supply the optional profile peer, then exercise the production dynamic-import path.
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return next(specifier === '@deepseek-ai/dsh-app-boot'
        && context.parentURL === new URL('../compatibility.js', import.meta.url).href
        ? bootUrl : specifier, context)
    },
  })
  const messages = []
  try { await warnVersionDrift({ warn: message => messages.push(message) }) }
  finally { hooks.deregister() }
  const current = getDshRuntimeVersion()
  assert.equal(messages.length, current === developedAgainstDsh ? 0 : 1)
  if (messages.length) assert.ok(messages[0].includes(current))
  for (const version of [developedAgainstDsh, '0.2.2-alpha.2', '1.0.0-alpha.1']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined)
  }
})
