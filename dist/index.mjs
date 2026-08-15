import { ExtensionManager } from './manager.mjs'
import { resolveDshHome } from './paths.mjs'
import { installRuntimeReadyOfficialV1 } from './adapters/official-v1.mjs'
import { RegistryClient } from './registry.mjs'

export { ExtensionManager } from './manager.mjs'
export * from './generations.mjs'
export * from './launcher.mjs'
export * from './storage.mjs'
export * from './profile.mjs'
export * from './policy.mjs'
export * from './registry.mjs'
export * from './recipes.mjs'
export * from './management.mjs'
export * from './workshop-bridge.mjs'
export * from './profile-pack.mjs'
export * from './license.mjs'
export * from './pack-authoring.mjs'
export * from './pack-instances.mjs'
export * from './adapters/repository-config-v1.mjs'
export * from './adapters/official-v1.mjs'

export const name = 'omdsh-runtime'

function contextHome(ctx, configured) {
  if (configured !== undefined && configured !== '') return configured
  const resolver = typeof ctx?.get === 'function' ? ctx.get('dshHomePath') : ctx?.dshHomePath
  if (typeof resolver === 'function') return resolver()
  return resolveDshHome()
}

export function apply(ctx, config = {}) {
  const home = contextHome(ctx, config.home)
  const registry = new RegistryClient({
    home,
    ...(config.registryOrigins === undefined ? {} : { origins: config.registryOrigins }),
    ...(config.registryTrustedKeys === undefined ? {} : { trustedKeys: config.registryTrustedKeys }),
  })
  const manager = new ExtensionManager({ home, dshBin: config.dshBin, registry })
  if (typeof ctx?.provide !== 'function') throw new Error('omdsh-runtime requires a Cordis context with provide()')
  ctx.provide('omdshExtensions', manager)
  if (config.runtimeReadyAdapter !== false) installRuntimeReadyOfficialV1(ctx, manager)
}
