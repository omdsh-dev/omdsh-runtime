export type LicenseFamily = 'permissive' | 'public-domain' | 'weak-copyleft' | 'copyleft' | 'custom' | 'unknown' | 'other'
export interface LicenseFacts {
  expression: string
  family: LicenseFamily
  review: 'notice' | 'required'
  source: string
  url: string
}
export function assertLicenseExpression(value: unknown, name?: string): string
export function licenseFacts(expression: string, source?: string): LicenseFacts
export function registryLicense(entry: Record<string, unknown>, release: Record<string, unknown>): LicenseFacts
