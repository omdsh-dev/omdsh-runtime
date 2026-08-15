export const PACK_INSTANCE_SCHEMA: 'omdsh-pack-instance/v1'

export interface PackInstanceSnapshot {
  pack: { id: string; version: string; digest: string }
  registrySnapshotId: string
  runtimeVersion: string
  plugins: Array<{ projectId: string; releaseId: string; enabled: boolean; license: Record<string, unknown> }>
  sourcePlugins: Array<Record<string, unknown>>
  agentPreset: { id: string; mode: 'builtin' | 'embedded'; sha256: string | null }
  publisher: Record<string, unknown> | null
  generation: string
  rollbackGeneration: string
  appliedAt: string
}

export interface PackInstance {
  schema: 'omdsh-pack-instance/v1'
  name: string
  profile: string
  current: PackInstanceSnapshot | null
  previous: PackInstanceSnapshot | null
  pending: PackInstanceSnapshot | null
  updatedAt: string
}

export function readPackInstance(home: string | undefined, name: string): Promise<PackInstance | null>
export function writePackInstance(home: string | undefined, name: string, update: (current: PackInstance | null) => PackInstance | null | Promise<PackInstance | null>): Promise<PackInstance | null>
