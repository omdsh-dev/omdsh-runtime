export const PACK_SOURCE_SCHEMA: 'omdsh-pack-source/v1'
export function parsePackSource(value: unknown): Record<string, unknown>
export function createPackSource(options: { id: string; version?: string; preset?: string }): Record<string, unknown>
export function addRegistryItem(source: Record<string, unknown>, options: { projectId: string; releaseId: string; enabled?: boolean }): Record<string, unknown>
export function addFixedSourceItem(source: Record<string, unknown>, options: { id: string; packageName: string; version: string; repository: string; ref: string; license: string; licenseSource?: string; enabled?: boolean }): Record<string, unknown>
export function removePackItem(source: Record<string, unknown>, id: string): Record<string, unknown>
export function readPackSourceFile(filename: string): Promise<Record<string, unknown>>
export function writeNewPackSource(filename: string, value: Record<string, unknown>): Promise<Record<string, unknown>>
export function updatePackSourceFile(filename: string, update: (source: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<Record<string, unknown>>
