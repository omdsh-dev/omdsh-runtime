import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const FIBER_ACTIVE = 2

/**
 * RC contract family targeted at the expected official npm artifact.
 * Doctor can bind an explicit local `dsh` executable to a matching installed
 * package and lock integrity. The config probe observes exact RC Loader rows;
 * release integration smoke tests verify runtime behavior. Unknown facts stay
 * unknown and version alone never grants install authority.
 */
export const OFFICIAL_V1_CONTRACT = Object.freeze({
  family: 'official-v1',
  profileBundles: 'dsh.profile.bundles',
  bundlePatch: 'dsh.bundle.patch',
  clientManifests: Object.freeze(['dsh.client']),
  clientPlatform: 'web',
  settingsSlot: 'settings.section',
  httpService: 'webServer',
  loaderActiveState: FIBER_ACTIVE,
  repositoryPluginRow: 'repository-plugins',
  repositoryPluginPackage: '@deepseek-ai/dsh-repository-plugin',
})

export const OFFICIAL_V1_EXPECTED_PACKAGE = Object.freeze({
  source: 'npm',
  name: '@deepseek-ai/dsh',
})

export const OFFICIAL_V1_DOCUMENTED_CAPABILITIES = Object.freeze({
  hostCapabilities: Object.freeze({
    state: 'unknown',
    reason: 'public-evidence-required',
    integration: 'guided',
  }),
  recoveryLayers: Object.freeze({
    runtime: 'unknown',
    generation: 'omdsh-cross-restart',
    externalEffects: 'not-reversible',
  }),
})

function yamlScalar(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function loaderRows(output) {
  const lines = output.split(/\r?\n/)
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const id = /^(\s*)-\s+id:\s*(.+?)\s*$/.exec(lines[index])
    if (id === null) continue
    const indent = id[1].length
    const row = { id: yamlScalar(id[2]), name: null, disabled: false }
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue
      const leading = /^\s*/.exec(line)[0].length
      if (leading <= indent && /^\s*-\s+/.test(line)) break
      const name = /^\s*name:\s*(.+?)\s*$/.exec(line)
      if (name !== null) row.name = yamlScalar(name[1])
      const disabled = /^\s*disabled:\s*(.+?)\s*$/.exec(line)
      if (disabled !== null) row.disabled = yamlScalar(disabled[1]) === 'true'
    }
    rows.push(Object.freeze(row))
  }
  return rows
}

function hasRow(rows, id, name) {
  return rows.some(row => row.id === id && row.name === name)
}

/**
 * Inspect only exact, allowlisted Loader rows in an official config dump.
 * This narrow line parser never evaluates YAML tags or embedded code.
 */
export function inspectOfficialCapabilitiesDumpOfficialV1(output, profile) {
  if (typeof output !== 'string') throw new Error('official config dump must be text')
  const rows = loaderRows(output)
  const repositoryPlugin = hasRow(
    rows, OFFICIAL_V1_CONTRACT.repositoryPluginRow, OFFICIAL_V1_CONTRACT.repositoryPluginPackage,
  )
  const capabilities = {
    schema: 'omdsh.official-capabilities/v1',
    family: OFFICIAL_V1_CONTRACT.family,
    profile,
    ...OFFICIAL_V1_DOCUMENTED_CAPABILITIES,
    repositoryPlugin: Object.freeze({
      state: repositoryPlugin ? 'available' : 'unavailable',
      integration: repositoryPlugin ? 'patch-existing-row' : 'guided',
      reason: repositoryPlugin ? 'official-row-present' : 'official-row-missing',
    }),
    webIntegration: Object.freeze({
      state: 'unknown',
      evidence: 'public-evidence-required',
      reason: 'public-evidence-required',
      service: OFFICIAL_V1_CONTRACT.httpService,
      settingsSlot: OFFICIAL_V1_CONTRACT.settingsSlot,
    }),
  }
  return Object.freeze(capabilities)
}

export async function probeOfficialCapabilitiesOfficialV1(manager, profile) {
  try {
    const result = await manager.runDsh(['--profile', profile, '--dump-default-config'])
    return inspectOfficialCapabilitiesDumpOfficialV1(result.stdout, profile)
  } catch {
    return Object.freeze({
      schema: 'omdsh.official-capabilities/v1',
      family: OFFICIAL_V1_CONTRACT.family,
      profile,
      ...OFFICIAL_V1_DOCUMENTED_CAPABILITIES,
      repositoryPlugin: Object.freeze({ state: 'unknown', integration: 'guided', reason: 'probe-failed' }),
      webIntegration: Object.freeze({
        state: 'unknown', evidence: 'probe-failed', reason: 'probe-failed',
        service: OFFICIAL_V1_CONTRACT.httpService, settingsSlot: OFFICIAL_V1_CONTRACT.settingsSlot,
      }),
    })
  }
}

export function inspectOfficialCommandVersionOfficialV1(output) {
  if (typeof output !== 'string') throw new Error('official package version must be text')
  const version = output.trim()
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('official package did not return an exact semantic version')
  }
  return Object.freeze({
    schema: 'omdsh.official-package-observation/v1',
    state: 'observed',
    expectedArtifact: OFFICIAL_V1_EXPECTED_PACKAGE,
    command: Object.freeze({ name: 'dsh', version }),
    binding: 'not-verified',
    assessment: 'unassessed',
  })
}

async function localPackageIdentity(manager, commandVersion) {
  if (typeof manager.dshBin !== 'string' || manager.dshBin === '' || !manager.dshBin.includes('/')) return null
  try {
    const resolvedBin = await realpath(manager.dshBin)
    let resolvedRoot = dirname(resolvedBin)
    let manifest
    for (let depth = 0; depth < 3; depth += 1) {
      manifest = await readFile(join(resolvedRoot, 'package.json'), 'utf8').then(JSON.parse).catch(() => null)
      if (manifest?.name === OFFICIAL_V1_EXPECTED_PACKAGE.name) break
      const parent = dirname(resolvedRoot)
      if (parent === resolvedRoot) return null
      resolvedRoot = parent
    }
    if (manifest?.name !== OFFICIAL_V1_EXPECTED_PACKAGE.name) return null
    const lock = JSON.parse(await readFile(resolve(resolvedRoot, '..', '..', '.package-lock.json'), 'utf8'))
    const lockEntry = lock?.packages?.['node_modules/@deepseek-ai/dsh']
    const binTarget = manifest?.bin?.dsh
    if (manifest?.name !== OFFICIAL_V1_EXPECTED_PACKAGE.name
      || manifest?.version !== commandVersion
      || lockEntry?.version !== commandVersion
      || typeof lockEntry?.integrity !== 'string'
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(lockEntry.integrity)
      || typeof binTarget !== 'string'
      || !resolve(resolvedRoot, binTarget).startsWith(`${resolvedRoot}/`)) return null
    if (resolvedBin !== resolve(resolvedRoot, binTarget)) return null
    return Object.freeze({
      root: resolvedRoot,
      artifact: Object.freeze({
        source: 'npm',
        name: manifest.name,
        version: manifest.version,
        integrity: lockEntry.integrity,
      }),
      binding: 'local-install-and-lock',
      assessment: 'observed-exact',
    })
  } catch {
    return null
  }
}

export async function observeOfficialPackageOfficialV1(manager) {
  try {
    const result = await manager.runDsh(['--version'])
    const observation = inspectOfficialCommandVersionOfficialV1(result.stdout)
    const identity = await localPackageIdentity(manager, observation.command.version)
    return identity === null ? observation : Object.freeze({
      ...observation,
      artifact: identity.artifact,
      binding: identity.binding,
      assessment: identity.assessment,
    })
  } catch {
    return Object.freeze({
      schema: 'omdsh.official-package-observation/v1',
      state: 'unknown',
      reason: 'version-probe-failed',
    })
  }
}

export function loaderTreeIsActiveOfficialV1(loader) {
  if (loader === undefined || typeof loader.entries !== 'function') return false
  for (const entry of loader.entries()) {
    if (entry?.disabled === true) continue
    if (entry?.fiber?.state !== FIBER_ACTIVE) return false
  }
  return true
}

export function registerManagementRouteOfficialV1(ctx, route) {
  if (typeof ctx?.inject !== 'function') return false
  ctx.inject([OFFICIAL_V1_CONTRACT.httpService], (webCtx) => {
    if (typeof webCtx?.effect !== 'function' || typeof webCtx?.webServer?.register !== 'function') {
      throw new Error('DeepSeek Harness official-v1 webServer contract is unavailable')
    }
    webCtx.effect(
      () => webCtx.webServer.register(route),
      'omdsh-runtime: official-v1 management API',
    )
  })
  return true
}

export function installRuntimeReadyOfficialV1(ctx, manager, environment = process.env) {
  const logicalProfile = environment.OMDSH_LOGICAL_PROFILE
  const generation = environment.OMDSH_GENERATION
  const token = environment.OMDSH_BOOT_TOKEN
  if (typeof logicalProfile !== 'string' || logicalProfile === ''
    || typeof generation !== 'string' || generation === ''
    || typeof token !== 'string' || token === '') return false

  if (typeof ctx?.get !== 'function' || typeof ctx?.effect !== 'function') return false
  ctx.effect(() => {
    let live = true
    // Cordis v1 completes the current Fiber's initial _reload() in a promise
    // continuation after a synchronous apply(). A timer turn starts only after
    // that continuation, so Loader.await() can observe this bundle as ACTIVE
    // instead of joining the bundle while it is still LOADING.
    const timer = setTimeout(() => {
      if (!live) return
      const loader = ctx.get('loader')
      if (loader === undefined || typeof loader.await !== 'function') return
      void loader.await().then(async () => {
        // Cordis services may be returned as a fresh traceable Proxy on every
        // ctx.get() call, so object identity is not a lifecycle signal.
        if (!live || ctx.get('loader') === undefined) return
        if (!loaderTreeIsActiveOfficialV1(loader)) return
        await manager.runtimeReady({ logicalProfile, generation, token })
      }).catch((error) => {
        ctx?.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
      })
    }, 0)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, 'omdsh-runtime: official-v1 runtime-ready lifetime')
  return true
}
