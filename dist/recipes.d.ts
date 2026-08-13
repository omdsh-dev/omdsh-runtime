import type { RegistryClient, RegistryDocument } from './registry.js'

export const RECIPES_SCHEMA: 'omdsh-workshop-recipes/v1'
export const RECIPE_ORIGINS: readonly string[]

export interface RecipeItem {
  projectId: string
  releaseId: string
  enabled: boolean
  management: 'transactional' | 'managed' | 'guided'
  availability: 'available' | 'blocked'
}

export interface Recipe {
  id: string
  kind: 'configuration' | 'distribution'
  title: string
  summary: string
  translations: { en: { title: string; summary: string } }
  useCases?: Array<{
    id: string
    title: string
    translations: { en: string }
  }>
  author: { name: string; url: string }
  source: { repository: string; ref: string }
  compatibility: { harness: string; declared: string }
  featured: boolean
  items: RecipeItem[]
  apply: {
    mode: 'single-candidate' | 'guided' | 'blocked'
    recoveryScope: 'profile-generation' | 'partial' | 'none'
    externalEffects: 'not-covered'
    counts: { total: number; managed: number; guided: number; blocked: number }
  }
}

export interface RecipeDocument {
  schema: 'omdsh-workshop-recipes/v1'
  generatedAt: string
  registry: Pick<RegistryDocument, 'schema' | 'snapshotId' | 'revision' | 'origins'>
  recipes: Recipe[]
}

export interface RecipeClientOptions {
  registry: RegistryClient
  home?: string
  bundledFile?: string | URL
}

export function parseRecipes(value: unknown): RecipeDocument
export function assertRecipesRegistry(document: RecipeDocument, registry: RegistryDocument): RecipeDocument
export class RecipeClient {
  constructor(options: RecipeClientOptions)
  readonly registry: RegistryClient
  readonly home: string
  current(): Promise<{ document: RecipeDocument; source: 'bundled'; warning: null; registrySnapshotId: string }>
  view(): Promise<{ schema: 'omdsh.recipe-view/v1'; snapshot: Record<string, unknown>; recipes: Recipe[] }>
  resolve(id: string): Promise<{ recipe: Recipe; registrySnapshotId: string; items: ReadonlyArray<{ id: string; releaseId: string; enabled: boolean }> }>
  /** @deprecated Runtime snapshots are read-only; use the local workshop:vendor build step. */
  sync(): Promise<never>
}
