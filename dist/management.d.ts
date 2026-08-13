import type { RegistryEntry } from './registry.js'
import type { OfficialV1Capabilities } from './adapters/official-v1.js'

export interface ExtensionCapabilities {
  install: boolean
  update: boolean
  enable: boolean
  disable: boolean
  uninstall: boolean
  guide: boolean
}

export interface ExtensionManagement {
  level: 'transactional' | 'profile-managed' | 'delegated' | 'guided' | 'blocked'
  adapter: 'official-profile/v1' | 'official-repository/v1' | 'profile' | 'external-guide'
  rollback: 'generation' | 'none'
  gate: 'approval' | 'security' | 'host-capability' | null
  securityNotice: 'trusted-repository-code' | null
  capabilities: ExtensionCapabilities
}

export interface InstalledExtension {
  identity: string
  packageName: string | null
  spec: string
  enabled: boolean
  entry: RegistryEntry | null
  management: ExtensionManagement
}

export interface AvailableExtension {
  entry: RegistryEntry
  management: ExtensionManagement
}

export interface ExtensionInventory {
  schema: 'omdsh.extension-inventory/v1'
  profile: string | null
  installed: InstalledExtension[]
  available: AvailableExtension[]
}

export function registryEntryGate(entry: RegistryEntry): 'approval' | 'security' | null
export const TRUSTED_REPOSITORY_CODE_NOTICE: 'trusted-repository-code'
export function describeRegistryEntryManagement(
  entry: RegistryEntry,
  hostCapabilities?: OfficialV1Capabilities,
): ExtensionManagement
export function buildExtensionInventory(profile: {
  name?: string
  installed?: Record<string, string>
  enabled?: string[]
} | null, registryView?: { entries?: RegistryEntry[] } | null, repositorySpecs?: string[],
hostCapabilities?: OfficialV1Capabilities): ExtensionInventory
