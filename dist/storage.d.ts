export interface GenerationUsage {
  apparentBytes: number
  allocatedBytes: number
  entries: number
}

export interface GenerationStorageReport {
  logicalProfile: string
  totals: { generations: number; apparentBytes: number; allocatedBytes: number }
  generations: Array<Record<string, unknown> & {
    id: string
    protected: boolean
    failed: boolean
    usage: GenerationUsage
  }>
}

export interface GenerationCleanupResult {
  logicalProfile: string
  applied: boolean
  keepFailed: number
  generations: string[]
  reclaimableBytes?: number
  reclaimedBytes?: number
}

export function generationStorage(home?: string, logicalProfile?: string): Promise<GenerationStorageReport>
export function cleanupFailedGenerations(home?: string, logicalProfile?: string, options?: {
  keepFailed?: number
  apply?: boolean
}): Promise<GenerationCleanupResult>
