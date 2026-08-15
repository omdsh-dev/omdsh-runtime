import type { LaunchResult, LaunchSelection } from './launcher.js'
import type { GenerationCleanupResult, GenerationStorageReport } from './storage.js'
import type { RegistryClient } from './registry.js'

export interface ExtensionStatus {
  schema: string
  logicalProfile: string
  current: string
  previous: string | null
  pending: string | null
  bootAttempt: {
    generation: string
    startedAt: string
    launchedAt?: string
    launcherPid?: number
  } | null
  failed: string[]
  events: Array<Record<string, unknown>>
}

export interface ExtensionManagerOptions {
  home?: string
  dshBin?: string
  registry?: RegistryClient
  environment?: Record<string, string | undefined>
}

export class ExtensionManager {
  constructor(options?: ExtensionManagerOptions)
  readonly home: string
  readonly dshBin: string
  readonly registry?: RegistryClient
  status(profile?: string): Promise<ExtensionStatus>
  resolve(profile?: string): Promise<string>
  recover(profile?: string, options?: { to?: string }): Promise<Record<string, unknown>>
  activate(profile?: string): Promise<string>
  confirm(profile?: string): Promise<string>
  runtimeReady(options?: { logicalProfile?: string; generation?: string; token?: string }): Promise<string>
  discard(profile?: string, reason?: string): Promise<string | null>
  storage(profile?: string): Promise<GenerationStorageReport>
  cleanup(profile?: string, options?: { keepFailed?: number; apply?: boolean }): Promise<GenerationCleanupResult>
  launch(args?: string[], profile?: string, options?: {
    retryPrevious?: boolean
    readyTimeoutMs?: number
    readyPollIntervalMs?: number
  }): Promise<LaunchResult>
  inspect(profile?: string): Promise<Record<string, unknown>>
  capabilities(profile?: string): Promise<import('./adapters/official-v1.js').OfficialV1Capabilities>
  officialPackage(): Promise<import('./adapters/official-v1.js').OfficialPackageObservation | import('./adapters/official-v1.js').UnknownOfficialPackageObservation>
  requireRepositoryPlugin(profile?: string): Promise<import('./adapters/official-v1.js').OfficialV1Capabilities>
  stageInstall(options: {
    profile?: string
    packageName: string
    spec: string
    enable?: boolean
    allowScripts?: boolean
    operationType?: string
    entryId?: string
  }): Promise<ExtensionStatus>
  stageBatchInstall(options: {
    profile?: string
    collectionId?: string
    intents: Array<{
      packageName: string
      spec: string
      enable?: boolean
      allowScripts?: boolean
      operationType?: string
      entryId?: string
      releaseId?: string | null
    }>
  }): Promise<ExtensionStatus>
  stageMarketInstall(id: string, options?: {
    profile?: string
    enable?: boolean
    releaseId?: string
  }): Promise<ExtensionStatus>
  stageMarketBatch(items: Array<{ id: string; releaseId?: string }>, options?: {
    profile?: string
    enable?: boolean
    collectionId?: string
  }): Promise<ExtensionStatus>
  stageMarketCollection(id: string, options?: { profile?: string; enable?: boolean }): Promise<ExtensionStatus>
  stageMarketRecipe(items: Array<{ id: string; releaseId: string; enabled: boolean }>, options?: {
    profile?: string
    recipeId?: string
    reconcileRegistryManaged?: boolean
    sourceItems?: Array<{
      id: string
      releaseId: string
      enabled: boolean
      install: { mode: 'profile-bundle'; packageName: string; spec: string }
    }>
    reconcileSourceItems?: Array<{ packageName: string; spec: string }>
    allowNoChanges?: boolean
  }): Promise<ExtensionStatus>
  stageUpdate(options: {
    profile?: string
    packageName: string
    spec: string
    allowScripts?: boolean
  }): Promise<ExtensionStatus>
  stageEnable(packageName: string, profile?: string, enabled?: boolean): Promise<ExtensionStatus>
  stageUninstall(packageName: string, profile?: string): Promise<ExtensionStatus>
}

export const name: 'omdsh-runtime'
export function apply(ctx: unknown, config?: {
  home?: string
  dshBin?: string
  runtimeReadyAdapter?: boolean
  registryOrigins?: string[]
  registryTrustedKeys?: Record<string, import('./registry.js').RegistryPublicKey>
}): void
export function extensionStatus(home?: string, profile?: string): Promise<ExtensionStatus>
export function resolveSelectedProfile(home?: string, profile?: string): Promise<string>
export function beginLaunch(home?: string, profile?: string): Promise<LaunchSelection>
export function confirmRuntimeReady(home?: string, options?: { logicalProfile?: string; generation?: string; token?: string }): Promise<string>
export function recoverProfile(home?: string, profile?: string, options?: { to?: string }): Promise<Record<string, unknown>>
export function readProfile(home: string | undefined, profile: string): Promise<Record<string, unknown>>
export function setEnabledBundles(home: string | undefined, profile: string, bundleNames: string[]): Promise<Record<string, unknown>>
export function setBundleEnabled(home: string | undefined, profile: string, packageName: string, enabled: boolean): Promise<Record<string, unknown>>
export * from './policy.js'
export * from './launcher.js'
export * from './storage.js'
export * from './registry.js'
export * from './recipes.js'
export * from './management.js'
export * from './workshop-bridge.js'
export * from './profile-pack.js'
export * from './license.js'
export * from './pack-authoring.js'
export * from './pack-instances.js'
export * from './adapters/repository-config-v1.js'
export * from './adapters/official-v1.js'
