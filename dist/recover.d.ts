import type { ExtensionStatus } from './index.js'
export function status(home?: string, profile?: string): Promise<ExtensionStatus>
export function resolveProfile(home?: string, profile?: string): Promise<string>
export function recover(home?: string, profile?: string, options?: { to?: string }): Promise<Record<string, unknown>>
