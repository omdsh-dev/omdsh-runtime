export interface MarketFacts {
  level?: 'L0' | 'L1' | 'L2' | 'L3'
  vulnerabilities?: { critical?: number; high?: number }
  installScripts?: boolean
  nativeCode?: boolean
  dynamicCodeDownload?: boolean
  obfuscated?: boolean
  dangerousPermissions?: boolean
  requestsTrustedPublisher?: boolean
}
export interface MarketDecision {
  listing: 'auto-listed' | 'review-required' | 'blocked'
  manualReview: boolean
  reasons: readonly string[]
  activation: 'hot-eligible' | 'handshake-required' | 'restart-required'
  installScripts: 'blocked-by-default' | 'none-declared'
  recovery: {
    artifactAndProfile: 'generation'
    runtime: 'cordis-or-reload' | 'process-dispose' | 'restart'
    externalSideEffects: 'not-guaranteed'
  }
}
export function evaluateMarketFacts(input?: MarketFacts): Readonly<MarketDecision>

