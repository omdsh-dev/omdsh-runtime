import type { ExtensionManager, ExtensionStatus } from '../index.js'

export const REPOSITORY_CONFIG_ADAPTER: 'official-repository/v1'
export const REPOSITORY_BLOCK_START: string
export const REPOSITORY_BLOCK_END: string
export interface RepositorySpec { repo: string; ref: string; path: string }
export interface RepositoryInstallIntent {
  id: string
  releaseId: string | null
  mode: 'repository-plugin'
  adapter: 'official-repository/v1'
  spec: string
}
export function parseRepositorySpec(value: string): Readonly<RepositorySpec>
export function formatRepositorySpec(value: string | RepositorySpec): string
export function repositorySpecIdentity(spec: string): string
export function readRepositorySpecs(home: string, profile: string): Promise<readonly string[]>
export function writeRepositorySpecs(home: string, profile: string, specs: string[]): Promise<readonly string[]>
export class RepositoryConfigAdapter {
  constructor(options: { manager: ExtensionManager })
  readonly manager: ExtensionManager
  list(profile?: string): Promise<readonly string[]>
  install(intent: RepositoryInstallIntent, options?: { profile?: string }): Promise<ExtensionStatus>
  update(intent: RepositoryInstallIntent, options?: { profile?: string }): Promise<ExtensionStatus>
  remove(intent: RepositoryInstallIntent, options?: { profile?: string }): Promise<ExtensionStatus>
}
