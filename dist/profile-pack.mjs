import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto'
import { access, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWriteJson } from './atomic.mjs'
import { readRepositorySpecs, repositorySpecIdentity } from './adapters/repository-config-v1.mjs'
import { assertLicenseExpression, licenseFacts, registryLicense } from './license.mjs'
import { agentPresetsDirectory, assertProfileName } from './paths.mjs'
import { canonicalJson } from './registry.mjs'
import { PACK_INSTANCE_SCHEMA, readPackInstance, writePackInstance } from './pack-instances.mjs'

export const PROFILE_PACK_SCHEMA = 'omdsh-profile-pack/v1'
export const PROFILE_PACK_ENVELOPE_SCHEMA = 'omdsh-profile-pack-envelope/v1'
export const BUILTIN_AGENT_PRESETS = Object.freeze(['code', 'cordis', 'minimal', 'standard'])

const PACK_LIMIT = 5 * 1024 * 1024
const PRESET_FILE_LIMIT = 512 * 1024
const PRESET_TOTAL_LIMIT = 2 * 1024 * 1024
const PRESET_FILE_COUNT_LIMIT = 256
const ID_RE = /^[a-z0-9][a-z0-9-]*$/
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,127}$/
const PUBLISHER_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,127}$/
const PACKAGE_NAME_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/
const GITHUB_REPOSITORY_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/
const FIXED_GITHUB_SPEC_RE = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([0-9a-f]{40})$/
const OFFICIAL_PROFILE_PACKAGES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@omdsh/runtime',
  '@omdsh/dsh-hub',
])
const POLICY = Object.freeze({
  pluginPayloads: 'registry-references-and-fixed-source',
  registryManagedPlugins: 'replace',
  fixedSourcePlugins: 'explicit-trust',
  untrackedPackages: 'preserve',
  credentials: 'excluded',
  sessions: 'excluded',
  localPaths: 'excluded',
  activation: 'candidate-and-confirm',
  presetRollback: 'outside-profile-generation',
})

function validateLicenseRecord(value, name) {
  const record = object(value, name)
  exactKeys(record, ['expression', 'family', 'review', 'source', 'url'], name)
  const expected = licenseFacts(assertLicenseExpression(record.expression, `${name}.expression`), record.source)
  if (canonicalJson(record) !== canonicalJson(expected)) throw new Error(`${name} does not match its SPDX facts`)
  return record
}

function validateSourcePlugin(value, index) {
  const name = `sourcePlugins[${index}]`
  const plugin = object(value, name)
  exactKeys(plugin, ['id', 'packageName', 'version', 'enabled', 'license', 'source', 'install', 'trust'], name)
  string(plugin.id, `${name}.id`, ID_RE)
  string(plugin.packageName, `${name}.packageName`, PACKAGE_NAME_RE)
  string(plugin.version, `${name}.version`, SEMVER_RE)
  if (typeof plugin.enabled !== 'boolean') throw new TypeError(`${name}.enabled must be boolean`)
  validateLicenseRecord(plugin.license, `${name}.license`)
  const source = object(plugin.source, `${name}.source`)
  exactKeys(source, ['repository', 'ref'], `${name}.source`)
  const repository = GITHUB_REPOSITORY_RE.exec(string(source.repository, `${name}.source.repository`))
  string(source.ref, `${name}.source.ref`, /^[0-9a-f]{40}$/)
  const install = object(plugin.install, `${name}.install`)
  exactKeys(install, ['mode', 'spec'], `${name}.install`)
  if (install.mode !== 'profile-bundle') throw new Error(`${name}.install.mode is unsupported`)
  const spec = FIXED_GITHUB_SPEC_RE.exec(string(install.spec, `${name}.install.spec`))
  if (repository === null || spec === null || repository[1].toLowerCase() !== spec[1].toLowerCase()
    || repository[2].toLowerCase() !== spec[2].toLowerCase() || source.ref !== spec[3]) {
    throw new Error(`${name}.install.spec must match its fixed source`)
  }
  if (plugin.trust !== 'author-fixed-source') throw new Error(`${name}.trust is unsupported`)
  return plugin
}

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value
}

function exactKeys(value, keys, name) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has unexpected fields`)
  }
}

function string(value, name, pattern) {
  if (typeof value !== 'string' || value === '' || (pattern !== undefined && !pattern.test(value))) {
    throw new TypeError(`${name} has an invalid value`)
  }
  return value
}

function nullableString(value, name, pattern) {
  return value === null ? null : string(value, name, pattern)
}

function timestamp(value, name) {
  const text = string(value, name)
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    throw new TypeError(`${name} must be a normalized ISO timestamp`)
  }
  return text
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function packPayload(value) {
  const { digest: _digest, ...payload } = value
  return payload
}

export function profilePackDigest(value) {
  return sha256(canonicalJson(packPayload(value)))
}

function assertDigest(value, name) {
  return string(value, name, DIGEST_RE)
}

function assertPresetPath(value, name = 'preset file path') {
  const path = string(value, name)
  const segments = path.split('/')
  if (path.startsWith('/') || path.includes('\\') || segments.some(segment => segment === ''
    || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw new Error(`${name} is unsafe`)
  }
  const filename = segments.at(-1).toLocaleLowerCase('en-US')
  if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials|secrets?|tokens?)(?:\.|$)/.test(filename)
    || /(?:^|\.)(?:env|npmrc|netrc)$/.test(filename)) {
    throw new Error(`${name} is credential-like`)
  }
  return path
}

function assertSafePresetContent(content, name) {
  if (content.includes('\0')) throw new Error(`${name} is not a text file`)
  const credentialPatterns = [
    /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/,
    /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bnpm_[A-Za-z0-9]{20,}\b/,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
  ]
  if (credentialPatterns.some(pattern => pattern.test(content))) throw new Error(`${name} contains credential-like material`)
  if (/(?:^|[\s"'=:(])(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/m.test(content)) {
    throw new Error(`${name} contains an absolute user path`)
  }
}

function validatePresetFile(value, index) {
  const name = `agentPreset.files[${index}]`
  const file = object(value, name)
  exactKeys(file, ['path', 'sha256', 'content'], name)
  assertPresetPath(file.path, `${name}.path`)
  if (typeof file.content !== 'string') throw new TypeError(`${name}.content must be text`)
  if (Buffer.byteLength(file.content) > PRESET_FILE_LIMIT) throw new Error(`${name}.content is too large`)
  assertSafePresetContent(file.content, name)
  assertDigest(file.sha256, `${name}.sha256`)
  if (file.sha256 !== sha256(file.content)) throw new Error(`${name}.sha256 does not match its content`)
  return file
}

function validateAgentPreset(value) {
  const preset = object(value, 'agentPreset')
  exactKeys(preset, ['mode', 'id', 'sha256', 'files'], 'agentPreset')
  string(preset.id, 'agentPreset.id', ID_RE)
  if (!Array.isArray(preset.files)) throw new TypeError('agentPreset.files must be an array')
  if (preset.mode === 'builtin') {
    if (!BUILTIN_AGENT_PRESETS.includes(preset.id) || preset.sha256 !== null || preset.files.length !== 0) {
      throw new Error('built-in Agent Preset must be a known ID-only reference')
    }
    return preset
  }
  if (preset.mode !== 'embedded' || BUILTIN_AGENT_PRESETS.includes(preset.id)) {
    throw new Error('agentPreset.mode is unsupported')
  }
  assertDigest(preset.sha256, 'agentPreset.sha256')
  if (preset.files.length === 0 || preset.files.length > PRESET_FILE_COUNT_LIMIT) {
    throw new Error('embedded Agent Preset has an invalid file count')
  }
  preset.files.forEach(validatePresetFile)
  const paths = preset.files.map(file => file.path)
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1].localeCompare(path) >= 0)) {
    throw new Error('embedded Agent Preset files must be unique and sorted')
  }
  if (!paths.includes('agent.cordis.yml')) throw new Error('embedded Agent Preset requires agent.cordis.yml')
  if (preset.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0) > PRESET_TOTAL_LIMIT) {
    throw new Error('embedded Agent Preset is too large')
  }
  if (preset.sha256 !== sha256(canonicalJson(preset.files))) throw new Error('agentPreset.sha256 does not match its files')
  return preset
}

export function parseProfilePack(value) {
  const pack = object(value, 'profile pack')
  exactKeys(pack, [
    'schema', 'id', 'version', 'createdAt', 'runtime', 'registry', 'profile', 'distribution',
    'plugins', 'sourcePlugins', 'agentPreset', 'omitted', 'policy', 'digest',
  ], 'profile pack')
  if (pack.schema !== PROFILE_PACK_SCHEMA) throw new Error('unsupported Profile Pack schema')
  string(pack.id, 'id', ID_RE)
  string(pack.version, 'version', SEMVER_RE)
  timestamp(pack.createdAt, 'createdAt')

  const runtime = object(pack.runtime, 'runtime')
  exactKeys(runtime, ['package', 'version', 'integrity', 'binding'], 'runtime')
  if (runtime.package !== '@deepseek-ai/dsh') throw new Error('runtime.package must be @deepseek-ai/dsh')
  string(runtime.version, 'runtime.version', SEMVER_RE)
  if (runtime.integrity !== null) string(runtime.integrity, 'runtime.integrity', /^sha512-[A-Za-z0-9+/]+={0,2}$/)
  if (!['not-verified', 'local-install-and-lock'].includes(runtime.binding)) throw new Error('runtime.binding is unsupported')
  if ((runtime.integrity === null) !== (runtime.binding === 'not-verified')) {
    throw new Error('runtime integrity and binding must describe the same observation')
  }

  const registry = object(pack.registry, 'registry')
  exactKeys(registry, ['schema', 'snapshotId', 'revision', 'origins'], 'registry')
  if (registry.schema !== 'omdsh-registry/v1') throw new Error('registry.schema is unsupported')
  assertDigest(registry.snapshotId, 'registry.snapshotId')
  if (!Number.isSafeInteger(registry.revision) || registry.revision < 0) throw new Error('registry.revision is invalid')
  if (!Array.isArray(registry.origins) || registry.origins.some(origin => typeof origin !== 'string' || !origin.startsWith('https://'))) {
    throw new Error('registry.origins must contain HTTPS URLs')
  }
  if (new Set(registry.origins).size !== registry.origins.length) throw new Error('registry.origins must not contain duplicates')

  const profile = object(pack.profile, 'profile')
  exactKeys(profile, ['logicalName', 'sourceGeneration'], 'profile')
  nullableString(profile.logicalName, 'profile.logicalName')
  nullableString(profile.sourceGeneration, 'profile.sourceGeneration')
  if ((profile.logicalName === null) !== (profile.sourceGeneration === null)) {
    throw new Error('profile identity must be fully present or fully absent')
  }

  if (pack.distribution !== null) {
    const distribution = object(pack.distribution, 'distribution')
    exactKeys(distribution, ['id', 'version'], 'distribution')
    string(distribution.id, 'distribution.id', ID_RE)
    string(distribution.version, 'distribution.version', SEMVER_RE)
  }
  if (profile.logicalName === null && pack.distribution === null) throw new Error('profile pack has no source identity')

  if (!Array.isArray(pack.plugins)) throw new TypeError('plugins must be an array')
  pack.plugins.forEach((value, index) => {
    const name = `plugins[${index}]`
    const plugin = object(value, name)
    exactKeys(plugin, ['projectId', 'releaseId', 'enabled', 'license'], name)
    string(plugin.projectId, `${name}.projectId`)
    string(plugin.releaseId, `${name}.releaseId`)
    if (typeof plugin.enabled !== 'boolean') throw new TypeError(`${name}.enabled must be boolean`)
    validateLicenseRecord(plugin.license, `${name}.license`)
  })
  const projectIds = pack.plugins.map(plugin => plugin.projectId)
  if (new Set(projectIds).size !== projectIds.length
    || projectIds.some((id, index) => index > 0 && projectIds[index - 1].localeCompare(id) >= 0)) {
    throw new Error('plugins must be unique and sorted by projectId')
  }
  if (!Array.isArray(pack.sourcePlugins)) throw new TypeError('sourcePlugins must be an array')
  pack.sourcePlugins.forEach(validateSourcePlugin)
  const sourceIds = pack.sourcePlugins.map(plugin => plugin.id)
  const sourcePackages = pack.sourcePlugins.map(plugin => plugin.packageName)
  if (new Set(sourceIds).size !== sourceIds.length || new Set(sourcePackages).size !== sourcePackages.length
    || sourceIds.some((id, index) => index > 0 && sourceIds[index - 1].localeCompare(id) >= 0)) {
    throw new Error('sourcePlugins must have unique IDs and packages, sorted by ID')
  }
  if (sourceIds.some(id => projectIds.includes(id))) throw new Error('Registry and fixed-source component IDs must be unique')
  validateAgentPreset(pack.agentPreset)

  if (!Array.isArray(pack.omitted)) throw new TypeError('omitted must be an array')
  pack.omitted.forEach((value, index) => {
    const name = `omitted[${index}]`
    const omitted = object(value, name)
    exactKeys(omitted, ['identity', 'reason'], name)
    string(omitted.identity, `${name}.identity`)
    string(omitted.reason, `${name}.reason`)
  })
  const policy = object(pack.policy, 'policy')
  exactKeys(policy, Object.keys(POLICY), 'policy')
  for (const [key, expected] of Object.entries(POLICY)) {
    if (policy[key] !== expected) throw new Error(`policy.${key} is unsupported`)
  }
  assertDigest(pack.digest, 'digest')
  if (pack.digest !== profilePackDigest(pack)) throw new Error('Profile Pack digest does not match')
  return pack
}

function envelopePayload(value) {
  return { schema: value.schema, pack: value.pack, provenance: value.provenance }
}

function validatePackProvenance(value) {
  const provenance = object(value, 'provenance')
  exactKeys(provenance, ['publisher', 'source', 'issuedAt'], 'provenance')
  string(provenance.publisher, 'provenance.publisher', PUBLISHER_RE)
  timestamp(provenance.issuedAt, 'provenance.issuedAt')
  if (provenance.source !== null) {
    const source = string(provenance.source, 'provenance.source')
    let url
    try { url = new URL(source) } catch { throw new Error('provenance.source must be a valid HTTPS URL') }
    if (url.protocol !== 'https:') throw new Error('provenance.source must be a valid HTTPS URL')
  }
  return provenance
}

export function parseProfilePackEnvelope(value) {
  const envelope = object(value, 'Profile Pack envelope')
  exactKeys(envelope, ['schema', 'pack', 'provenance', 'signature'], 'Profile Pack envelope')
  if (envelope.schema !== PROFILE_PACK_ENVELOPE_SCHEMA) throw new Error('unsupported Profile Pack envelope schema')
  parseProfilePack(envelope.pack)
  validatePackProvenance(envelope.provenance)
  const signature = object(envelope.signature, 'signature')
  exactKeys(signature, ['algorithm', 'keyId', 'value'], 'signature')
  if (signature.algorithm !== 'Ed25519') throw new Error('Profile Pack signature algorithm must be Ed25519')
  string(signature.keyId, 'signature.keyId', KEY_ID_RE)
  string(signature.value, 'signature.value', /^[A-Za-z0-9+/]+={0,2}$/)
  return envelope
}

export function signProfilePack(packValue, options = {}) {
  const pack = parseProfilePack(structuredClone(packValue))
  string(options.keyId, 'signing key ID', KEY_ID_RE)
  string(options.publisher, 'publisher', PUBLISHER_RE)
  const provenance = validatePackProvenance({
    publisher: options.publisher,
    source: options.source ?? null,
    issuedAt: (options.issuedAt ?? new Date()).toISOString(),
  })
  const key = options.privateKey?.type === 'private' ? options.privateKey : createPrivateKey(options.privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Profile Pack signing key must be Ed25519')
  const envelope = {
    schema: PROFILE_PACK_ENVELOPE_SCHEMA,
    pack,
    provenance,
    signature: { algorithm: 'Ed25519', keyId: options.keyId, value: '' },
  }
  envelope.signature.value = sign(null, Buffer.from(canonicalJson(envelopePayload(envelope))), key).toString('base64')
  return parseProfilePackEnvelope(envelope)
}

export function verifyProfilePackEnvelope(value, publicKey) {
  const envelope = parseProfilePackEnvelope(value)
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Profile Pack trusted key must be Ed25519')
  const valid = verify(
    null,
    Buffer.from(canonicalJson(envelopePayload(envelope))),
    key,
    Buffer.from(envelope.signature.value, 'base64'),
  )
  if (!valid) throw new Error('Profile Pack publisher signature is invalid')
  return envelope
}

function parsePackArtifact(value, options = {}) {
  if (value?.schema === PROFILE_PACK_ENVELOPE_SCHEMA) {
    const envelope = parseProfilePackEnvelope(value)
    if (options.publicKey !== undefined) verifyProfilePackEnvelope(envelope, options.publicKey)
    return {
      pack: envelope.pack,
      signature: {
        state: options.publicKey === undefined ? 'signed-unverified' : 'verified',
        keyId: envelope.signature.keyId,
        publisher: envelope.provenance.publisher,
        source: envelope.provenance.source,
        issuedAt: envelope.provenance.issuedAt,
      },
    }
  }
  if (options.requireSignature === true) throw new Error('Profile Pack publisher signature is required')
  return { pack: parseProfilePack(value), signature: { state: 'unsigned' } }
}

function defaultVersion(now) {
  return `0.0.0-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`
}

function runtimeRecord(observation) {
  if (observation?.state !== 'observed') throw new Error('cannot bind Profile Pack to an unknown DSH runtime')
  return {
    package: '@deepseek-ai/dsh',
    version: observation.command.version,
    integrity: observation.artifact?.integrity ?? null,
    binding: observation.binding,
  }
}

function registryRecord(selected) {
  return {
    schema: selected.document.schema,
    snapshotId: selected.document.snapshotId,
    revision: selected.document.revision,
    origins: [...selected.document.origins],
  }
}

function releaseRecords(document) {
  return document.entries.flatMap(entry => (entry.releases ?? []).map(release => ({ entry, release })))
}

async function resolveInstalledPlugin(registry, records, predicate, enabled) {
  for (const record of records) {
    if (!predicate(record.release.install)) continue
    try {
      const action = await registry.resolveAction(record.entry.id, record.release.id)
      if (action.releaseId !== record.release.id) continue
      return {
        projectId: record.entry.id,
        releaseId: record.release.id,
        enabled,
        license: registryLicense(record.entry, record.release),
      }
    } catch {
      continue
    }
  }
  return null
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readPresetFiles(root, relative = '', output = []) {
  const directory = relative === '' ? root : join(root, ...relative.split('/'))
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`
    assertPresetPath(path)
    const filename = join(root, ...path.split('/'))
    const info = await lstat(filename)
    if (info.isSymbolicLink()) throw new Error(`Agent Preset contains a symlink: ${path}`)
    if (info.isDirectory()) {
      await readPresetFiles(root, path, output)
      continue
    }
    if (!info.isFile()) throw new Error(`Agent Preset contains a non-regular file: ${path}`)
    if (info.size > PRESET_FILE_LIMIT) throw new Error(`Agent Preset file is too large: ${path}`)
    const bytes = await readFile(filename)
    let content
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error(`Agent Preset file is not UTF-8 text: ${path}`) }
    assertSafePresetContent(content, path)
    output.push({ path, sha256: sha256(content), content })
    if (output.length > PRESET_FILE_COUNT_LIMIT) throw new Error('Agent Preset contains too many files')
  }
  return output
}

async function agentPresetRecord(home, id) {
  string(id, 'Agent Preset ID', ID_RE)
  if (BUILTIN_AGENT_PRESETS.includes(id)) return { mode: 'builtin', id, sha256: null, files: [] }
  const root = join(agentPresetsDirectory(home), id)
  const info = await lstat(root).catch(() => null)
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`custom Agent Preset does not exist: ${id}`)
  }
  const files = await readPresetFiles(root)
  files.sort((left, right) => left.path.localeCompare(right.path))
  if (!files.some(file => file.path === 'agent.cordis.yml')) {
    throw new Error(`custom Agent Preset ${JSON.stringify(id)} has no agent.cordis.yml`)
  }
  const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)
  if (total > PRESET_TOTAL_LIMIT) throw new Error('Agent Preset is too large')
  return { mode: 'embedded', id, sha256: sha256(canonicalJson(files)), files }
}

function finalizePack(value) {
  const pack = { ...value, digest: 'sha256:'.padEnd(71, '0') }
  pack.digest = profilePackDigest(pack)
  return parseProfilePack(pack)
}

async function writePack(pack, output) {
  if (output !== undefined) {
    if (await pathExists(output)) throw new Error(`output already exists: ${output}`)
    await atomicWriteJson(output, pack, 0o600)
  }
  return pack
}

function parseDistributionSource(value) {
  const source = object(value, 'distribution')
  if (!['omdsh-distribution/v1', 'omdsh-pack-source/v1'].includes(source.schema)) throw new Error('unsupported distribution schema')
  string(source.id, 'distribution.id', ID_RE)
  string(source.version, 'distribution.version', SEMVER_RE)
  if (!Array.isArray(source.items)) throw new Error('distribution.items must be an array')
  if (source.items.length === 0) throw new Error('distribution.items must contain at least one Release')
  const items = []
  const sourcePlugins = []
  source.items.forEach((value, index) => {
    const item = object(value, `distribution.items[${index}]`)
    if (item.type === 'source') {
      if (!['package-manifest', 'author-declared'].includes(item.license?.source)) {
        throw new Error(`distribution.items[${index}].license.source is invalid`)
      }
      const plugin = {
        id: string(item.id, `distribution.items[${index}].id`, ID_RE),
        packageName: string(item.packageName, `distribution.items[${index}].packageName`, PACKAGE_NAME_RE),
        version: string(item.version, `distribution.items[${index}].version`, SEMVER_RE),
        enabled: item.enabled,
        license: licenseFacts(
          assertLicenseExpression(item.license?.expression, `distribution.items[${index}].license.expression`),
          item.license?.source,
        ),
        source: structuredClone(item.source),
        install: structuredClone(item.install),
        trust: 'author-fixed-source',
      }
      if (typeof plugin.enabled !== 'boolean') throw new Error(`distribution.items[${index}].enabled must be boolean`)
      validateSourcePlugin(plugin, sourcePlugins.length)
      sourcePlugins.push(plugin)
      return
    }
    string(item.projectId, `distribution.items[${index}].projectId`)
    string(item.releaseId, `distribution.items[${index}].releaseId`)
    if (typeof item.enabled !== 'boolean') throw new Error(`distribution.items[${index}].enabled must be boolean`)
    items.push({ projectId: item.projectId, releaseId: item.releaseId, enabled: item.enabled })
  })
  const componentIds = [...items.map(item => item.projectId), ...sourcePlugins.map(item => item.id)]
  if (new Set(componentIds).size !== componentIds.length) throw new Error('distribution contains duplicate components')
  const presetId = source.agentPreset?.id ?? 'standard'
  if (source.agentPreset !== undefined
    && (source.agentPreset?.mode !== 'builtin' || !BUILTIN_AGENT_PRESETS.includes(presetId))) {
    throw new Error('distribution can reference only a built-in Agent Preset')
  }
  return { id: source.id, version: source.version, items, sourcePlugins, presetId }
}

async function readJsonFile(filename, label, limit = PACK_LIMIT) {
  const info = await lstat(filename)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`)
  if (info.size > limit) throw new Error(`${label} is too large`)
  try { return JSON.parse(await readFile(filename, 'utf8')) } catch (cause) { throw new Error(`${label} is not valid JSON`, { cause }) }
}

async function readPackArtifact(source, options = {}) {
  const value = typeof source === 'string' ? await readJsonFile(source, 'Profile Pack') : source
  return parsePackArtifact(value, options)
}

function packComparable(value) {
  if (value?.schema === PROFILE_PACK_ENVELOPE_SCHEMA || value?.schema === PROFILE_PACK_SCHEMA) {
    const artifact = parsePackArtifact(value)
    return {
      pack: { id: artifact.pack.id, version: artifact.pack.version, digest: artifact.pack.digest },
      registrySnapshotId: artifact.pack.registry.snapshotId,
      runtimeVersion: artifact.pack.runtime.version,
      plugins: artifact.pack.plugins,
      sourcePlugins: artifact.pack.sourcePlugins,
      agentPreset: {
        id: artifact.pack.agentPreset.id,
        mode: artifact.pack.agentPreset.mode,
        sha256: artifact.pack.agentPreset.sha256,
      },
    }
  }
  if (value?.pack !== undefined && Array.isArray(value.plugins)) return { sourcePlugins: [], ...value }
  throw new Error('unsupported Profile Pack comparison source')
}

export function diffProfilePacks(leftValue, rightValue) {
  const left = packComparable(leftValue)
  const right = packComparable(rightValue)
  const leftPlugins = new Map(left.plugins.map(plugin => [plugin.projectId, plugin]))
  const rightPlugins = new Map(right.plugins.map(plugin => [plugin.projectId, plugin]))
  const added = [...rightPlugins.values()].filter(plugin => !leftPlugins.has(plugin.projectId))
    .sort((a, b) => a.projectId.localeCompare(b.projectId))
  const removed = [...leftPlugins.values()].filter(plugin => !rightPlugins.has(plugin.projectId))
    .sort((a, b) => a.projectId.localeCompare(b.projectId))
  const changed = [...rightPlugins.values()].filter((plugin) => {
    const before = leftPlugins.get(plugin.projectId)
    return before !== undefined && (before.releaseId !== plugin.releaseId || before.enabled !== plugin.enabled)
  }).map(plugin => ({ projectId: plugin.projectId, from: leftPlugins.get(plugin.projectId), to: plugin }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId))
  const leftSources = new Map((left.sourcePlugins || []).map(plugin => [plugin.id, plugin]))
  const rightSources = new Map((right.sourcePlugins || []).map(plugin => [plugin.id, plugin]))
  const sourceAdded = [...rightSources.values()].filter(plugin => !leftSources.has(plugin.id)).sort((a, b) => a.id.localeCompare(b.id))
  const sourceRemoved = [...leftSources.values()].filter(plugin => !rightSources.has(plugin.id)).sort((a, b) => a.id.localeCompare(b.id))
  const sourceChanged = [...rightSources.values()].filter(plugin => leftSources.has(plugin.id)
    && canonicalJson(leftSources.get(plugin.id)) !== canonicalJson(plugin))
    .map(plugin => ({ id: plugin.id, from: leftSources.get(plugin.id), to: plugin })).sort((a, b) => a.id.localeCompare(b.id))
  const presetChanged = canonicalJson(left.agentPreset) !== canonicalJson(right.agentPreset)
  return {
    schema: 'omdsh-profile-pack-diff/v1',
    from: left.pack,
    to: right.pack,
    changes: {
      added,
      removed,
      changed,
      fixedSource: { added: sourceAdded, removed: sourceRemoved, changed: sourceChanged },
      agentPreset: presetChanged ? { from: left.agentPreset, to: right.agentPreset } : null,
      registrySnapshot: left.registrySnapshotId === right.registrySnapshotId
        ? null
        : { from: left.registrySnapshotId, to: right.registrySnapshotId },
      runtime: left.runtimeVersion === right.runtimeVersion
        ? null
        : { from: left.runtimeVersion, to: right.runtimeVersion },
    },
    hasChanges: added.length > 0 || removed.length > 0 || changed.length > 0
      || sourceAdded.length > 0 || sourceRemoved.length > 0 || sourceChanged.length > 0 || presetChanged
      || left.registrySnapshotId !== right.registrySnapshotId || left.runtimeVersion !== right.runtimeVersion,
  }
}

function instanceSnapshot(pack, artifact, generation, rollbackGeneration, appliedAt) {
  return {
    pack: { id: pack.id, version: pack.version, digest: pack.digest },
    registrySnapshotId: pack.registry.snapshotId,
    runtimeVersion: pack.runtime.version,
    plugins: structuredClone(pack.plugins),
    sourcePlugins: structuredClone(pack.sourcePlugins),
    agentPreset: { id: pack.agentPreset.id, mode: pack.agentPreset.mode, sha256: pack.agentPreset.sha256 },
    publisher: artifact.signature.state === 'verified' ? structuredClone(artifact.signature) : null,
    generation,
    rollbackGeneration,
    appliedAt,
  }
}

async function installEmbeddedPreset(home, preset, options = {}) {
  const root = agentPresetsDirectory(home)
  const target = join(root, preset.id)
  const exists = await pathExists(target)
  if (exists && options.replace !== true) throw new Error(`Agent Preset already exists: ${preset.id}; use --replace-preset`)
  await mkdir(root, { recursive: true })
  const temporary = join(root, `.omdsh-pack-${preset.id}-${process.pid}-${randomBytes(5).toString('hex')}`)
  const backup = join(root, `.omdsh-pack-backup-${preset.id}-${process.pid}-${randomBytes(5).toString('hex')}`)
  await mkdir(temporary, { recursive: false })
  try {
    for (const file of preset.files) {
      const filename = join(temporary, ...file.path.split('/'))
      await mkdir(dirname(filename), { recursive: true })
      await writeFile(filename, file.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    }
    if (!exists) {
      await rename(temporary, target)
      return
    }
    await rename(target, backup)
    try {
      await rename(temporary, target)
    } catch (cause) {
      await rename(backup, target).catch(() => {})
      throw cause
    }
    await rm(backup, { recursive: true, force: true }).catch(() => {})
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {})
  }
}

async function installedPresetDigest(home, preset) {
  const root = join(agentPresetsDirectory(home), preset.id)
  if (!await pathExists(root)) return null
  try {
    const files = await readPresetFiles(root)
    files.sort((left, right) => left.path.localeCompare(right.path))
    return sha256(canonicalJson(files))
  } catch {
    return 'unreadable'
  }
}

export class ProfilePackManager {
  constructor(options = {}) {
    if (options.manager === undefined) throw new Error('ProfilePackManager requires ExtensionManager')
    this.manager = options.manager
    this.registry = options.registry ?? options.manager.registry
    if (this.registry === undefined) throw new Error('ProfilePackManager requires RegistryClient')
  }

  async instance(name) {
    const id = assertProfileName(name)
    let record = await readPackInstance(this.manager.home, id)
    if (record === null) {
      return { schema: 'omdsh-pack-instance-status/v1', name: id, state: 'absent', instance: null, profileStatus: null }
    }
    const profileStatus = await this.manager.status(record.profile)
    if (record.pending !== null) {
      if (profileStatus.current === record.pending.generation && profileStatus.bootAttempt === null) {
        record = await writePackInstance(this.manager.home, id, current => ({
          ...current,
          previous: current.current,
          current: current.pending,
          pending: null,
        }))
      } else if (profileStatus.failed.includes(record.pending.generation)) {
        record = await writePackInstance(this.manager.home, id, current => ({ ...current, pending: null }))
      }
    }
    const refreshed = await this.manager.status(record.profile)
    const state = record.pending !== null
      ? refreshed.pending === record.pending.generation
        ? 'candidate-ready'
        : refreshed.current === record.pending.generation
          ? 'booting'
          : 'detached'
      : record.current === null ? 'empty' : refreshed.current === record.current.generation ? 'current' : 'detached'
    return { schema: 'omdsh-pack-instance-status/v1', name: id, state, instance: record, profileStatus: refreshed }
  }

  async diff(left, right, options = {}) {
    if (options.instance !== undefined) {
      if (right !== undefined) throw new Error('instance diff accepts one target Profile Pack')
      const current = await this.instance(options.instance)
      if (current.instance?.current === null || current.instance === null) throw new Error(`pack instance has no current release: ${options.instance}`)
      const target = await readPackArtifact(left)
      return diffProfilePacks(current.instance.current, target.pack)
    }
    if (right === undefined) throw new Error('pack diff needs two Profile Packs or --instance')
    const [from, to] = await Promise.all([readPackArtifact(left), readPackArtifact(right)])
    return diffProfilePacks(from.pack, to.pack)
  }

  async update(source, options = {}) {
    if (options.instance === undefined) throw new Error('pack update requires --instance')
    const current = await this.instance(options.instance)
    if (current.instance?.current === null || current.instance === null) throw new Error(`pack instance has no current release: ${options.instance}`)
    if (current.instance.pending !== null) throw new Error(`pack instance ${options.instance} already has a pending release`)
    const target = await readPackArtifact(source, options)
    if (target.signature.state === 'signed-unverified') {
      throw new Error(`signed Profile Pack requires the trusted public key for ${target.signature.keyId}`)
    }
    if (target.pack.id !== current.instance.current.pack.id) {
      throw new Error(`pack update cannot change distribution identity from ${current.instance.current.pack.id} to ${target.pack.id}`)
    }
    if (target.pack.digest === current.instance.current.pack.digest) throw new Error('pack instance already uses this exact release')
    return this.apply(source, options)
  }

  async rollback(name) {
    const id = assertProfileName(name)
    const status = await this.instance(id)
    const record = status.instance
    if (record === null) throw new Error(`pack instance does not exist: ${id}`)
    if (record.pending !== null) {
      await this.manager.discard(record.profile, `Pack instance ${id} rollback`)
      await writePackInstance(this.manager.home, id, current => ({ ...current, pending: null }))
      return { schema: 'omdsh-pack-instance-rollback/v1', instance: id, state: 'candidate-discarded', profile: record.profile }
    }
    if (record.current === null) throw new Error(`pack instance has no current release: ${id}`)
    const from = record.current
    if (from.generation !== from.rollbackGeneration) {
      await this.manager.recover(record.profile, { to: from.rollbackGeneration, reason: `Pack instance ${id} rollback` })
    }
    const updated = await writePackInstance(this.manager.home, id, current => ({
      ...current,
      current: current.previous,
      previous: null,
      pending: null,
    }))
    return {
      schema: 'omdsh-pack-instance-rollback/v1',
      instance: id,
      state: updated.current === null ? 'removed' : 'rolled-back',
      profile: record.profile,
      from: from.pack,
      to: updated.current?.pack ?? null,
      generation: from.rollbackGeneration,
      externalSideEffects: 'not-covered',
      agentPresetRollback: 'not-performed',
    }
  }

  async exportProfile(options = {}) {
    const profile = assertProfileName(options.profile ?? 'web')
    const now = options.now ?? new Date()
    const [selectedProfile, current, repositories, selectedRegistry, officialPackage, preset] = await Promise.all([
      this.manager.resolve(profile),
      this.manager.inspect(profile),
      this.manager.resolve(profile).then(selected => readRepositorySpecs(this.manager.home, selected)),
      this.registry.current(),
      this.manager.officialPackage(),
      agentPresetRecord(this.manager.home, options.preset ?? 'standard'),
    ])
    const records = releaseRecords(selectedRegistry.document)
    const plugins = []
    const omitted = []
    for (const [packageName, spec] of Object.entries(current.installed)) {
      const matched = await resolveInstalledPlugin(
        this.registry,
        records,
        install => install.mode === 'profile-bundle' && install.packageName === packageName && install.spec === spec,
        current.enabled.includes(packageName),
      )
      if (matched !== null) plugins.push(matched)
      else if (!OFFICIAL_PROFILE_PACKAGES.has(packageName)) {
        omitted.push({ identity: `npm:${packageName}@${spec}`, reason: 'no-installable-registry-release' })
      }
    }
    for (const packageName of current.enabled) {
      if (current.installed[packageName] === undefined && !OFFICIAL_PROFILE_PACKAGES.has(packageName)) {
        omitted.push({ identity: `bundle:${packageName}`, reason: 'enabled-bundle-missing-dependency' })
      }
    }
    for (const spec of repositories) {
      const matched = await resolveInstalledPlugin(
        this.registry,
        records,
        install => install.mode === 'repository-plugin' && install.spec === spec,
        true,
      )
      if (matched !== null) plugins.push(matched)
      else omitted.push({ identity: `repository:${repositorySpecIdentity(spec)}`, reason: 'no-installable-registry-release' })
    }
    if (new Set(plugins.map(plugin => plugin.projectId)).size !== plugins.length) {
      throw new Error('Profile resolves multiple installed components to one Registry project')
    }
    plugins.sort((left, right) => left.projectId.localeCompare(right.projectId))
    omitted.sort((left, right) => left.identity.localeCompare(right.identity))
    if (omitted.length > 0 && options.allowOmitted !== true) {
      throw new Error(`Profile contains ${omitted.length} unexportable component(s); use --allow-omitted after reviewing them`)
    }
    const id = options.id ?? `${profile}-profile`
    const version = options.version ?? defaultVersion(now)
    const pack = finalizePack({
      schema: PROFILE_PACK_SCHEMA,
      id,
      version,
      createdAt: now.toISOString(),
      runtime: runtimeRecord(officialPackage),
      registry: registryRecord(selectedRegistry),
      profile: { logicalName: profile, sourceGeneration: selectedProfile },
      distribution: null,
      plugins,
      sourcePlugins: [],
      agentPreset: preset,
      omitted,
      policy: { ...POLICY },
    })
    return writePack(pack, options.output)
  }

  async buildDistribution(source, options = {}) {
    const value = typeof source === 'string' ? await readJsonFile(source, 'distribution manifest') : source
    const distribution = parseDistributionSource(value)
    const [selectedRegistry, officialPackage] = await Promise.all([
      this.registry.current(),
      this.manager.officialPackage(),
    ])
    const plugins = []
    for (const item of distribution.items) {
      const action = await this.registry.resolveAction(item.projectId, item.releaseId)
      if (action.releaseId !== item.releaseId || !['profile-bundle', 'repository-plugin'].includes(action.install.mode)) {
        throw new Error(`distribution item is not a managed fixed Registry Release: ${item.projectId}`)
      }
      if (action.install.mode === 'repository-plugin' && item.enabled !== true) {
        throw new Error(`Repository Plugin ${JSON.stringify(item.projectId)} cannot be disabled independently`)
      }
      const entry = selectedRegistry.document.entries.find(candidate => candidate.id === item.projectId)
      const release = entry?.releases?.find(candidate => candidate.id === item.releaseId)
      plugins.push({ ...item, license: registryLicense(entry, release) })
    }
    plugins.sort((left, right) => left.projectId.localeCompare(right.projectId))
    const sourcePlugins = distribution.sourcePlugins.sort((left, right) => left.id.localeCompare(right.id))
    const pack = finalizePack({
      schema: PROFILE_PACK_SCHEMA,
      id: distribution.id,
      version: distribution.version,
      createdAt: (options.now ?? new Date()).toISOString(),
      runtime: runtimeRecord(officialPackage),
      registry: registryRecord(selectedRegistry),
      profile: { logicalName: null, sourceGeneration: null },
      distribution: { id: distribution.id, version: distribution.version },
      plugins,
      sourcePlugins,
      agentPreset: { mode: 'builtin', id: distribution.presetId, sha256: null, files: [] },
      omitted: [],
      policy: { ...POLICY },
    })
    return writePack(pack, options.output)
  }

  async sign(source, options = {}) {
    if (options.output === undefined) throw new Error('signed Profile Pack output is required')
    const value = typeof source === 'string' ? await readJsonFile(source, 'Profile Pack') : source
    if (value?.schema === PROFILE_PACK_ENVELOPE_SCHEMA) throw new Error('Profile Pack is already signed')
    const envelope = signProfilePack(value, options)
    return writePack(envelope, options.output)
  }

  async inspect(source, options = {}) {
    const value = typeof source === 'string' ? await readJsonFile(source, 'Profile Pack') : source
    const artifact = parsePackArtifact(value, options)
    const pack = artifact.pack
    return {
      schema: 'omdsh-profile-pack-inspection/v1',
      valid: true,
      id: pack.id,
      version: pack.version,
      digest: pack.digest,
      runtime: pack.runtime,
      registry: pack.registry,
      source: pack.distribution ?? pack.profile,
      plugins: pack.plugins.length,
      fixedSourcePlugins: pack.sourcePlugins.length,
      licenses: [
        ...pack.plugins.map(plugin => ({ componentId: plugin.projectId, componentType: 'registry', ...plugin.license })),
        ...pack.sourcePlugins.map(plugin => ({
          componentId: plugin.id,
          componentType: 'fixed-source',
          packageName: plugin.packageName,
          version: plugin.version,
          ...plugin.license,
        })),
      ],
      trust: {
        level: pack.sourcePlugins.length === 0 ? 'registry-bound' : 'experimental-fixed-source',
        publicAdmissionEligible: pack.sourcePlugins.length === 0,
      },
      agentPreset: { mode: pack.agentPreset.mode, id: pack.agentPreset.id, files: pack.agentPreset.files.length },
      omitted: pack.omitted,
      signature: artifact.signature,
      warnings: [
        ...(pack.runtime.integrity === null ? ['DSH npm integrity was not locally bound when the pack was created'] : []),
        ...(pack.omitted.length > 0 ? ['The source Profile contained components that were not exported'] : []),
        ...(pack.agentPreset.mode === 'embedded' ? ['Embedded Agent Preset content requires explicit trust on apply'] : []),
        ...(pack.sourcePlugins.length > 0 ? ['Fixed-source plugins require --trust-source and are not Registry-admitted'] : []),
        ...([...pack.plugins, ...pack.sourcePlugins].some(plugin => plugin.license.review === 'required')
          ? ['One or more component licenses require manual review'] : []),
        ...(artifact.signature.state === 'unsigned' ? ['Pack has no publisher signature'] : []),
        ...(artifact.signature.state === 'signed-unverified' ? ['Pack is signed but no trusted public key was supplied'] : []),
      ],
    }
  }

  async plan(source, options = {}) {
    const artifact = await readPackArtifact(source, options)
    const pack = artifact.pack
    const profile = assertProfileName(options.profile ?? pack.profile.logicalName ?? 'web')
    const instanceName = options.instance === undefined ? null : assertProfileName(options.instance)
    const blockers = []
    const warnings = []

    const [selectedRegistry, officialPackage, profileStatus, tracked, presetDigest] = await Promise.all([
      this.registry.current(),
      this.manager.officialPackage(),
      this.manager.status(profile),
      instanceName === null ? null : readPackInstance(this.manager.home, instanceName),
      pack.agentPreset.mode === 'embedded' ? installedPresetDigest(this.manager.home, pack.agentPreset) : null,
    ])

    if (artifact.signature.state === 'signed-unverified') {
      blockers.push(`signed Profile Pack needs a trusted public key for ${artifact.signature.keyId}`)
    }
    if (artifact.signature.state === 'unsigned') warnings.push('Pack has no publisher signature')
    if (profileStatus.pending !== null) {
      blockers.push(`profile ${profile} already has pending generation ${profileStatus.pending}`)
    }
    if (tracked?.profile !== undefined && tracked.profile !== profile) {
      blockers.push(`pack instance ${instanceName} belongs to Profile ${tracked.profile}`)
    }
    if (tracked?.pending !== undefined && tracked.pending !== null) {
      blockers.push(`pack instance ${instanceName} already has pending release ${tracked.pending.pack.id}@${tracked.pending.pack.version}`)
    }

    const registryMatches = selectedRegistry.document.snapshotId === pack.registry.snapshotId
      && selectedRegistry.document.revision === pack.registry.revision
      && canonicalJson(selectedRegistry.document.origins) === canonicalJson(pack.registry.origins)
    if (!registryMatches) blockers.push('installed Registry snapshot does not match the Profile Pack')

    let currentRuntime = null
    try { currentRuntime = runtimeRecord(officialPackage) } catch {
      blockers.push('DSH runtime cannot be bound to an exact installed version')
    }
    const runtimeMatches = currentRuntime !== null
      && currentRuntime.version === pack.runtime.version
      && (pack.runtime.integrity === null || currentRuntime.integrity === pack.runtime.integrity)
    if (currentRuntime !== null && !runtimeMatches) {
      blockers.push(`DSH runtime does not match ${pack.runtime.package}@${pack.runtime.version}`)
    }

    const releases = []
    for (const plugin of pack.plugins) {
      try {
        const action = await this.registry.resolveAction(plugin.projectId, plugin.releaseId)
        const installable = action.releaseId === plugin.releaseId
          && ['profile-bundle', 'repository-plugin'].includes(action.install.mode)
        if (!installable) blockers.push(`Profile Pack Release is no longer installable: ${plugin.projectId}`)
        releases.push({
          projectId: plugin.projectId,
          releaseId: plugin.releaseId,
          enabled: plugin.enabled,
          state: installable ? 'ready' : 'blocked',
          install: action.install,
          license: plugin.license,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        blockers.push(`Profile Pack Release is unavailable: ${plugin.projectId}: ${message}`)
        releases.push({
          projectId: plugin.projectId,
          releaseId: plugin.releaseId,
          enabled: plugin.enabled,
          state: 'blocked',
          error: message,
          license: plugin.license,
        })
      }
    }

    if (pack.sourcePlugins.length > 0 && options.trustSource !== true) {
      blockers.push('fixed-source plugins need explicit --trust-source')
    }
    if (pack.agentPreset.mode === 'embedded' && options.trustPreset !== true) {
      blockers.push('embedded Agent Preset needs explicit --trust-preset')
    }
    const presetConflict = pack.agentPreset.mode === 'embedded'
      && presetDigest !== null && presetDigest !== pack.agentPreset.sha256
    if (presetConflict && options.replacePreset !== true) {
      blockers.push(`Agent Preset ${pack.agentPreset.id} exists with different content; use --replace-preset`)
    }
    if ([...pack.plugins, ...pack.sourcePlugins].some(plugin => plugin.license.review === 'required')) {
      warnings.push('One or more component licenses require manual review')
    }

    return {
      schema: 'omdsh-profile-pack-plan/v1',
      readOnly: true,
      applicable: blockers.length === 0,
      pack: { id: pack.id, version: pack.version, digest: pack.digest },
      target: { profile, instance: instanceName, currentGeneration: profileStatus.current },
      signature: artifact.signature,
      checks: {
        profile: { state: profileStatus.pending === null ? 'ready' : 'blocked', pending: profileStatus.pending },
        registry: {
          state: registryMatches ? 'ready' : 'blocked',
          expected: { snapshotId: pack.registry.snapshotId, revision: pack.registry.revision, origins: pack.registry.origins },
          actual: {
            snapshotId: selectedRegistry.document.snapshotId,
            revision: selectedRegistry.document.revision,
            origins: selectedRegistry.document.origins,
          },
        },
        runtime: { state: runtimeMatches ? 'ready' : 'blocked', expected: pack.runtime, actual: currentRuntime },
        releases,
        fixedSource: pack.sourcePlugins.map(plugin => ({
          id: plugin.id,
          packageName: plugin.packageName,
          version: plugin.version,
          enabled: plugin.enabled,
          source: plugin.source,
          install: plugin.install,
          license: plugin.license,
          state: options.trustSource === true ? 'trusted-for-this-operation' : 'trust-required',
        })),
        agentPreset: {
          id: pack.agentPreset.id,
          mode: pack.agentPreset.mode,
          installedDigest: presetDigest,
          state: pack.agentPreset.mode === 'builtin'
            ? 'ready'
            : options.trustPreset !== true
              ? 'trust-required'
              : presetConflict && options.replacePreset !== true ? 'replace-required' : 'ready',
        },
      },
      blockers,
      warnings,
      next: blockers.length === 0
        ? [`omdsh pack apply <file.dshpack> --profile ${profile}${instanceName === null ? '' : ` --instance ${instanceName}`}`]
        : [],
    }
  }

  async apply(source, options = {}) {
    const artifact = await readPackArtifact(source, options)
    if (artifact.signature.state === 'signed-unverified') {
      throw new Error(`signed Profile Pack requires the trusted public key for ${artifact.signature.keyId}`)
    }
    const pack = artifact.pack
    const profile = assertProfileName(options.profile ?? pack.profile.logicalName ?? 'web')
    const instanceName = options.instance === undefined ? null : assertProfileName(options.instance)
    const tracked = instanceName === null ? null : await this.instance(instanceName)
    if (tracked?.instance?.profile !== undefined && tracked.instance.profile !== profile) {
      throw new Error(`pack instance ${instanceName} belongs to Profile ${tracked.instance.profile}`)
    }
    if (tracked?.instance?.pending !== undefined && tracked.instance.pending !== null) {
      throw new Error(`pack instance ${instanceName} already has pending release ${tracked.instance.pending.pack.id}@${tracked.instance.pending.pack.version}`)
    }
    const [selectedRegistry, officialPackage, before] = await Promise.all([
      this.registry.current(),
      this.manager.officialPackage(),
      this.manager.status(profile),
    ])
    if (before.pending !== null) throw new Error(`profile ${profile} already has pending generation ${before.pending}`)
    if (selectedRegistry.document.snapshotId !== pack.registry.snapshotId) {
      throw new Error(`Registry snapshot mismatch: pack needs ${pack.registry.snapshotId}`)
    }
    if (selectedRegistry.document.revision !== pack.registry.revision
      || canonicalJson(selectedRegistry.document.origins) !== canonicalJson(pack.registry.origins)) {
      throw new Error('Registry snapshot metadata does not match the Profile Pack')
    }
    const currentRuntime = runtimeRecord(officialPackage)
    if (currentRuntime.version !== pack.runtime.version) {
      throw new Error(`DSH runtime mismatch: pack needs ${pack.runtime.version}, found ${currentRuntime.version}`)
    }
    if (pack.runtime.integrity !== null && currentRuntime.integrity !== pack.runtime.integrity) {
      throw new Error('DSH runtime integrity does not match the Profile Pack')
    }
    for (const plugin of pack.plugins) {
      const action = await this.registry.resolveAction(plugin.projectId, plugin.releaseId)
      if (action.releaseId !== plugin.releaseId || !['profile-bundle', 'repository-plugin'].includes(action.install.mode)) {
        throw new Error(`Profile Pack Release is no longer installable: ${plugin.projectId}`)
      }
    }
    if (pack.sourcePlugins.length > 0 && options.trustSource !== true) {
      throw new Error('fixed-source plugins require --trust-source after reviewing source, licenses, and permissions')
    }
    let presetChanged = false
    if (pack.agentPreset.mode === 'embedded') {
      if (options.trustPreset !== true) throw new Error('embedded Agent Preset requires --trust-preset')
      const currentDigest = await installedPresetDigest(this.manager.home, pack.agentPreset)
      presetChanged = currentDigest !== pack.agentPreset.sha256
      if (currentDigest !== null && currentDigest !== pack.agentPreset.sha256 && options.replacePreset !== true) {
        throw new Error(`Agent Preset already exists with different content: ${pack.agentPreset.id}; use --replace-preset`)
      }
    }
    let status
    let candidateReady = false
    try {
      status = await this.manager.stageMarketRecipe(pack.plugins.map(plugin => ({
        id: plugin.projectId,
        releaseId: plugin.releaseId,
        enabled: plugin.enabled,
      })), {
        profile,
        recipeId: `${pack.id}@${pack.version}`,
        reconcileRegistryManaged: true,
        sourceItems: pack.sourcePlugins.map(plugin => ({
          id: plugin.id,
          releaseId: `${plugin.id}@${plugin.version}`,
          enabled: plugin.enabled,
          install: { ...plugin.install, packageName: plugin.packageName },
        })),
        reconcileSourceItems: tracked?.instance?.current?.sourcePlugins?.map(plugin => ({
          packageName: plugin.packageName,
          spec: plugin.install.spec,
        })) ?? [],
        allowNoChanges: true,
      })
      if (presetChanged) {
        await installEmbeddedPreset(this.manager.home, pack.agentPreset, { replace: options.replacePreset === true })
      }
      candidateReady = status.pending !== null && status.pending !== before.pending
      if (instanceName !== null) {
        const snapshot = instanceSnapshot(
          pack,
          artifact,
          candidateReady ? status.pending : before.current,
          before.current,
          (options.now ?? new Date()).toISOString(),
        )
        await writePackInstance(this.manager.home, instanceName, current => {
          const base = current ?? {
            schema: PACK_INSTANCE_SCHEMA,
            name: instanceName,
            profile,
            current: null,
            previous: null,
            pending: null,
            updatedAt: snapshot.appliedAt,
          }
          if (base.profile !== profile) throw new Error(`pack instance ${instanceName} belongs to Profile ${base.profile}`)
          return candidateReady
            ? { ...base, pending: snapshot }
            : { ...base, previous: base.current, current: snapshot, pending: null }
        })
      }
    } catch (error) {
      const current = await this.manager.status(profile).catch(() => null)
      if (current?.pending !== null && current?.pending !== before.pending) {
        await this.manager.discard(profile, 'Profile Pack apply failed').catch(() => {})
      }
      throw error
    }
    return {
      schema: 'omdsh-profile-pack-apply/v1',
      state: candidateReady ? 'candidate-ready' : presetChanged ? 'preset-installed' : 'already-applied',
      pack: { id: pack.id, version: pack.version, digest: pack.digest },
      signature: artifact.signature,
      profile,
      instance: instanceName,
      candidate: candidateReady ? status.pending : null,
      fixedSourcePlugins: pack.sourcePlugins.map(plugin => ({ id: plugin.id, packageName: plugin.packageName, license: plugin.license })),
      agentPreset: { id: pack.agentPreset.id, mode: pack.agentPreset.mode, installed: presetChanged },
      next: candidateReady
        ? [`omdsh activate --profile ${profile}`, `Create the agent with preset ${pack.agentPreset.id} after runtime confirmation`]
        : [`Create the agent with preset ${pack.agentPreset.id}`],
    }
  }
}
