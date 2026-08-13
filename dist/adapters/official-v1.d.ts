import type { ExtensionManager } from '../index.js'

export const OFFICIAL_V1_CONTRACT: Readonly<{
  family: 'official-v1'
  profileBundles: 'dsh.profile.bundles'
  bundlePatch: 'dsh.bundle.patch'
  clientManifests: readonly ['dsh.client']
  clientPlatform: 'web'
  settingsSlot: 'settings.section'
  httpService: 'webServer'
  loaderActiveState: 2
  repositoryPluginRow: 'repository-plugins'
  repositoryPluginPackage: '@deepseek-ai/dsh-repository-plugin'
}>

export const OFFICIAL_V1_EXPECTED_PACKAGE: Readonly<{
  source: 'npm'
  name: '@deepseek-ai/dsh'
}>

export const OFFICIAL_V1_DOCUMENTED_CAPABILITIES: Readonly<{
  hostCapabilities: Readonly<{
    state: 'unknown'
    reason: 'public-evidence-required'
    integration: 'guided'
  }>
  recoveryLayers: Readonly<{
    runtime: 'unknown'
    generation: 'omdsh-cross-restart'
    externalEffects: 'not-reversible'
  }>
}>

export interface OfficialPackageObservation {
  schema: 'omdsh.official-package-observation/v1'
  state: 'observed'
  expectedArtifact: typeof OFFICIAL_V1_EXPECTED_PACKAGE
  command: { name: 'dsh'; version: string }
  artifact?: {
    source: 'npm'
    name: '@deepseek-ai/dsh'
    version: string
    integrity: string
  }
  binding: 'not-verified' | 'local-install-and-lock'
  assessment: 'unassessed' | 'observed-exact'
}

export interface UnknownOfficialPackageObservation {
  schema: 'omdsh.official-package-observation/v1'
  state: 'unknown'
  reason: 'version-probe-failed'
}

export interface OfficialV1Capabilities {
  schema: 'omdsh.official-capabilities/v1'
  family: 'official-v1'
  profile: string
  hostCapabilities: typeof OFFICIAL_V1_DOCUMENTED_CAPABILITIES.hostCapabilities
  recoveryLayers: typeof OFFICIAL_V1_DOCUMENTED_CAPABILITIES.recoveryLayers
  webIntegration: {
    state: 'available' | 'unavailable' | 'unknown'
    evidence: 'official-config-dump' | 'probe-failed' | 'public-evidence-required'
    reason: 'official-rows-present' | 'official-rows-missing' | 'probe-failed' | 'public-evidence-required'
    service: 'webServer'
    settingsSlot: 'settings.section'
  }
  repositoryPlugin: {
    state: 'available' | 'unavailable' | 'unknown'
    integration: 'patch-existing-row' | 'guided'
    reason: 'official-row-present' | 'official-row-missing' | 'probe-failed'
  }
}

export function inspectOfficialCapabilitiesDumpOfficialV1(
  output: string,
  profile: string,
): Readonly<OfficialV1Capabilities>
export function probeOfficialCapabilitiesOfficialV1(
  manager: { dshBin?: string; runDsh(args: string[]): Promise<{ stdout: string }> },
  profile: string,
): Promise<Readonly<OfficialV1Capabilities>>
export function inspectOfficialCommandVersionOfficialV1(output: string): Readonly<OfficialPackageObservation>
export function observeOfficialPackageOfficialV1(
  manager: { dshBin?: string; runDsh(args: string[]): Promise<{ stdout: string }> },
): Promise<Readonly<OfficialPackageObservation | UnknownOfficialPackageObservation>>

export function loaderTreeIsActiveOfficialV1(loader: unknown): boolean
export function registerManagementRouteOfficialV1(ctx: unknown, route: unknown): boolean
export function installRuntimeReadyOfficialV1(
  ctx: unknown,
  manager: ExtensionManager,
  environment?: Record<string, string | undefined>,
): boolean
