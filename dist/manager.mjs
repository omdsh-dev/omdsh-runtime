import { spawn } from 'node:child_process'
import { resolveDshHome } from './paths.mjs'
import { readProfile, setEnabledBundles, updateGeneration } from './profile.mjs'
import {
  activatePending, confirmBoot, discardPending, extensionStatus, markCandidateReady,
  prepareCandidate, recoverProfile, resolveSelectedProfile, confirmRuntimeReady,
} from './generations.mjs'
import { launchDsh } from './launcher.mjs'
import { cleanupFailedGenerations, generationStorage } from './storage.mjs'
import {
  readRepositorySpecs, repositorySpecIdentity, writeRepositorySpecs,
} from './adapters/repository-config-v1.mjs'
import { observeOfficialPackageOfficialV1, probeOfficialCapabilitiesOfficialV1 } from './adapters/official-v1.mjs'
import { redactDiagnostic, withoutPackageCredentials } from './process-environment.mjs'

function defaultRunner(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let size = 0
    const collect = target => chunk => {
      size += chunk.length
      if (size <= 1024 * 1024) target.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({
      code: code ?? 1,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

function assertPackageName(value) {
  if (typeof value !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(value)) {
    throw new Error(`invalid package name ${JSON.stringify(value)}`)
  }
  return value
}

function packageInstallSpec(packageName, spec) {
  return /^(?:v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(spec)
    ? `${packageName}@${spec}`
    : spec
}

function withBundleEnabled(bundleNames, packageName, enabled) {
  const bundles = [...bundleNames]
  const index = bundles.indexOf(packageName)
  if (enabled && index === -1) bundles.push(packageName)
  if (!enabled && index !== -1) bundles.splice(index, 1)
  return bundles
}

export class ExtensionManager {
  constructor(options = {}) {
    this.home = resolveDshHome(options.home)
    this.dshBin = options.dshBin ?? 'dsh'
    this.runner = options.runner ?? defaultRunner
    this.registry = options.registry
    this.environment = options.environment ?? process.env
    this.capabilityCache = new Map()
  }

  status(profile = 'web') { return extensionStatus(this.home, profile) }
  resolve(profile = 'web') { return resolveSelectedProfile(this.home, profile) }
  recover(profile = 'web', options = {}) { return recoverProfile(this.home, profile, options) }
  activate(profile = 'web') { return activatePending(this.home, profile) }
  confirm(profile = 'web') { return confirmBoot(this.home, profile) }
  runtimeReady(options = {}) { return confirmRuntimeReady(this.home, options) }
  discard(profile = 'web', reason) { return discardPending(this.home, profile, reason) }
  storage(profile = 'web') { return generationStorage(this.home, profile) }
  cleanup(profile = 'web', options = {}) { return cleanupFailedGenerations(this.home, profile, options) }
  launch(args = [], profile = 'web', options = {}) {
    return launchDsh({
      ...options,
      environment: options.environment ?? this.environment,
      home: this.home,
      dshBin: this.dshBin,
      profile,
      args,
    })
  }

  async inspect(profile = 'web') {
    const selected = await this.resolve(profile)
    return readProfile(this.home, selected)
  }

  async capabilities(profile = 'web') {
    const selected = await this.resolve(profile)
    const cached = this.capabilityCache.get(selected)
    if (cached !== undefined) return cached
    const capabilities = await probeOfficialCapabilitiesOfficialV1(this, selected)
    if (capabilities.repositoryPlugin.state !== 'unknown') {
      this.capabilityCache.set(selected, capabilities)
    }
    return capabilities
  }

  officialPackage() {
    return observeOfficialPackageOfficialV1(this)
  }

  async requireRepositoryPlugin(profile = 'web') {
    const capabilities = await this.capabilities(profile)
    if (capabilities.repositoryPlugin.state !== 'available') {
      throw new Error(
        'official Repository Plugin is unavailable in this Harness distribution; use guided integration or upgrade the official distribution',
      )
    }
    return capabilities
  }

  async runDsh(args, options = {}) {
    const baseEnvironment = { ...this.environment, DSH_HOME: this.home }
    let result
    try {
      result = await this.runner(this.dshBin, args, {
        env: options.packageAccess === true
          ? baseEnvironment
          : withoutPackageCredentials(baseEnvironment),
      })
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      throw new Error(`dsh command failed: ${redactDiagnostic(raw, baseEnvironment)}`)
    }
    const stdout = typeof result?.stdout === 'string' ? result.stdout : ''
    const stderr = typeof result?.stderr === 'string' ? result.stderr : ''
    if (result?.code !== 0) {
      const raw = stderr.trim() || stdout.trim() || `exit ${String(result?.code ?? 'unknown')}`
      const detail = redactDiagnostic(raw, baseEnvironment)
      throw new Error(`dsh command failed: ${detail}`)
    }
    return { ...result, stdout, stderr }
  }

  async validateCandidate(candidate) {
    await this.runDsh(['--profile', candidate, '--dump-config'])
    await updateGeneration(this.home, candidate, metadata => ({ ...metadata, validation: 'dump-config' }))
  }

  async materializeCandidate(candidate) {
    await this.runDsh(['plugin', '--profile', candidate, 'install', '--ignore-scripts'], { packageAccess: true })
  }

  async stageBatchInstall(options) {
    const profile = options.profile ?? 'web'
    if (!Array.isArray(options.intents) || options.intents.length === 0) throw new Error('at least one install intent is required')
    const intents = options.intents.map((intent) => {
      const packageName = assertPackageName(intent.packageName)
      if (typeof intent.spec !== 'string' || intent.spec === '') throw new Error('package spec is required')
      return { ...intent, packageName }
    })
    if (new Set(intents.map(intent => intent.packageName)).size !== intents.length) {
      throw new Error('batch install contains duplicate package names')
    }
    const candidate = await prepareCandidate(this.home, profile)
    try {
      const baseline = await readProfile(this.home, candidate.id)
      let enabled = [...baseline.enabled]
      const operations = []
      for (const intent of intents) {
        const args = ['plugin', '--profile', candidate.id, 'add', packageInstallSpec(intent.packageName, intent.spec)]
        if (intent.allowScripts !== true) args.push('--ignore-scripts')
        await this.runDsh(args, { packageAccess: true })
        const installed = await readProfile(this.home, candidate.id)
        if (installed.installed[intent.packageName] === undefined) {
          throw new Error(`dsh installed no dependency named ${intent.packageName}`)
        }
        enabled = withBundleEnabled(enabled, intent.packageName, intent.enable === true)
        operations.push({
          type: intent.operationType ?? 'install',
          packageName: intent.packageName,
          spec: intent.spec,
          enabled: intent.enable === true,
          scripts: intent.allowScripts === true ? 'allowed' : 'blocked',
          ...(intent.entryId === undefined ? {} : { entryId: intent.entryId }),
          ...(intent.releaseId === undefined || intent.releaseId === null ? {} : { releaseId: intent.releaseId }),
          ...(options.collectionId === undefined ? {} : { collectionId: options.collectionId }),
        })
      }
      await setEnabledBundles(this.home, candidate.id, enabled)
      await updateGeneration(this.home, candidate.id, metadata => ({
        ...metadata,
        operations: [...metadata.operations, ...operations],
      }))
      await this.validateCandidate(candidate.id)
      await markCandidateReady(this.home, profile)
      return this.status(profile)
    } catch (error) {
      await discardPending(this.home, profile, error instanceof Error ? error.message : String(error)).catch(() => {})
      throw error
    }
  }

  async stageInstall(options) {
    return this.stageBatchInstall({
      profile: options.profile,
      intents: [options],
    })
  }

  async stageMarketInstall(id, options = {}) {
    return this.stageMarketBatch([{ id, releaseId: options.releaseId }], options)
  }

  async stageMarketBatch(items, options = {}) {
    if (this.registry === undefined) throw new Error('Registry is unavailable')
    const profile = options.profile ?? 'web'
    const current = await this.inspect(profile)
    const resolved = await Promise.all(items.map(async (item) => {
      const intent = await this.registry.resolveInstall(item.id, item.releaseId)
      return { ...intent, id: intent.id ?? item.id, releaseId: intent.releaseId ?? item.releaseId ?? null }
    }))
    if (new Set(resolved.map(intent => intent.packageName)).size !== resolved.length) {
      throw new Error('market batch resolves multiple entries to the same package')
    }
    const intents = resolved.map((intent) => {
      const updating = current.installed[intent.packageName] !== undefined
      const enable = options.enable === true
        || (options.enable === undefined && updating && current.enabled.includes(intent.packageName))
      return {
        packageName: intent.packageName,
        spec: intent.spec,
        enable,
        allowScripts: false,
        operationType: options.collectionId === undefined
          ? (updating ? 'market-update' : 'market-install')
          : (updating ? 'collection-update' : 'collection-install'),
        entryId: intent.id,
        releaseId: intent.releaseId,
      }
    })
    return this.stageBatchInstall({
      profile,
      intents,
      collectionId: options.collectionId,
    })
  }

  async stageMarketCollection(id, options = {}) {
    if (this.registry === undefined) throw new Error('Registry is unavailable')
    const collection = await this.registry.resolveCollection(id)
    return this.stageMarketBatch(
      collection.intents.map(intent => ({ id: intent.id, releaseId: intent.releaseId })),
      { ...options, collectionId: collection.id },
    )
  }

  async stageMarketRecipe(items, options = {}) {
    if (this.registry === undefined) throw new Error('Registry is unavailable')
    if (!Array.isArray(items) || items.length === 0) throw new Error('Recipe requires at least one item')
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Recipe contains duplicate projects')
    const profile = options.profile ?? 'web'
    const selected = await this.resolve(profile)
    const [current, currentRepositories] = await Promise.all([
      readProfile(this.home, selected),
      readRepositorySpecs(this.home, selected),
    ])
    const resolved = []
    for (const item of items) {
      if (typeof item.enabled !== 'boolean') throw new Error(`Recipe item ${JSON.stringify(item.id)} needs an enabled intent`)
      const action = await this.registry.resolveAction(item.id, item.releaseId)
      if (!['profile-bundle', 'repository-plugin'].includes(action.install.mode)) {
        throw new Error(`Recipe project ${JSON.stringify(item.id)} has no managed official adapter`)
      }
      if (action.install.mode === 'repository-plugin' && item.enabled !== true) {
        throw new Error(`Repository Plugin ${JSON.stringify(item.id)} has no independent disabled state`)
      }
      resolved.push({ ...item, action })
    }
    const packageNames = resolved.flatMap(item => item.action.install.mode === 'profile-bundle'
      ? [item.action.install.packageName]
      : [])
    if (new Set(packageNames).size !== packageNames.length) throw new Error('Recipe resolves multiple projects to the same package')
    const repositoryIdentities = resolved.flatMap(item => item.action.install.mode === 'repository-plugin'
      ? [repositorySpecIdentity(item.action.install.spec)]
      : [])
    if (new Set(repositoryIdentities).size !== repositoryIdentities.length) {
      throw new Error('Recipe resolves multiple projects to the same Repository Plugin')
    }
    const hasChanges = resolved.some((item) => {
      const install = item.action.install
      if (install.mode === 'profile-bundle') {
        return current.installed[install.packageName] !== install.spec
          || current.enabled.includes(install.packageName) !== item.enabled
      }
      const target = repositorySpecIdentity(install.spec)
      return currentRepositories.find(spec => repositorySpecIdentity(spec) === target) !== install.spec
    })
    if (!hasChanges) throw new Error('Recipe already matches the current Profile')
    if (resolved.some(item => item.action.install.mode === 'repository-plugin')) {
      await this.requireRepositoryPlugin(profile)
    }

    const candidate = await prepareCandidate(this.home, profile)
    try {
      const baseline = await readProfile(this.home, candidate.id)
      let enabled = [...baseline.enabled]
      const repositories = [...await readRepositorySpecs(this.home, candidate.id)]
      const operations = []
      for (const item of resolved) {
        const install = item.action.install
        if (install.mode === 'profile-bundle') {
          const installedSpec = baseline.installed[install.packageName]
          if (installedSpec !== install.spec) {
            await this.runDsh([
              'plugin', '--profile', candidate.id, 'add', packageInstallSpec(install.packageName, install.spec), '--ignore-scripts',
            ], { packageAccess: true })
            const installed = await readProfile(this.home, candidate.id)
            if (installed.installed[install.packageName] === undefined) {
              throw new Error(`dsh installed no dependency named ${install.packageName}`)
            }
          }
          enabled = withBundleEnabled(enabled, install.packageName, item.enabled)
          const wasEnabled = baseline.enabled.includes(install.packageName)
          const operation = installedSpec === undefined
            ? 'recipe-install'
            : installedSpec !== install.spec
              ? 'recipe-update'
              : wasEnabled === item.enabled ? 'recipe-keep' : item.enabled ? 'recipe-enable' : 'recipe-disable'
          operations.push({
            type: operation,
            recipeId: options.recipeId,
            entryId: item.action.id,
            releaseId: item.action.releaseId,
            packageName: install.packageName,
            spec: install.spec,
            enabled: item.enabled,
            scripts: 'blocked',
          })
          continue
        }
        const target = repositorySpecIdentity(install.spec)
        const index = repositories.findIndex(spec => repositorySpecIdentity(spec) === target)
        const previous = index === -1 ? undefined : repositories[index]
        if (index === -1) repositories.push(install.spec)
        else repositories[index] = install.spec
        operations.push({
          type: previous === undefined ? 'recipe-repository-install' : previous === install.spec ? 'recipe-repository-keep' : 'recipe-repository-update',
          recipeId: options.recipeId,
          entryId: item.action.id,
          releaseId: item.action.releaseId,
          spec: install.spec,
          adapter: install.adapter,
        })
      }
      await Promise.all([
        setEnabledBundles(this.home, candidate.id, enabled),
        writeRepositorySpecs(this.home, candidate.id, repositories),
      ])
      await updateGeneration(this.home, candidate.id, metadata => ({
        ...metadata,
        operations: [...metadata.operations, ...operations],
      }))
      await this.validateCandidate(candidate.id)
      await markCandidateReady(this.home, profile)
      return this.status(profile)
    } catch (error) {
      await discardPending(this.home, profile, error instanceof Error ? error.message : String(error)).catch(() => {})
      throw error
    }
  }

  async stageUpdate(options) {
    const profile = options.profile ?? 'web'
    const packageName = assertPackageName(options.packageName)
    const current = await this.inspect(profile)
    if (current.installed[packageName] === undefined) throw new Error(`package is not installed: ${packageName}`)
    return this.stageInstall({
      ...options,
      profile,
      packageName,
      enable: current.enabled.includes(packageName),
      operationType: 'update',
    })
  }

  async stageEnable(packageName, profile = 'web', enabled = true) {
    const name = assertPackageName(packageName)
    const candidate = await prepareCandidate(this.home, profile)
    try {
      const baseline = await readProfile(this.home, candidate.id)
      if (baseline.installed[name] === undefined) throw new Error(`package is not installed: ${name}`)
      await this.materializeCandidate(candidate.id)
      await setEnabledBundles(this.home, candidate.id, withBundleEnabled(baseline.enabled, name, enabled))
      await updateGeneration(this.home, candidate.id, metadata => ({
        ...metadata,
        operations: [...metadata.operations, { type: enabled ? 'enable' : 'disable', packageName: name }],
      }))
      await this.validateCandidate(candidate.id)
      await markCandidateReady(this.home, profile)
      return this.status(profile)
    } catch (error) {
      await discardPending(this.home, profile, error instanceof Error ? error.message : String(error)).catch(() => {})
      throw error
    }
  }

  async stageUninstall(packageName, profile = 'web') {
    const name = assertPackageName(packageName)
    const candidate = await prepareCandidate(this.home, profile)
    try {
      const baseline = await readProfile(this.home, candidate.id)
      await this.runDsh([
        'plugin', '--profile', candidate.id, '--config.ignore-scripts=true', 'remove', name,
      ])
      await setEnabledBundles(this.home, candidate.id, withBundleEnabled(baseline.enabled, name, false))
      await updateGeneration(this.home, candidate.id, metadata => ({
        ...metadata,
        operations: [...metadata.operations, { type: 'uninstall', packageName: name }],
      }))
      await this.validateCandidate(candidate.id)
      await markCandidateReady(this.home, profile)
      return this.status(profile)
    } catch (error) {
      await discardPending(this.home, profile, error instanceof Error ? error.message : String(error)).catch(() => {})
      throw error
    }
  }
}
