import { readProfile } from './profile.mjs'
import { TRUSTED_REPOSITORY_CODE_NOTICE } from './management.mjs'
import {
  RepositoryConfigAdapter, readRepositorySpecs, repositorySpecIdentity,
} from './adapters/repository-config-v1.mjs'

/**
 * Execution-only bridge over Registry + ExtensionManager. It owns no discovery
 * view, authoring workflow, loader, daemon, receipt database, or mutable state.
 */
export class WorkshopBridge {
  #repositoryAdapter

  constructor(options) {
    if (options?.manager === undefined || options?.registry === undefined) {
      throw new Error('WorkshopBridge requires the existing manager and Registry client')
    }
    this.manager = options.manager
    this.registry = options.registry
    if (options.recipes !== undefined) this.recipes = options.recipes
    this.#repositoryAdapter = new RepositoryConfigAdapter({ manager: options.manager })
  }

  async planInstall(id, options = {}) {
    const intent = await this.registry.resolveInstall(id, options.releaseId)
    const selected = await this.registry.current()
    return Object.freeze({
      schema: 'omdsh.workshop-plan/v1',
      registrySnapshotId: selected.document.snapshotId,
      profile: options.profile ?? 'web',
      items: Object.freeze([{ id: intent.id, releaseId: intent.releaseId }]),
      preview: Object.freeze([{ packageName: intent.packageName, spec: intent.spec }]),
    })
  }

  async applyPlan(plan, options = {}) {
    if (plan?.schema !== 'omdsh.workshop-plan/v1' || !Array.isArray(plan.items) || plan.items.length === 0) {
      throw new Error('invalid Workshop plan')
    }
    const selected = await this.registry.current()
    if (plan.registrySnapshotId !== selected.document.snapshotId) throw new Error('Workshop plan Registry snapshot is stale')
    return this.manager.stageMarketBatch(
      plan.items.map(item => ({ id: item.id, releaseId: item.releaseId })),
      { profile: options.profile ?? plan.profile ?? 'web', enable: options.enable },
    )
  }

  async planRecipe(id, options = {}) {
    if (this.recipes === undefined) throw new Error('Recipe feed is unavailable')
    const profile = options.profile ?? 'web'
    const status = await this.manager.status(profile)
    if (status.pending !== null) throw new Error('discard or activate the existing candidate before planning a Recipe')
    const resolvedRecipe = await this.recipes.resolve(id)
    const selected = await this.registry.current()
    if (resolvedRecipe.registrySnapshotId !== selected.document.snapshotId) throw new Error('Recipe Registry snapshot is stale')
    const [current, repositories, hostCapabilities] = await Promise.all([
      readProfile(this.manager.home, status.current),
      readRepositorySpecs(this.manager.home, status.current),
      this.manager.capabilities(profile),
    ])
    const preview = []
    for (const item of resolvedRecipe.items) {
      const action = await this.registry.resolveAction(item.id, item.releaseId)
      const install = action.install
      if (install.mode === 'profile-bundle') {
        const currentSpec = current.installed[install.packageName] ?? null
        const currentEnabled = current.enabled.includes(install.packageName)
        const change = currentSpec === null
          ? 'install'
          : currentSpec !== install.spec
            ? 'update'
            : currentEnabled === item.enabled ? 'none' : item.enabled ? 'enable' : 'disable'
        preview.push(Object.freeze({
          id: action.id,
          releaseId: action.releaseId,
          adapter: install.adapter,
          packageName: install.packageName,
          currentSpec,
          targetSpec: install.spec,
          currentEnabled,
          targetEnabled: item.enabled,
          change,
          securityNotice: null,
        }))
        continue
      }
      if (install.mode === 'repository-plugin') {
        if (item.enabled !== true) throw new Error(`Repository Plugin ${JSON.stringify(item.id)} has no independent disabled state`)
        const target = repositorySpecIdentity(install.spec)
        const currentSpec = repositories.find(spec => repositorySpecIdentity(spec) === target) ?? null
        preview.push(Object.freeze({
          id: action.id,
          releaseId: action.releaseId,
          adapter: install.adapter,
          packageName: null,
          currentSpec,
          targetSpec: install.spec,
          currentEnabled: currentSpec !== null,
          targetEnabled: true,
          change: currentSpec === null ? 'install' : currentSpec === install.spec ? 'none' : 'update',
          securityNotice: TRUSTED_REPOSITORY_CODE_NOTICE,
          available: hostCapabilities.repositoryPlugin.state === 'available',
        }))
        continue
      }
      throw new Error(`Recipe project ${JSON.stringify(item.id)} has no managed official adapter`)
    }
    return Object.freeze({
      schema: 'omdsh.recipe-plan/v1',
      recipeId: resolvedRecipe.recipe.id,
      title: resolvedRecipe.recipe.title,
      profile,
      registrySnapshotId: resolvedRecipe.registrySnapshotId,
      items: resolvedRecipe.items,
      preview: Object.freeze(preview),
      changes: preview.filter(item => item.change !== 'none').length,
      recoveryScope: 'profile-generation',
      externalEffects: 'not-covered',
      applicable: preview.every(item => item.available !== false),
      hostCapabilities,
    })
  }

  async applyRecipe(id, options = {}) {
    const plan = await this.planRecipe(id, options)
    if (options.expectedSnapshotId !== undefined && options.expectedSnapshotId !== plan.registrySnapshotId) {
      throw new Error('Recipe preview is stale')
    }
    if (plan.changes === 0) throw new Error('Recipe already matches the current Profile')
    if (!plan.applicable) {
      throw new Error('Recipe requires the official Repository Plugin, which is unavailable in this Harness distribution')
    }
    return this.manager.stageMarketRecipe(plan.items, {
      profile: plan.profile,
      recipeId: plan.recipeId,
    })
  }

  async install(id, options = {}) {
    const action = await this.registry.resolveAction(id, options.releaseId)
    if (action.install.mode === 'profile-bundle') return this.manager.stageMarketInstall(id, options)
    if (action.install.mode === 'repository-plugin') {
      return this.#repositoryAdapter.install({ id: action.id, releaseId: action.releaseId, ...action.install }, options)
    }
    throw new Error(`Workshop project ${JSON.stringify(id)} is guided; inspect its pinned instructions instead`)
  }

  async update(id, options = {}) {
    const action = await this.registry.resolveAction(id, options.releaseId)
    if (action.install.mode === 'profile-bundle') return this.manager.stageMarketInstall(id, options)
    if (action.install.mode === 'repository-plugin') {
      return this.#repositoryAdapter.update({ id: action.id, releaseId: action.releaseId, ...action.install }, options)
    }
    throw new Error(`Workshop project ${JSON.stringify(id)} has no managed update adapter`)
  }
  installCollection(id, options = {}) { return this.manager.stageMarketCollection(id, options) }
  unsubscribe(id, profile = 'web') { return this.#packageOperation(id, profile, 'uninstall') }
  enable(id, profile = 'web') { return this.#packageOperation(id, profile, 'enable') }
  disable(id, profile = 'web') { return this.#packageOperation(id, profile, 'disable') }
  activate(profile = 'web') { return this.manager.activate(profile) }
  discard(profile = 'web', reason) { return this.manager.discard(profile, reason) }
  recover(profile = 'web', options = {}) { return this.manager.recover(profile, options) }

  async #packageOperation(id, profile, action) {
    const selected = await this.registry.current()
    const entry = selected.document.entries.find(item => item.id === id)
    if (entry === undefined) throw new Error(`Workshop project not found: ${JSON.stringify(id)}`)
    if (entry.install.mode === 'repository-plugin') {
      if (action !== 'uninstall') throw new Error(`Repository Plugin has no independent enable state: ${JSON.stringify(id)}`)
      return this.#repositoryAdapter.remove({ id, releaseId: entry.latestRelease ?? null, ...entry.install }, { profile })
    }
    if (entry.install.mode !== 'profile-bundle') throw new Error(`Workshop project is guided: ${JSON.stringify(id)}`)
    if (action === 'uninstall') return this.manager.stageUninstall(entry.install.packageName, profile)
    return this.manager.stageEnable(entry.install.packageName, profile, action === 'enable')
  }
}
