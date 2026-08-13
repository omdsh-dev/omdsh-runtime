export interface MarketMetadata {
  displayName?: string
  compatibility?: Record<string, unknown>
  permissions?: Record<string, unknown>
  [key: string]: unknown
}
export function defineMarketMetadata<T extends MarketMetadata>(value: T): Readonly<T>
export function definePermissions<T extends Record<string, unknown>>(value: T): Readonly<T>

