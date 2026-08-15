import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { promisify } from 'node:util'

import { ProfilePackManager, parseProfilePack, signProfilePack, verifyProfilePackEnvelope } from '../dist/profile-pack.mjs'
import { readProfile } from '../dist/profile.mjs'
import { ExtensionManager } from '../dist/manager.mjs'

const execFileAsync = promisify(execFile)

function registryFixture() {
  const release = {
    id: 'sample@1.2.3',
    install: {
      mode: 'profile-bundle',
      adapter: 'official-profile/v1',
      packageName: '@example/dsh-sample',
      spec: '1.2.3',
    },
  }
  const document = {
    schema: 'omdsh-registry/v1',
    snapshotId: `sha256:${'a'.repeat(64)}`,
    revision: 1,
    origins: ['https://hub.omdsh.dev/registry-v1.json'],
    entries: [{ id: 'sample', license: 'MIT', install: release.install, releases: [release] }],
  }
  return {
    document,
    current: async () => ({ document, source: 'test', warning: null }),
    resolveAction: async (id, releaseId) => {
      if (id !== 'sample' || releaseId !== release.id) throw new Error('not found')
      return { id, releaseId, install: release.install }
    },
  }
}

function officialPackage() {
  return {
    state: 'observed',
    command: { name: 'dsh', version: '0.1.0-rc.6' },
    binding: 'local-install-and-lock',
    artifact: {
      source: 'npm',
      name: '@deepseek-ai/dsh',
      version: '0.1.0-rc.6',
      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
    },
  }
}

async function fixtureHome() {
  const home = await mkdtemp(join(tmpdir(), 'omdsh-profile-pack-'))
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { '@example/dsh-sample': '1.2.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@example/dsh-sample'] } },
  }, null, 2)}\n`)
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  return home
}

function exportManager(home, registry) {
  return {
    home,
    registry,
    resolve: async () => 'web',
    inspect: async () => readProfile(home, 'web'),
    officialPackage: async () => officialPackage(),
  }
}

test('exports a Profile and a custom Agent Preset as a portable content-addressed pack', async (t) => {
  const home = await fixtureHome()
  t.after(() => rm(home, { recursive: true, force: true }))
  const preset = join(home, '.agent-presets', 'research')
  await mkdir(join(preset, 'skills', 'source-check'), { recursive: true })
  await writeFile(join(preset, 'agent.cordis.yml'), '- id: agent\n  name: example\n')
  await writeFile(join(preset, 'preset.yml'), 'name: Research\ndescription: Source-backed research\n')
  await writeFile(join(preset, 'skills', 'source-check', 'SKILL.md'), '# Source check\n')

  const registry = registryFixture()
  const packs = new ProfilePackManager({ manager: exportManager(home, registry), registry })
  const pack = await packs.exportProfile({
    profile: 'web',
    preset: 'research',
    id: 'research-workbench',
    version: '1.0.0',
    now: new Date('2026-08-15T00:00:00.000Z'),
  })

  assert.equal(pack.schema, 'omdsh-profile-pack/v1')
  assert.deepEqual(pack.plugins.map(({ projectId, releaseId, enabled }) => ({ projectId, releaseId, enabled })), [
    { projectId: 'sample', releaseId: 'sample@1.2.3', enabled: true },
  ])
  assert.equal(pack.plugins[0].license.expression, 'MIT')
  assert.deepEqual(pack.sourcePlugins, [])
  assert.equal(pack.agentPreset.mode, 'embedded')
  assert.deepEqual(pack.agentPreset.files.map(file => file.path), [
    'agent.cordis.yml', 'preset.yml', 'skills/source-check/SKILL.md',
  ])
  assert.equal(parseProfilePack(structuredClone(pack)).digest, pack.digest)

  const tampered = structuredClone(pack)
  tampered.plugins[0].enabled = false
  assert.throws(() => parseProfilePack(tampered), /digest does not match/)
})

test('rejects custom presets that contain credentials or absolute user paths', async (t) => {
  const home = await fixtureHome()
  t.after(() => rm(home, { recursive: true, force: true }))
  const preset = join(home, '.agent-presets', 'unsafe')
  await mkdir(preset, { recursive: true })
  await writeFile(join(preset, 'agent.cordis.yml'), 'root: /Users/alice/private-project\n')
  const registry = registryFixture()
  const packs = new ProfilePackManager({ manager: exportManager(home, registry), registry })
  await assert.rejects(
    packs.exportProfile({ preset: 'unsafe', id: 'unsafe-pack', version: '1.0.0' }),
    /absolute user path/,
  )
})

test('builds a Workshop distribution with a built-in official preset', async (t) => {
  const home = await fixtureHome()
  t.after(() => rm(home, { recursive: true, force: true }))
  const registry = registryFixture()
  const packs = new ProfilePackManager({ manager: exportManager(home, registry), registry })
  const pack = await packs.buildDistribution({
    schema: 'omdsh-distribution/v1',
    id: 'starter-kit',
    version: '2.0.0-rc.1',
    agentPreset: { mode: 'builtin', id: 'code' },
    items: [{ projectId: 'sample', releaseId: 'sample@1.2.3', enabled: true }],
  }, { now: new Date('2026-08-15T01:00:00.000Z') })

  assert.deepEqual(pack.distribution, { id: 'starter-kit', version: '2.0.0-rc.1' })
  assert.deepEqual(pack.agentPreset, { mode: 'builtin', id: 'code', sha256: null, files: [] })
  assert.equal((await packs.inspect(pack)).valid, true)
})

test('builds an author-owned fixed-source component with explicit license and trust boundary', async (t) => {
  const home = await fixtureHome()
  t.after(() => rm(home, { recursive: true, force: true }))
  const registry = registryFixture()
  const packs = new ProfilePackManager({ manager: exportManager(home, registry), registry })
  const ref = 'b'.repeat(40)
  const pack = await packs.buildDistribution({
    schema: 'omdsh-pack-source/v1',
    id: 'my-kit',
    version: '0.1.0',
    agentPreset: { mode: 'builtin', id: 'standard' },
    items: [{
      type: 'source', id: 'my-plugin', packageName: '@example/my-plugin', version: '0.1.0', enabled: true,
      license: { expression: 'Apache-2.0', source: 'package-manifest' },
      source: { repository: 'https://github.com/example/my-plugin', ref },
      install: { mode: 'profile-bundle', spec: `github:example/my-plugin#${ref}` },
    }],
  })
  const inspection = await packs.inspect(pack)
  assert.equal(pack.sourcePlugins[0].license.expression, 'Apache-2.0')
  assert.equal(inspection.trust.level, 'experimental-fixed-source')
  assert.equal(inspection.trust.publicAdmissionEligible, false)
  assert.match(inspection.warnings.join('; '), /--trust-source/)
})

test('signs publisher provenance and rejects tampered or untrusted envelopes', async (t) => {
  const home = await fixtureHome()
  t.after(() => rm(home, { recursive: true, force: true }))
  const registry = registryFixture()
  const packs = new ProfilePackManager({ manager: exportManager(home, registry), registry })
  const pack = await packs.exportProfile({ id: 'signed-kit', version: '1.0.0', now: new Date('2026-08-15T00:00:00.000Z') })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const envelope = signProfilePack(pack, {
    privateKey,
    keyId: 'example/releases-2026',
    publisher: 'example',
    source: `https://github.com/example/distributions/tree/${'a'.repeat(40)}`,
    issuedAt: new Date('2026-08-15T01:00:00.000Z'),
  })
  assert.equal(verifyProfilePackEnvelope(envelope, publicKey).pack.digest, pack.digest)
  assert.equal((await packs.inspect(envelope)).signature.state, 'signed-unverified')
  assert.equal((await packs.inspect(envelope, { publicKey })).signature.state, 'verified')
  await assert.rejects(() => packs.apply(envelope), /requires the trusted public key/)
  const tampered = structuredClone(envelope)
  tampered.provenance.publisher = 'attacker'
  assert.throws(() => verifyProfilePackEnvelope(tampered, publicKey), /signature is invalid/)
})

test('applies an embedded preset only with trust and stages Registry reconciliation', async (t) => {
  const sourceHome = await fixtureHome()
  const targetHome = await mkdtemp(join(tmpdir(), 'omdsh-profile-pack-target-'))
  t.after(() => Promise.all([
    rm(sourceHome, { recursive: true, force: true }),
    rm(targetHome, { recursive: true, force: true }),
  ]))
  const preset = join(sourceHome, '.agent-presets', 'research')
  await mkdir(preset, { recursive: true })
  await writeFile(join(preset, 'agent.cordis.yml'), '- id: agent\n  name: example\n')
  const registry = registryFixture()
  const sourcePacks = new ProfilePackManager({ manager: exportManager(sourceHome, registry), registry })
  const pack = await sourcePacks.exportProfile({ preset: 'research', id: 'research', version: '1.0.0' })

  let staged = null
  const targetManager = {
    home: targetHome,
    registry,
    officialPackage: async () => officialPackage(),
    status: async () => staged === null
      ? { logicalProfile: 'web', pending: null }
      : { logicalProfile: 'web', pending: 'candidate-1' },
    stageMarketRecipe: async (items, options) => {
      staged = { items, options }
      return { logicalProfile: 'web', pending: 'candidate-1' }
    },
    discard: async () => { staged = null },
  }
  const targetPacks = new ProfilePackManager({ manager: targetManager, registry })
  await assert.rejects(targetPacks.apply(pack), /--trust-preset/)
  const result = await targetPacks.apply(pack, { trustPreset: true })

  assert.equal(result.state, 'candidate-ready')
  assert.equal(staged.options.reconcileRegistryManaged, true)
  assert.equal(staged.options.allowNoChanges, true)
  assert.equal(await readFile(join(targetHome, '.agent-presets', 'research', 'agent.cordis.yml'), 'utf8'), '- id: agent\n  name: example\n')
})

test('fixed-source components require trust and are staged in the same candidate', async (t) => {
  const home = await fixtureHome()
  t.after(() => rm(home, { recursive: true, force: true }))
  const registry = registryFixture()
  const ref = 'c'.repeat(40)
  const sourcePacks = new ProfilePackManager({ manager: exportManager(home, registry), registry })
  const pack = await sourcePacks.buildDistribution({
    schema: 'omdsh-pack-source/v1', id: 'source-kit', version: '0.1.0',
    agentPreset: { mode: 'builtin', id: 'standard' },
    items: [{
      type: 'source', id: 'mine', packageName: '@example/mine', version: '0.1.0', enabled: true,
      license: { expression: 'MIT', source: 'author-declared' },
      source: { repository: 'https://github.com/example/mine', ref },
      install: { mode: 'profile-bundle', spec: `github:example/mine#${ref}` },
    }],
  })
  let staged
  const manager = {
    home, registry,
    officialPackage: async () => officialPackage(),
    status: async () => ({ logicalProfile: 'web', current: 'web', previous: null, pending: staged ? 'candidate-1' : null, bootAttempt: null, failed: [], events: [] }),
    stageMarketRecipe: async (items, options) => { staged = { items, options }; return { pending: 'candidate-1' } },
    discard: async () => { staged = null },
  }
  const packs = new ProfilePackManager({ manager, registry })
  await assert.rejects(() => packs.apply(pack), /--trust-source/)
  const result = await packs.apply(pack, { trustSource: true })
  assert.equal(result.state, 'candidate-ready')
  assert.equal(staged.options.sourceItems[0].install.packageName, '@example/mine')
  assert.equal(staged.options.sourceItems[0].install.spec, `github:example/mine#${ref}`)
  assert.equal(result.fixedSourcePlugins[0].license.expression, 'MIT')
})

test('plans an installation without staging a candidate or writing instance state', async (t) => {
  const home = await fixtureHome()
  t.after(() => rm(home, { recursive: true, force: true }))
  const registry = registryFixture()
  const ref = 'd'.repeat(40)
  let staged = 0
  const manager = {
    home,
    registry,
    officialPackage: async () => officialPackage(),
    status: async () => ({
      logicalProfile: 'web', current: 'web', previous: null, pending: null,
      bootAttempt: null, failed: [], events: [],
    }),
    stageMarketRecipe: async () => { staged += 1; throw new Error('plan must not stage') },
  }
  const packs = new ProfilePackManager({ manager, registry })
  const pack = await packs.buildDistribution({
    schema: 'omdsh-pack-source/v1', id: 'source-kit', version: '0.1.0',
    agentPreset: { mode: 'builtin', id: 'standard' },
    items: [{
      type: 'source', id: 'mine', packageName: '@example/mine', version: '0.1.0', enabled: true,
      license: { expression: 'MIT', source: 'author-declared' },
      source: { repository: 'https://github.com/example/mine', ref },
      install: { mode: 'profile-bundle', spec: `github:example/mine#${ref}` },
    }],
  })

  const blocked = await packs.plan(pack, { instance: 'my-world' })
  assert.equal(blocked.readOnly, true)
  assert.equal(blocked.applicable, false)
  assert.equal(blocked.checks.fixedSource[0].state, 'trust-required')
  assert.match(blocked.blockers.join('; '), /--trust-source/)

  const ready = await packs.plan(pack, { instance: 'my-world', trustSource: true })
  assert.equal(ready.applicable, true)
  assert.equal(ready.checks.registry.state, 'ready')
  assert.equal(ready.checks.runtime.state, 'ready')
  assert.equal(staged, 0)
  await assert.rejects(readFile(join(home, '.omdsh', 'state.json'), 'utf8'), error => error?.code === 'ENOENT')
})

test('runs a fixed-source pack through the real candidate transaction and discards it on rollback', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'omdsh-pack-transaction-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2)}\n`)
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')

  const registry = registryFixture()
  const ref = 'e'.repeat(40)
  const spec = `github:example/mine#${ref}`
  const runner = async (_command, args) => {
    const profileIndex = args.indexOf('--profile')
    const selected = profileIndex === -1 ? 'web' : args[profileIndex + 1]
    if (args[0] === 'plugin' && args.includes('add')) {
      const filename = join(home, 'profiles', selected, 'package.json')
      const manifest = JSON.parse(await readFile(filename, 'utf8'))
      manifest.dependencies['@example/mine'] = spec
      await writeFile(filename, `${JSON.stringify(manifest, null, 2)}\n`)
    }
    return { code: 0, stdout: args.includes('--version') ? '0.1.0-rc.6\n' : '', stderr: '' }
  }
  const manager = new ExtensionManager({ home, registry, runner })
  manager.officialPackage = async () => officialPackage()
  const packs = new ProfilePackManager({ manager, registry })
  const pack = await packs.buildDistribution({
    schema: 'omdsh-pack-source/v1', id: 'source-kit', version: '0.1.0',
    agentPreset: { mode: 'builtin', id: 'standard' },
    items: [{
      type: 'source', id: 'mine', packageName: '@example/mine', version: '0.1.0', enabled: true,
      license: { expression: 'Apache-2.0', source: 'package-manifest' },
      source: { repository: 'https://github.com/example/mine', ref },
      install: { mode: 'profile-bundle', spec },
    }],
  })

  assert.equal((await packs.plan(pack, { instance: 'my-world', trustSource: true })).applicable, true)
  const applied = await packs.apply(pack, { instance: 'my-world', trustSource: true })
  assert.equal(applied.state, 'candidate-ready')
  const candidate = applied.candidate
  const installed = await readProfile(home, candidate)
  assert.equal(installed.installed['@example/mine'], spec)
  assert.equal(installed.enabled.includes('@example/mine'), true)
  assert.equal((await packs.instance('my-world')).state, 'candidate-ready')

  const rolledBack = await packs.rollback('my-world')
  assert.equal(rolledBack.state, 'candidate-discarded')
  const status = await manager.status('web')
  assert.equal(status.pending, null)
  assert.equal(status.current, 'web')
  assert.equal(status.failed.includes(candidate), true)
})

test('tracks a named pack instance through diff, update, confirmation, and generation rollback', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'omdsh-pack-instance-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const registry = registryFixture()
  let candidateNumber = 0
  let recoveredTo = null
  const profileStatus = {
    logicalProfile: 'web', current: 'web', previous: null, pending: null, bootAttempt: null, failed: [], events: [],
  }
  const manager = {
    home,
    registry,
    officialPackage: async () => officialPackage(),
    status: async () => structuredClone(profileStatus),
    stageMarketRecipe: async () => {
      candidateNumber += 1
      profileStatus.pending = `candidate-${candidateNumber}`
      return structuredClone(profileStatus)
    },
    discard: async () => {
      if (profileStatus.pending !== null) profileStatus.failed.push(profileStatus.pending)
      profileStatus.pending = null
    },
    recover: async (_profile, options) => {
      recoveredTo = options.to
      profileStatus.current = options.to
      profileStatus.previous = null
      profileStatus.pending = null
      profileStatus.bootAttempt = null
      return { to: options.to }
    },
  }
  const packs = new ProfilePackManager({ manager, registry })
  const first = await packs.buildDistribution({
    schema: 'omdsh-distribution/v1', id: 'starter-kit', version: '1.0.0',
    agentPreset: { mode: 'builtin', id: 'code' },
    items: [{ projectId: 'sample', releaseId: 'sample@1.2.3', enabled: true }],
  }, { now: new Date('2026-08-15T01:00:00.000Z') })
  const second = await packs.buildDistribution({
    schema: 'omdsh-distribution/v1', id: 'starter-kit', version: '2.0.0',
    agentPreset: { mode: 'builtin', id: 'minimal' },
    items: [{ projectId: 'sample', releaseId: 'sample@1.2.3', enabled: false }],
  }, { now: new Date('2026-08-15T02:00:00.000Z') })

  const staged = await packs.apply(first, { instance: 'my-world' })
  assert.equal(staged.instance, 'my-world')
  assert.equal((await packs.instance('my-world')).state, 'candidate-ready')
  profileStatus.previous = 'web'
  profileStatus.current = 'candidate-1'
  profileStatus.pending = null
  profileStatus.bootAttempt = { generation: 'candidate-1', startedAt: '2026-08-15T01:01:00.000Z' }
  assert.equal((await packs.instance('my-world')).state, 'booting')
  profileStatus.bootAttempt = null
  assert.equal((await packs.instance('my-world')).state, 'current')

  const diff = await packs.diff(second, undefined, { instance: 'my-world' })
  assert.equal(diff.hasChanges, true)
  assert.equal(diff.changes.changed[0].projectId, 'sample')
  assert.equal(diff.changes.agentPreset.to.id, 'minimal')
  await packs.update(second, { instance: 'my-world' })
  assert.equal((await packs.instance('my-world')).state, 'candidate-ready')
  profileStatus.previous = 'candidate-1'
  profileStatus.current = 'candidate-2'
  profileStatus.pending = null
  profileStatus.bootAttempt = null
  assert.equal((await packs.instance('my-world')).instance.current.pack.version, '2.0.0')

  const rollback = await packs.rollback('my-world')
  assert.equal(rollback.state, 'rolled-back')
  assert.equal(recoveredTo, 'candidate-1')
  assert.equal((await packs.instance('my-world')).instance.current.pack.version, '1.0.0')
  assert.equal(rollback.externalSideEffects, 'not-covered')
})

test('CLI exports and inspects a built-in-preset pack end to end', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'omdsh-profile-pack-cli-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2)}\n`)
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  const dsh = join(home, 'fake-dsh')
  await writeFile(dsh, '#!/bin/sh\nprintf "0.1.0-rc.6\\n"\n', { mode: 0o755 })
  const output = join(home, 'web.dshpack')
  const cli = new URL('../dist/cli.mjs', import.meta.url)

  const exported = await execFileAsync(process.execPath, [
    cli.pathname, 'pack', 'export', '--home', home, '--dsh', dsh,
    '--id', 'web-kit', '--version', '1.0.0', '--output', output,
  ])
  assert.equal(JSON.parse(exported.stdout).output, output)

  const inspected = await execFileAsync(process.execPath, [cli.pathname, 'pack', 'inspect', output])
  const inspection = JSON.parse(inspected.stdout)
  assert.equal(inspection.valid, true)
  assert.equal(inspection.agentPreset.id, 'standard')
  assert.equal(inspection.runtime.version, '0.1.0-rc.6')

  const planned = await execFileAsync(process.execPath, [
    cli.pathname, 'pack', 'plan', output, '--home', home, '--dsh', dsh,
  ])
  const plan = JSON.parse(planned.stdout)
  assert.equal(plan.readOnly, true)
  assert.equal(plan.applicable, true)
  assert.equal(plan.checks.registry.state, 'ready')
  assert.equal(plan.checks.runtime.state, 'ready')

  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(home, 'publisher.pem')
  const publicKeyPath = join(home, 'publisher.pub')
  const signedOutput = join(home, 'web.signed.dshpack')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  await execFileAsync(process.execPath, [
    cli.pathname, 'pack', 'sign', output, '--home', home,
    '--private-key', privateKeyPath, '--key-id', 'example/releases-2026', '--publisher', 'example', '--output', signedOutput,
  ])
  const signedInspection = await execFileAsync(process.execPath, [
    cli.pathname, 'pack', 'inspect', signedOutput, '--home', home, '--trusted-key', publicKeyPath,
  ])
  assert.equal(JSON.parse(signedInspection.stdout).signature.state, 'verified')
})
