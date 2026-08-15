const SPDX_ID_RE = /^(?:[A-Za-z0-9][A-Za-z0-9.-]*|LicenseRef-[A-Za-z0-9.-]+)(?:\+)?$/
const PERMISSIVE = new Set(['0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSL-1.0', 'ISC', 'MIT', 'MIT-0', 'NCSA', 'PostgreSQL', 'Python-2.0', 'Zlib'])
const PUBLIC_DOMAIN = new Set(['CC0-1.0', 'Unlicense'])
const WEAK_COPYLEFT = /^(?:EPL|LGPL|MPL|CDDL)-/
const COPYLEFT = /^(?:AGPL|GPL)-/
const UNKNOWN = new Set(['NOASSERTION', 'NONE', 'UNLICENSED'])

function ids(expression) {
  return expression.replace(/[()]/g, ' ').split(/\s+(?:AND|OR|WITH)\s+|\s+/).map(value => value.trim()).filter(Boolean)
}

function parseExpression(expression) {
  const tokens = expression.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[^\s()]+/g) || []
  let offset = 0
  function primary() {
    if (tokens[offset] === '(') {
      offset += 1
      disjunction()
      if (tokens[offset] !== ')') throw new Error('unclosed group')
      offset += 1
      return
    }
    const license = tokens[offset]
    if (!SPDX_ID_RE.test(license || '') || UNKNOWN.has(license)) throw new Error('license ID expected')
    offset += 1
    if (tokens[offset] === 'WITH') {
      offset += 1
      const exception = tokens[offset]
      if (!SPDX_ID_RE.test(exception || '') || UNKNOWN.has(exception) || exception.endsWith('+')) throw new Error('exception ID expected')
      offset += 1
    }
  }
  function conjunction() {
    primary()
    while (tokens[offset] === 'AND') { offset += 1; primary() }
  }
  function disjunction() {
    conjunction()
    while (tokens[offset] === 'OR') { offset += 1; conjunction() }
  }
  disjunction()
  if (offset !== tokens.length) throw new Error('unexpected token')
}

export function assertLicenseExpression(value, name = 'license expression') {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) throw new Error(`${name} is invalid`)
  const expression = value.trim()
  if (!UNKNOWN.has(expression)) try { parseExpression(expression) } catch { throw new Error(`${name} must use an SPDX expression, LicenseRef, or NOASSERTION`) }
  return expression
}

export function licenseFacts(expression, source = 'registry') {
  const normalized = assertLicenseExpression(expression)
  const values = ids(normalized)
  const unknown = values.length === 0 || values.some(value => UNKNOWN.has(value))
  const custom = values.some(value => value.startsWith('LicenseRef-'))
  let family = 'other'
  if (unknown) family = 'unknown'
  else if (custom) family = 'custom'
  else if (values.some(value => COPYLEFT.test(value))) family = 'copyleft'
  else if (values.some(value => WEAK_COPYLEFT.test(value))) family = 'weak-copyleft'
  else if (values.every(value => PERMISSIVE.has(value))) family = 'permissive'
  else if (values.every(value => PUBLIC_DOMAIN.has(value))) family = 'public-domain'
  return {
    expression: normalized,
    family,
    review: ['unknown', 'custom', 'other'].includes(family) ? 'required' : 'notice',
    source,
    url: values.length === 1 && !unknown && !custom
      ? `https://spdx.org/licenses/${encodeURIComponent(values[0].replace(/\+$/, '-or-later'))}.html`
      : 'https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/',
  }
}

export function registryLicense(entry, release) {
  return licenseFacts(release?.license ?? entry?.license ?? 'NOASSERTION', 'registry')
}
