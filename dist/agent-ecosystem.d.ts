import type { RegistryClient, RegistryDocument } from './registry.js'

export const AGENT_ECOSYSTEM_SCHEMA: 'omdsh-agent-ecosystem/v1'
export const AGENT_ECOSYSTEM_ORIGINS: readonly string[]
export interface AgentEcosystemDocument extends Record<string, unknown> {
  schema: 'omdsh-agent-ecosystem/v1'
  generatedAt: string
  registry: { schema: 'omdsh-registry/v1'; snapshotId: string; revision: number; origins: string[] }
  policy: Record<string, string>
  totals: { projects: number; releases: number; successfulRuns: number; compositions: number }
  projects: Array<Record<string, unknown>>
  compositions: Array<Record<string, unknown>>
}
export function parseAgentEcosystem(value: unknown): AgentEcosystemDocument
export function assertAgentEcosystemRegistry(document: AgentEcosystemDocument, registry: RegistryDocument): AgentEcosystemDocument
export function inspectEcosystemProject(document: AgentEcosystemDocument, id: string, releaseId?: string): Readonly<Record<string, unknown>>
export function searchEcosystem(document: AgentEcosystemDocument, query: string, options?: { limit?: number }): Readonly<Record<string, unknown>>
export function ecosystemDependencies(document: AgentEcosystemDocument, id: string, releaseId?: string): Readonly<Record<string, unknown>>
export function ecosystemCompatibility(document: AgentEcosystemDocument, id: string, releaseId?: string): Readonly<Record<string, unknown>>
export function preflightComposition(document: AgentEcosystemDocument, compositionId: string): Readonly<Record<string, unknown>>
export function recommendCompositions(document: AgentEcosystemDocument, task: string, options?: { limit?: number }): Readonly<Record<string, unknown>>
export class AgentEcosystemClient {
  constructor(options: { registry: RegistryClient; home?: string; bundledFile?: string | URL })
  readonly registry: RegistryClient
  current(): Promise<{ document: AgentEcosystemDocument; source: 'bundled'; warning: null; registrySnapshotId: string }>
  /** @deprecated Runtime snapshots are read-only; use the local workshop:vendor build step. */
  sync(): Promise<never>
}
