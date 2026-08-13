export interface LaunchResult {
  code: number
  signal: string | null
  attempts: Array<{ profile: string; code: number; signal: string | null; readyTimeout: boolean }>
  recovered: {
    logicalProfile: string
    from: string
    to: string
    failed: string[]
  } | null
}

export interface LaunchSelection {
  logicalProfile: string
  selectedProfile: string
  requiresConfirmation: boolean
  token: string | null
}

export function selectProfileArguments(args: string[], logicalProfile: string, selectedProfile: string): string[]
export function launchDsh(options?: {
  home?: string
  profile?: string
  dshBin?: string
  args?: string[]
  retryPrevious?: boolean
  readyTimeoutMs?: number
  readyPollIntervalMs?: number
}): Promise<LaunchResult>
export const DEFAULT_RUNTIME_READY_TIMEOUT_MS: 120000
export function confirmRuntimeReady(home?: string, options?: {
  logicalProfile?: string
  generation?: string
  token?: string
}): Promise<string>
