import type { ExtensionManager, ExtensionStatus } from './index.js'
import type { RegistryClient } from './registry.js'
import type { RecipeClient } from './recipes.js'
import type { OfficialV1Capabilities } from './adapters/official-v1.js'

export interface WorkshopPlan {
  readonly schema: 'omdsh.workshop-plan/v1'
  readonly registrySnapshotId: string
  readonly profile: string
  readonly items: ReadonlyArray<{ id: string; releaseId: string | null }>
  readonly preview: ReadonlyArray<{ packageName: string; spec: string }>
}

export interface RecipePlan {
  readonly schema: 'omdsh.recipe-plan/v1'
  readonly recipeId: string
  readonly title: string
  readonly profile: string
  readonly registrySnapshotId: string
  readonly items: ReadonlyArray<{ id: string; releaseId: string; enabled: boolean }>
  readonly preview: ReadonlyArray<Record<string, unknown>>
  readonly changes: number
  readonly recoveryScope: 'profile-generation'
  readonly externalEffects: 'not-covered'
  readonly applicable: boolean
  readonly hostCapabilities: OfficialV1Capabilities
}

export class WorkshopBridge {
  constructor(options: { manager: ExtensionManager; registry: RegistryClient; recipes?: RecipeClient })
  readonly manager: ExtensionManager
  readonly registry: RegistryClient
  readonly recipes?: RecipeClient
  planInstall(id: string, options?: { profile?: string; releaseId?: string }): Promise<WorkshopPlan>
  applyPlan(plan: WorkshopPlan, options?: { profile?: string; enable?: boolean }): Promise<ExtensionStatus>
  planRecipe(id: string, options?: { profile?: string }): Promise<RecipePlan>
  applyRecipe(id: string, options?: { profile?: string; expectedSnapshotId?: string }): Promise<ExtensionStatus>
  install(id: string, options?: { profile?: string; releaseId?: string; enable?: boolean }): Promise<ExtensionStatus>
  update(id: string, options?: { profile?: string; releaseId?: string }): Promise<ExtensionStatus>
  installCollection(id: string, options?: { profile?: string; enable?: boolean }): Promise<ExtensionStatus>
  unsubscribe(id: string, profile?: string): Promise<ExtensionStatus>
  enable(id: string, profile?: string): Promise<ExtensionStatus>
  disable(id: string, profile?: string): Promise<ExtensionStatus>
  activate(profile?: string): Promise<string>
  discard(profile?: string, reason?: string): Promise<string | null>
  recover(profile?: string, options?: { to?: string }): Promise<Record<string, unknown>>
}
