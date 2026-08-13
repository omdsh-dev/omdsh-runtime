import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { registryEntryGate } from './management.mjs'
import { resolveDshHome } from './paths.mjs'

export const REGISTRY_SCHEMA = 'omdsh-registry/v1'
export const REGISTRY_ORIGINS = Object.freeze([
  'https://hub.omdsh.dev/registry-v1.json',
  'https://hub.0.org.cn/registry-v1.json',
])

const BUNDLED_REGISTRY = new URL('./registry-v1.json', import.meta.url)
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const EXACT_SEMVER_RE = /^(?:v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const PINNED_GIT_RE = /^(?:git\+https:\/\/|https:\/\/|github:)[^#\s]+#[0-9a-f]{40}$/
const GUIDED_INSTALL_METHODS = new Set(['marisa', 'plugin-registry', 'source', 'manual', 'npm', 'script'])
const REPOSITORY_PLUGIN_RE = /^github:([^/\s#&]+)\/([^/\s#&]+)#([0-9a-f]{40})(?:&path:(\/[^\s&]+))?$/

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value
}

function exactKeys(value, required, name) {
  const keys = Object.keys(value).sort()
  const expected = [...required].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has unexpected fields`)
  }
}

function string(value, name, options = {}) {
  if (typeof value !== 'string' || (options.empty !== true && value === '')) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    throw new TypeError(`${name} has an invalid format`)
  }
  return value
}

function nullableString(value, name) {
  return value === null ? null : string(value, name)
}

function timestamp(value, name) {
  const text = string(value, name)
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    throw new TypeError(`${name} must be a normalized ISO timestamp`)
  }
  return text
}

function httpsUrl(value, name) {
  const text = string(value, name)
  let parsed
  try { parsed = new URL(text) } catch { throw new TypeError(`${name} must be a URL`) }
  if (parsed.protocol !== 'https:') throw new TypeError(`${name} must use HTTPS`)
  return text
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) {
    throw new TypeError(`${name} must be an array of non-empty strings`)
  }
  if (new Set(value).size !== value.length) throw new TypeError(`${name} must not contain duplicates`)
  return value
}

function author(value, name) {
  const item = object(value, name)
  exactKeys(item, ['name', 'url'], name)
  string(item.name, `${name}.name`)
  httpsUrl(item.url, `${name}.url`)
  return item
}

function source(value, name) {
  const item = object(value, name)
  exactKeys(item, ['repository', 'ref', 'path'], name)
  httpsUrl(item.repository, `${name}.repository`)
  string(item.ref, `${name}.ref`, { pattern: /^[0-9a-f]{40}$/ })
  if (item.path !== null) string(item.path, `${name}.path`, { pattern: /^\// })
  return item
}

function compatibility(value, name) {
  const item = object(value, name)
  exactKeys(item, ['declared'], name)
  nullableString(item.declared, `${name}.declared`)
  return item
}

function risk(value, name) {
  const item = object(value, name)
  exactKeys(item, ['level', 'facts'], name)
  if (!['unknown', 'low', 'medium', 'high', 'critical'].includes(item.level)) {
    throw new TypeError(`${name}.level is unsupported`)
  }
  const facts = object(item.facts, `${name}.facts`)
  exactKeys(facts, ['sourcePinned', 'vulnerabilityScan', 'permissions', 'nativeCode', 'installScripts'], `${name}.facts`)
  if (facts.sourcePinned !== true
    || !['unknown', 'passed', 'findings'].includes(facts.vulnerabilityScan)
    || !['unknown', 'declared', 'reviewed'].includes(facts.permissions)
    || !['unknown', 'present', 'absent'].includes(facts.nativeCode)
    || !['unknown', 'present', 'absent'].includes(facts.installScripts)) {
    throw new TypeError(`${name}.facts contains unsupported claims`)
  }
  return item
}

function listing(value, name) {
  const item = object(value, name)
  exactKeys(item, ['state', 'catalogStatus', 'trustedPublisher'], name)
  if (!['auto-listed', 'review-required', 'reviewed', 'blocked'].includes(item.state)) {
    throw new TypeError(`${name}.state is unsupported`)
  }
  if (!['verified', 'beta', 'prototype'].includes(item.catalogStatus)) {
    throw new TypeError(`${name}.catalogStatus is unsupported`)
  }
  if (!['unknown', 'requested', 'verified'].includes(item.trustedPublisher)) {
    throw new TypeError(`${name}.trustedPublisher is unsupported`)
  }
  return item
}

function maintenance(value, name) {
  const item = object(value, name)
  exactKeys(item, ['state', 'notice', 'successor'], name)
  if (!['active', 'deprecated', 'archived'].includes(item.state)) throw new TypeError(`${name}.state is unsupported`)
  nullableString(item.notice, `${name}.notice`)
  nullableString(item.successor, `${name}.successor`)
  return item
}

export function isExactPackageSpec(value) {
  return typeof value === 'string' && (EXACT_SEMVER_RE.test(value) || PINNED_GIT_RE.test(value))
}

export function isPinnedRepositorySpec(value) {
  if (typeof value !== 'string') return false
  const match = REPOSITORY_PLUGIN_RE.exec(value)
  if (match === null) return false
  const path = match[4] ?? '/.dsh-plugin'
  const segments = path.split('/').slice(1)
  return segments.length > 0
    && segments.at(-1) === '.dsh-plugin'
    && segments.every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function install(value, name) {
  const item = object(value, name)
  if (item.mode === 'guided') {
    exactKeys(item, ['mode', 'method'], name)
    if (!GUIDED_INSTALL_METHODS.has(item.method)) throw new TypeError(`${name}.method is unsupported`)
    return item
  }
  if (item.mode === 'profile-bundle') {
    exactKeys(item, ['mode', 'adapter', 'packageName', 'spec'], name)
    if (item.adapter !== 'official-profile/v1') throw new TypeError(`${name}.adapter is unsupported`)
    string(item.packageName, `${name}.packageName`, { pattern: PACKAGE_NAME_RE })
    if (!isExactPackageSpec(item.spec)) throw new TypeError(`${name}.spec must be exact and immutable`)
    return item
  }
  if (item.mode === 'repository-plugin') {
    exactKeys(item, ['mode', 'adapter', 'spec'], name)
    if (item.adapter !== 'official-repository/v1') throw new TypeError(`${name}.adapter is unsupported`)
    if (!isPinnedRepositorySpec(item.spec)) throw new TypeError(`${name}.spec must be an immutable Repository Plugin spec`)
    return item
  }
  throw new TypeError(`${name}.mode is unsupported`)
}

function links(value, name) {
  const item = object(value, name)
  exactKeys(item, ['atlas', 'repository'], name)
  httpsUrl(item.atlas, `${name}.atlas`)
  httpsUrl(item.repository, `${name}.repository`)
  return item
}

function release(value, name) {
  const item = object(value, name)
  exactKeys(item, ['id', 'version', 'ref', 'updatedAt', 'channel', 'source', 'compatibility', 'install'], name)
  string(item.id, `${name}.id`)
  nullableString(item.version, `${name}.version`)
  string(item.ref, `${name}.ref`, { pattern: /^[0-9a-f]{40}$/ })
  timestamp(item.updatedAt, `${name}.updatedAt`)
  if (!['stable', 'beta', 'nightly'].includes(item.channel)) throw new TypeError(`${name}.channel is unsupported`)
  source(item.source, `${name}.source`)
  compatibility(item.compatibility, `${name}.compatibility`)
  install(item.install, `${name}.install`)
  if (item.source.ref !== item.ref) throw new TypeError(`${name}.source.ref must match ref`)
  return item
}

function entry(value, index) {
  const name = `entries[${index}]`
  const item = object(value, name)
  const fields = [
    'id', 'displayName', 'description', 'kind', 'tags', 'author', 'version', 'license',
    'source', 'compatibility', 'risk', 'listing', 'maintenance', 'install', 'links',
  ]
  const hasReleases = Object.hasOwn(item, 'latestRelease') || Object.hasOwn(item, 'releases')
  exactKeys(item, hasReleases ? [...fields, 'latestRelease', 'releases'] : fields, name)
  string(item.id, `${name}.id`, { pattern: /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/ })
  string(item.displayName, `${name}.displayName`)
  string(item.description, `${name}.description`)
  string(item.kind, `${name}.kind`)
  stringArray(item.tags, `${name}.tags`)
  author(item.author, `${name}.author`)
  nullableString(item.version, `${name}.version`)
  string(item.license, `${name}.license`)
  source(item.source, `${name}.source`)
  compatibility(item.compatibility, `${name}.compatibility`)
  risk(item.risk, `${name}.risk`)
  listing(item.listing, `${name}.listing`)
  maintenance(item.maintenance, `${name}.maintenance`)
  install(item.install, `${name}.install`)
  links(item.links, `${name}.links`)
  if (hasReleases) {
    string(item.latestRelease, `${name}.latestRelease`)
    if (!Array.isArray(item.releases) || item.releases.length === 0) throw new TypeError(`${name}.releases must be a non-empty array`)
    item.releases.forEach((candidate, releaseIndex) => release(candidate, `${name}.releases[${releaseIndex}]`))
    const releaseIds = item.releases.map(candidate => candidate.id)
    if (new Set(releaseIds).size !== releaseIds.length) throw new TypeError(`${name}.releases contains duplicate IDs`)
    const current = item.releases.find(candidate => candidate.id === item.latestRelease)
    if (current === undefined) throw new TypeError(`${name}.latestRelease does not exist`)
    if (canonicalJson(current.source) !== canonicalJson(item.source)
      || canonicalJson(current.compatibility) !== canonicalJson(item.compatibility)
      || canonicalJson(current.install) !== canonicalJson(item.install)
      || current.version !== item.version) {
      throw new TypeError(`${name}.latestRelease does not match the current entry facts`)
    }
  }
  return item
}

function collection(value, index, entries) {
  const name = `collections[${index}]`
  const item = object(value, name)
  const hasTranslations = Object.hasOwn(item, 'translations')
  exactKeys(item, hasTranslations
    ? ['id', 'title', 'summary', 'translations', 'author', 'featured', 'items']
    : ['id', 'title', 'summary', 'author', 'featured', 'items'], name)
  string(item.id, `${name}.id`, { pattern: /^[a-z0-9][a-z0-9-]*$/ })
  string(item.title, `${name}.title`)
  string(item.summary, `${name}.summary`)
  if (hasTranslations) {
    const translations = object(item.translations, `${name}.translations`)
    exactKeys(translations, ['en'], `${name}.translations`)
    const english = object(translations.en, `${name}.translations.en`)
    exactKeys(english, ['title', 'summary'], `${name}.translations.en`)
    string(english.title, `${name}.translations.en.title`)
    string(english.summary, `${name}.translations.en.summary`)
  }
  author(item.author, `${name}.author`)
  if (typeof item.featured !== 'boolean') throw new TypeError(`${name}.featured must be boolean`)
  if (!Array.isArray(item.items) || item.items.length === 0) throw new TypeError(`${name}.items must be a non-empty array`)
  const seen = new Set()
  item.items.forEach((value, itemIndex) => {
    const itemName = `${name}.items[${itemIndex}]`
    const intent = object(value, itemName)
    exactKeys(intent, ['projectId', 'releaseId', 'packageName', 'spec'], itemName)
    string(intent.projectId, `${itemName}.projectId`)
    string(intent.releaseId, `${itemName}.releaseId`)
    string(intent.packageName, `${itemName}.packageName`, { pattern: PACKAGE_NAME_RE })
    if (!isExactPackageSpec(intent.spec)) throw new TypeError(`${itemName}.spec must be exact and immutable`)
    if (seen.has(intent.projectId)) throw new TypeError(`${name}.items contains duplicate projects`)
    seen.add(intent.projectId)
    const project = entries.find(entry => entry.id === intent.projectId)
    const projectRelease = project?.releases?.find(release => release.id === intent.releaseId)
    if (projectRelease?.install.mode !== 'profile-bundle'
      || projectRelease.install.packageName !== intent.packageName
      || projectRelease.install.spec !== intent.spec) {
      throw new TypeError(`${itemName} does not match a transactionally installable Registry Release`)
    }
  })
  return item
}

function signature(value) {
  if (value === null) return null
  const item = object(value, 'signature')
  exactKeys(item, ['algorithm', 'keyId', 'value'], 'signature')
  if (item.algorithm !== 'Ed25519') throw new TypeError('signature.algorithm must be Ed25519')
  string(item.keyId, 'signature.keyId')
  string(item.value, 'signature.value', { pattern: /^[A-Za-z0-9+/]+={0,2}$/ })
  if (Buffer.from(item.value, 'base64').length !== 64) throw new TypeError('signature.value is not an Ed25519 signature')
  return item
}

function jsonObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot contain non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (jsonObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`)
}

export function registryPayload(document) {
  const payload = {
    schema: document.schema,
    revision: document.revision,
    generatedAt: document.generatedAt,
    origins: document.origins,
    entries: document.entries,
  }
  if (Array.isArray(document.collections)) payload.collections = document.collections
  return payload
}

export function registrySnapshotId(document) {
  return `sha256:${createHash('sha256').update(canonicalJson(registryPayload(document))).digest('hex')}`
}

function constantEqual(first, second) {
  const left = Buffer.from(first)
  const right = Buffer.from(second)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function parseRegistry(value, options = {}) {
  const document = object(value, 'registry')
  const fields = ['schema', 'revision', 'generatedAt', 'origins', 'entries', 'snapshotId', 'signature']
  exactKeys(document, Object.hasOwn(document, 'collections') ? [...fields, 'collections'] : fields, 'registry')
  if (document.schema !== REGISTRY_SCHEMA) throw new TypeError('unsupported Registry schema')
  if (!Number.isSafeInteger(document.revision) || document.revision < 0) throw new TypeError('revision must be a non-negative integer')
  const generatedAt = timestamp(document.generatedAt, 'generatedAt')
  if (document.revision !== Date.parse(generatedAt)) throw new TypeError('revision must match generatedAt')
  stringArray(document.origins, 'origins').forEach((origin, index) => httpsUrl(origin, `origins[${index}]`))
  if (!Array.isArray(document.entries)) throw new TypeError('entries must be an array')
  document.entries.forEach(entry)
  const ids = document.entries.map(item => item.id)
  if (new Set(ids).size !== ids.length) throw new TypeError('Registry contains duplicate entry IDs')
  if (ids.some((id, index) => index > 0 && ids[index - 1].localeCompare(id) >= 0)) {
    throw new TypeError('Registry entries must be sorted by ID')
  }
  if (Object.hasOwn(document, 'collections')) {
    if (!Array.isArray(document.collections)) throw new TypeError('collections must be an array')
    document.collections.forEach((item, index) => collection(item, index, document.entries))
    const collectionIds = document.collections.map(item => item.id)
    if (new Set(collectionIds).size !== collectionIds.length) throw new TypeError('Registry contains duplicate collection IDs')
    if (collectionIds.some((id, index) => index > 0 && collectionIds[index - 1].localeCompare(id) >= 0)) {
      throw new TypeError('Registry collections must be sorted by ID')
    }
  }
  string(document.snapshotId, 'snapshotId', { pattern: /^sha256:[0-9a-f]{64}$/ })
  const expectedSnapshot = registrySnapshotId(document)
  if (!constantEqual(document.snapshotId, expectedSnapshot)) throw new Error('Registry snapshot digest does not match')
  const registrySignature = signature(document.signature)
  if (registrySignature === null) {
    if (options.allowUnsigned !== true) throw new Error('remote Registry must be signed')
  } else {
    const publicKey = options.trustedKeys?.[registrySignature.keyId]
    if (publicKey === undefined) throw new Error(`untrusted Registry signing key ${JSON.stringify(registrySignature.keyId)}`)
    const valid = verify(
      null,
      Buffer.from(canonicalJson(registryPayload(document))),
      createPublicKey(publicKey),
      Buffer.from(registrySignature.value, 'base64'),
    )
    if (!valid) throw new Error('Registry signature is invalid')
  }
  return document
}

async function jsonFile(filename) {
  return JSON.parse(await readFile(filename, 'utf8'))
}

export class RegistryClient {
  constructor(options = {}) {
    this.home = resolveDshHome(options.home)
    this.trustedKeys = Object.freeze({ ...(options.trustedKeys ?? {}) })
    this.bundledFile = options.bundledFile ?? BUNDLED_REGISTRY
    this.loaded = null
  }

  async current() {
    if (this.loaded !== null) return this.loaded
    const bundled = parseRegistry(await jsonFile(this.bundledFile), { allowUnsigned: true, trustedKeys: this.trustedKeys })
    this.loaded = { document: bundled, source: 'bundled', warning: null }
    return this.loaded
  }

  async view(query = '') {
    const selected = await this.current()
    const needle = String(query).trim().toLocaleLowerCase()
    const entries = needle === '' ? selected.document.entries : selected.document.entries.filter(item => [
      item.id, item.displayName, item.description, item.kind, item.author.name, ...item.tags,
    ].some(value => value.toLocaleLowerCase().includes(needle)))
    return {
      schema: 'omdsh.registry-view/v1',
      snapshot: {
        revision: selected.document.revision,
        generatedAt: selected.document.generatedAt,
        snapshotId: selected.document.snapshotId,
        source: selected.source,
        warning: selected.warning,
        remoteSync: false,
      },
      entries,
      collections: selected.document.collections ?? [],
    }
  }

  async resolveInstall(id, releaseId) {
    const action = await this.resolveAction(id, releaseId)
    if (action.install.mode !== 'profile-bundle') {
      throw new Error(`Registry entry ${JSON.stringify(id)} is not a Profile Bundle`)
    }
    return Object.freeze({
      id: action.id,
      releaseId: action.releaseId,
      packageName: action.install.packageName,
      spec: action.install.spec,
    })
  }

  async resolveAction(id, releaseId) {
    const selected = await this.current()
    const item = selected.document.entries.find(entry => entry.id === id)
    if (item === undefined) throw new Error(`Registry entry not found: ${JSON.stringify(id)}`)
    const gate = registryEntryGate(item)
    if (gate === 'approval') {
      throw new Error(`Registry entry ${JSON.stringify(id)} is not approved for installation`)
    }
    if (gate === 'security') {
      throw new Error(`Registry entry ${JSON.stringify(id)} requires security review`)
    }
    if (item.maintenance.state === 'archived') {
      throw new Error(`Registry entry ${JSON.stringify(id)} is archived`)
    }
    const selectedRelease = releaseId === undefined
      ? item.releases?.find(release => release.id === item.latestRelease)
      : item.releases?.find(release => release.id === releaseId)
    if (releaseId !== undefined && selectedRelease === undefined) {
      throw new Error(`Registry Release not found: ${JSON.stringify(releaseId)}`)
    }
    const installIntent = selectedRelease?.install ?? item.install
    return Object.freeze({
      id: item.id,
      releaseId: selectedRelease?.id ?? null,
      install: Object.freeze({ ...installIntent }),
      maintenance: item.maintenance,
      links: item.links,
    })
  }

  async resolveCollection(id) {
    const selected = await this.current()
    const item = (selected.document.collections ?? []).find(collection => collection.id === id)
    if (item === undefined) throw new Error(`Registry collection not found: ${JSON.stringify(id)}`)
    const intents = []
    for (const candidate of item.items) {
      const intent = await this.resolveInstall(candidate.projectId, candidate.releaseId)
      if (intent.packageName !== candidate.packageName || intent.spec !== candidate.spec) {
        throw new Error(`Registry collection ${JSON.stringify(id)} contains an inconsistent intent`)
      }
      intents.push(intent)
    }
    return Object.freeze({ id: item.id, title: item.title, intents: Object.freeze(intents) })
  }

  async sync() {
    throw new Error('Runtime Workshop snapshots are read-only; update them with workshop:vendor')
  }
}
