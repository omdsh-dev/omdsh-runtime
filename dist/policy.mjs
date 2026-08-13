const LEVELS = new Set(['L0', 'L1', 'L2', 'L3'])

function boolean(value, fallback = false) {
  return value === undefined ? fallback : value === true
}

export function evaluateMarketFacts(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('market facts must be an object')
  }
  const level = input.level ?? 'L3'
  if (!LEVELS.has(level)) throw new TypeError(`unknown extension level ${JSON.stringify(level)}`)
  const vulnerabilities = input.vulnerabilities ?? {}
  const critical = Number(vulnerabilities.critical ?? 0)
  const high = Number(vulnerabilities.high ?? 0)
  const installScripts = boolean(input.installScripts)
  const nativeCode = boolean(input.nativeCode)
  const dynamicCodeDownload = boolean(input.dynamicCodeDownload)
  const obfuscated = boolean(input.obfuscated)
  const dangerousPermissions = boolean(input.dangerousPermissions)
  const requestsTrustedPublisher = boolean(input.requestsTrustedPublisher)
  const reasons = []
  if (critical > 0) reasons.push('critical-vulnerability')
  if (high > 0) reasons.push('high-vulnerability')
  if (installScripts) reasons.push('install-scripts')
  if (nativeCode) reasons.push('native-code')
  if (dynamicCodeDownload) reasons.push('dynamic-code-download')
  if (obfuscated) reasons.push('obfuscated-code')
  if (dangerousPermissions) reasons.push('dangerous-permissions')
  if (requestsTrustedPublisher) reasons.push('trusted-publisher-review')

  const blocked = critical > 0
  const manualReview = blocked || reasons.length > 0
  const activation = level === 'L0' || level === 'L1'
    ? 'hot-eligible'
    : level === 'L2'
      ? 'handshake-required'
      : 'restart-required'

  return Object.freeze({
    listing: blocked ? 'blocked' : manualReview ? 'review-required' : 'auto-listed',
    manualReview,
    reasons: Object.freeze(reasons),
    activation,
    installScripts: installScripts ? 'blocked-by-default' : 'none-declared',
    recovery: Object.freeze({
      artifactAndProfile: 'generation',
      runtime: level === 'L0' || level === 'L1' ? 'cordis-or-reload' : level === 'L2' ? 'process-dispose' : 'restart',
      externalSideEffects: 'not-guaranteed',
    }),
  })
}

