export const REGISTRY_SCHEMA: 'omdsh-registry/v1'
export const REGISTRY_ORIGINS: readonly string[]
export type RegistryPublicKey = string | Uint8Array
export interface RegistryEntry {
  id: string
  displayName: string
  description: string
  kind: string
  tags: string[]
  author: { name: string; url: string }
  version: string | null
  license: string
  source: { repository: string; ref: string; path: string | null }
  compatibility: { declared: string | null }
  risk: {
    level: 'unknown' | 'low' | 'medium' | 'high' | 'critical'
    facts: {
      sourcePinned: true
      vulnerabilityScan: 'unknown' | 'passed' | 'findings'
      permissions: 'unknown' | 'declared' | 'reviewed'
      nativeCode: 'unknown' | 'present' | 'absent'
      installScripts: 'unknown' | 'present' | 'absent'
    }
  }
  listing: {
    state: 'auto-listed' | 'review-required' | 'reviewed' | 'blocked'
    catalogStatus: 'verified' | 'beta' | 'prototype'
    trustedPublisher: 'unknown' | 'requested' | 'verified'
  }
  maintenance: {
    state: 'active' | 'deprecated' | 'archived'
    notice: string | null
    successor: string | null
  }
  install: {
    mode: 'guided'
    method: 'marisa' | 'plugin-registry' | 'source' | 'manual' | 'npm' | 'script'
  } | {
    mode: 'profile-bundle'
    adapter: 'official-profile/v1'
    packageName: string
    spec: string
  } | {
    mode: 'repository-plugin'
    adapter: 'official-repository/v1'
    spec: string
  }
  latestRelease?: string
  releases?: RegistryRelease[]
  links: { atlas: string; repository: string }
}
export interface RegistryRelease {
  id: string
  version: string | null
  ref: string
  updatedAt: string
  channel: 'stable' | 'beta' | 'nightly'
  source: RegistryEntry['source']
  compatibility: RegistryEntry['compatibility']
  install: RegistryEntry['install']
}
export interface RegistryCollection {
  id: string
  title: string
  summary: string
  translations?: { en: { title: string; summary: string } }
  author: { name: string; url: string }
  featured: boolean
  items: Array<{ projectId: string; releaseId: string; packageName: string; spec: string }>
}
export interface RegistryDocument {
  schema: 'omdsh-registry/v1'
  revision: number
  generatedAt: string
  origins: string[]
  entries: RegistryEntry[]
  collections?: RegistryCollection[]
  snapshotId: string
  signature: null | { algorithm: 'Ed25519'; keyId: string; value: string }
}
export interface RegistryClientOptions {
  home?: string
  trustedKeys?: Record<string, RegistryPublicKey>
  bundledFile?: string | URL
}
export function canonicalJson(value: unknown): string
export function registryPayload(document: RegistryDocument): Omit<RegistryDocument, 'snapshotId' | 'signature'>
export function registrySnapshotId(document: RegistryDocument): string
export function isExactPackageSpec(value: unknown): boolean
export function isPinnedRepositorySpec(value: unknown): boolean
export function parseRegistry(value: unknown, options?: { allowUnsigned?: boolean; trustedKeys?: Record<string, RegistryPublicKey> }): RegistryDocument
export class RegistryClient {
  constructor(options?: RegistryClientOptions)
  readonly home: string
  current(): Promise<{ document: RegistryDocument; source: 'bundled'; warning: null }>
  view(query?: string): Promise<Record<string, unknown>>
  resolveInstall(id: string, releaseId?: string): Promise<{ readonly id: string; readonly releaseId: string | null; readonly packageName: string; readonly spec: string }>
  resolveAction(id: string, releaseId?: string): Promise<{
    readonly id: string
    readonly releaseId: string | null
    readonly install: RegistryEntry['install']
    readonly maintenance: RegistryEntry['maintenance']
    readonly links: RegistryEntry['links']
  }>
  resolveCollection(id: string): Promise<{ readonly id: string; readonly title: string; readonly intents: ReadonlyArray<{ readonly id: string; readonly releaseId: string | null; readonly packageName: string; readonly spec: string }> }>
  /** @deprecated Runtime snapshots are read-only; use the local workshop:vendor build step. */
  sync(): Promise<never>
}
