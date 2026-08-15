import type { ExtensionManager, ExtensionStatus } from './index.js'
import type { RegistryClient } from './registry.js'

export const PROFILE_PACK_SCHEMA: 'omdsh-profile-pack/v1'
export const PROFILE_PACK_ENVELOPE_SCHEMA: 'omdsh-profile-pack-envelope/v1'
export const BUILTIN_AGENT_PRESETS: readonly ['code', 'cordis', 'minimal', 'standard']

export interface ProfilePackPlugin {
  projectId: string
  releaseId: string
  enabled: boolean
  license: ProfilePackLicense
}

export interface ProfilePackLicense {
  expression: string
  family: 'permissive' | 'public-domain' | 'weak-copyleft' | 'copyleft' | 'custom' | 'unknown' | 'other'
  review: 'notice' | 'required'
  source: string
  url: string
}

export interface ProfilePackSourcePlugin {
  id: string
  packageName: string
  version: string
  enabled: boolean
  license: ProfilePackLicense
  source: { repository: string; ref: string }
  install: { mode: 'profile-bundle'; spec: string }
  trust: 'author-fixed-source'
}

export interface ProfilePackPresetFile {
  path: string
  sha256: `sha256:${string}`
  content: string
}

export type ProfilePackAgentPreset = {
  mode: 'builtin'
  id: 'code' | 'cordis' | 'minimal' | 'standard'
  sha256: null
  files: []
} | {
  mode: 'embedded'
  id: string
  sha256: `sha256:${string}`
  files: ProfilePackPresetFile[]
}

export interface ProfilePack {
  schema: 'omdsh-profile-pack/v1'
  id: string
  version: string
  createdAt: string
  runtime: {
    package: '@deepseek-ai/dsh'
    version: string
    integrity: string | null
    binding: 'not-verified' | 'local-install-and-lock'
  }
  registry: {
    schema: 'omdsh-registry/v1'
    snapshotId: `sha256:${string}`
    revision: number
    origins: string[]
  }
  profile: { logicalName: string | null; sourceGeneration: string | null }
  distribution: { id: string; version: string } | null
  plugins: ProfilePackPlugin[]
  sourcePlugins: ProfilePackSourcePlugin[]
  agentPreset: ProfilePackAgentPreset
  omitted: Array<{ identity: string; reason: string }>
  policy: {
    pluginPayloads: 'registry-references-and-fixed-source'
    registryManagedPlugins: 'replace'
    fixedSourcePlugins: 'explicit-trust'
    untrackedPackages: 'preserve'
    credentials: 'excluded'
    sessions: 'excluded'
    localPaths: 'excluded'
    activation: 'candidate-and-confirm'
    presetRollback: 'outside-profile-generation'
  }
  digest: `sha256:${string}`
}

export interface ProfilePackEnvelope {
  schema: 'omdsh-profile-pack-envelope/v1'
  pack: ProfilePack
  provenance: { publisher: string; source: string | null; issuedAt: string }
  signature: { algorithm: 'Ed25519'; keyId: string; value: string }
}

export function profilePackDigest(value: ProfilePack): `sha256:${string}`
export function parseProfilePack(value: unknown): ProfilePack
export function parseProfilePackEnvelope(value: unknown): ProfilePackEnvelope
export function signProfilePack(value: ProfilePack, options: {
  privateKey: string | Buffer | object
  keyId: string
  publisher: string
  source?: string
  issuedAt?: Date
}): ProfilePackEnvelope
export function verifyProfilePackEnvelope(value: ProfilePackEnvelope, publicKey: string | Buffer | object): ProfilePackEnvelope
export function diffProfilePacks(left: ProfilePack | ProfilePackEnvelope | Record<string, unknown>, right: ProfilePack | ProfilePackEnvelope | Record<string, unknown>): Record<string, unknown>

export class ProfilePackManager {
  constructor(options: { manager: ExtensionManager; registry?: RegistryClient })
  exportProfile(options?: {
    profile?: string
    preset?: string
    id?: string
    version?: string
    output?: string
    allowOmitted?: boolean
    now?: Date
  }): Promise<ProfilePack>
  buildDistribution(source: string | Record<string, unknown>, options?: {
    output?: string
    now?: Date
  }): Promise<ProfilePack>
  sign(source: string | Record<string, unknown>, options: {
    privateKey: string | Buffer | object
    keyId: string
    publisher: string
    source?: string
    issuedAt?: Date
    output: string
  }): Promise<ProfilePackEnvelope>
  inspect(source: string | Record<string, unknown>, options?: {
    publicKey?: string | Buffer | object
    requireSignature?: boolean
  }): Promise<Record<string, unknown>>
  plan(source: string | Record<string, unknown>, options?: {
    profile?: string
    instance?: string
    publicKey?: string | Buffer | object
    requireSignature?: boolean
    trustPreset?: boolean
    trustSource?: boolean
    replacePreset?: boolean
  }): Promise<Record<string, unknown>>
  instance(name: string): Promise<Record<string, unknown>>
  diff(left: string | Record<string, unknown>, right?: string | Record<string, unknown>, options?: { instance?: string }): Promise<Record<string, unknown>>
  update(source: string | Record<string, unknown>, options: {
    instance: string
    profile?: string
    publicKey?: string | Buffer | object
    requireSignature?: boolean
    trustPreset?: boolean
    trustSource?: boolean
    replacePreset?: boolean
  }): Promise<Record<string, unknown>>
  rollback(name: string): Promise<Record<string, unknown>>
  apply(source: string | Record<string, unknown>, options?: {
    profile?: string
    instance?: string
    publicKey?: string | Buffer | object
    requireSignature?: boolean
    trustPreset?: boolean
    trustSource?: boolean
    replacePreset?: boolean
    now?: Date
  }): Promise<{
    schema: 'omdsh-profile-pack-apply/v1'
    state: 'candidate-ready' | 'preset-installed' | 'already-applied'
    pack: { id: string; version: string; digest: string }
    profile: string
    instance: string | null
    candidate: string | null
    signature: Record<string, unknown>
    agentPreset: { id: string; mode: 'builtin' | 'embedded'; installed: boolean }
    fixedSourcePlugins: Array<{ id: string; packageName: string; license: ProfilePackLicense }>
    next: string[]
  }>
}
