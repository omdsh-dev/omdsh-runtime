function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value
}

export function defineMarketMetadata(value) {
  const metadata = structuredClone(plainObject(value, 'market metadata'))
  if (metadata.displayName !== undefined && typeof metadata.displayName !== 'string') {
    throw new TypeError('displayName must be a string')
  }
  if (metadata.compatibility !== undefined) plainObject(metadata.compatibility, 'compatibility')
  if (metadata.permissions !== undefined) plainObject(metadata.permissions, 'permissions')
  return Object.freeze(metadata)
}

export function definePermissions(value) {
  return Object.freeze(structuredClone(plainObject(value, 'permissions')))
}

