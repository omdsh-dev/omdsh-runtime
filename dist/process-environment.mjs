const PACKAGE_CREDENTIAL_KEYS = [
  /^NPM_TOKEN$/i,
  /^NODE_AUTH_TOKEN$/i,
  /^YARN_NPM_AUTH_TOKEN$/i,
  /^npm_config_.*(?:auth|token|password|username)/i,
]

const SECRET_VALUE_KEYS = [
  /(?:auth.*token|token|secret|password|private.?key|authorization)/i,
]

function matchesAny(key, patterns) {
  return patterns.some(pattern => pattern.test(key))
}

export function withoutPackageCredentials(environment = {}) {
  return Object.fromEntries(Object.entries(environment)
    .filter(([key]) => !matchesAny(key, PACKAGE_CREDENTIAL_KEYS)))
}

function replaceAllLiteral(value, secret) {
  return secret.length < 4 ? value : value.split(secret).join('[redacted]')
}

export function redactDiagnostic(value, environment = {}, maxLength = 4096) {
  let text = String(value ?? '')
  for (const [key, secret] of Object.entries(environment)) {
    if ((!matchesAny(key, SECRET_VALUE_KEYS) && !matchesAny(key, PACKAGE_CREDENTIAL_KEYS))
      || typeof secret !== 'string') continue
    text = replaceAllLiteral(text, secret)
  }
  text = text
    .replace(/\b(?:npm|gh[opusr])_[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
  if (text.length > maxLength) return `${text.slice(0, maxLength)}…`
  return text
}
