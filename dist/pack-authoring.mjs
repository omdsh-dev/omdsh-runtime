import { lstat, readFile } from 'node:fs/promises'
import { atomicWriteJson } from './atomic.mjs'
import { assertLicenseExpression } from './license.mjs'

export const PACK_SOURCE_SCHEMA = 'omdsh-pack-source/v1'
const ID_RE = /^[a-z0-9][a-z0-9-]*$/
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/
const PACKAGE_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/
const REPOSITORY_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/
const SHA_RE = /^[0-9a-f]{40}$/
const PRESETS = new Set(['code', 'cordis', 'minimal', 'standard'])

function required(value, name, pattern) {
  if (typeof value !== 'string' || value === '' || (pattern && !pattern.test(value))) throw new Error(`${name} is invalid`)
  return value
}

export function parsePackSource(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.schema !== PACK_SOURCE_SCHEMA) {
    throw new Error('unsupported Pack source')
  }
  required(value.id, 'Pack ID', ID_RE)
  required(value.version, 'Pack version', SEMVER_RE)
  if (value.agentPreset?.mode !== 'builtin' || !PRESETS.has(value.agentPreset.id)) throw new Error('Pack source preset is invalid')
  if (!Array.isArray(value.items)) throw new Error('Pack source items must be an array')
  const ids = []
  for (const [index, item] of value.items.entries()) {
    if (item?.type === 'source') {
      required(item.id, `items[${index}].id`, ID_RE)
      required(item.packageName, `items[${index}].packageName`, PACKAGE_RE)
      required(item.version, `items[${index}].version`, SEMVER_RE)
      assertLicenseExpression(item.license?.expression, `items[${index}].license.expression`)
      if (!['package-manifest', 'author-declared'].includes(item.license?.source)) throw new Error(`items[${index}].license.source is invalid`)
      const repository = REPOSITORY_RE.exec(required(item.source?.repository, `items[${index}].source.repository`))
      required(item.source?.ref, `items[${index}].source.ref`, SHA_RE)
      const expected = `github:${repository[1]}/${repository[2]}#${item.source.ref}`
      if (item.install?.mode !== 'profile-bundle' || item.install.spec !== expected) throw new Error(`items[${index}].install is not fixed to its source`)
      if (typeof item.enabled !== 'boolean') throw new Error(`items[${index}].enabled is invalid`)
      ids.push(item.id)
      continue
    }
    if (item?.type !== 'registry') throw new Error(`items[${index}].type is invalid`)
    required(item.projectId, `items[${index}].projectId`)
    required(item.releaseId, `items[${index}].releaseId`)
    if (!item.releaseId.startsWith(`${item.projectId}@`) || typeof item.enabled !== 'boolean') throw new Error(`items[${index}] is invalid`)
    ids.push(item.projectId)
  }
  if (new Set(ids).size !== ids.length) throw new Error('Pack source contains duplicate components')
  return value
}

export function createPackSource(options = {}) {
  const id = required(options.id, 'Pack ID', ID_RE)
  const preset = options.preset ?? 'standard'
  if (!PRESETS.has(preset)) throw new Error('Pack preset is invalid')
  return parsePackSource({
    schema: PACK_SOURCE_SCHEMA,
    id,
    version: options.version ?? '0.1.0-preview.1',
    agentPreset: { mode: 'builtin', id: preset },
    items: [],
  })
}

export function addRegistryItem(sourceValue, options = {}) {
  const source = structuredClone(parsePackSource(sourceValue))
  const projectId = required(options.projectId, 'Registry project ID')
  const releaseId = required(options.releaseId, 'Registry Release ID')
  if (!releaseId.startsWith(`${projectId}@`)) throw new Error('Registry Release does not belong to the project')
  if (source.items.some(item => (item.projectId ?? item.id) === projectId)) throw new Error(`Pack already contains ${projectId}`)
  source.items.push({ type: 'registry', projectId, releaseId, enabled: options.enabled !== false })
  return parsePackSource(source)
}

export function addFixedSourceItem(sourceValue, options = {}) {
  const source = structuredClone(parsePackSource(sourceValue))
  const id = required(options.id, 'component ID', ID_RE)
  const repository = required(options.repository, 'component repository')
  const parts = REPOSITORY_RE.exec(repository)
  if (!parts) throw new Error('component repository must be a GitHub HTTPS URL')
  const ref = required(options.ref, 'component commit', SHA_RE)
  if (source.items.some(item => (item.projectId ?? item.id) === id)) throw new Error(`Pack already contains ${id}`)
  source.items.push({
    type: 'source',
    id,
    packageName: required(options.packageName, 'component package name', PACKAGE_RE),
    version: required(options.version, 'component version', SEMVER_RE),
    enabled: options.enabled !== false,
    license: {
      expression: assertLicenseExpression(options.license, 'component license'),
      source: options.licenseSource ?? 'author-declared',
    },
    source: { repository: repository.replace(/\/$/, ''), ref },
    install: { mode: 'profile-bundle', spec: `github:${parts[1]}/${parts[2]}#${ref}` },
  })
  return parsePackSource(source)
}

export function removePackItem(sourceValue, id) {
  const source = structuredClone(parsePackSource(sourceValue))
  const next = source.items.filter(item => (item.projectId ?? item.id) !== id)
  if (next.length === source.items.length) throw new Error(`Pack does not contain ${id}`)
  source.items = next
  return parsePackSource(source)
}

export async function readPackSourceFile(filename) {
  const info = await lstat(filename)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new Error('Pack source must be a small regular file')
  try { return parsePackSource(JSON.parse(await readFile(filename, 'utf8'))) } catch (cause) { throw new Error('Pack source is not valid', { cause }) }
}

export async function writeNewPackSource(filename, value) {
  try { await lstat(filename); throw new Error(`output already exists: ${filename}`) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await atomicWriteJson(filename, parsePackSource(value), 0o600)
  return value
}

export async function updatePackSourceFile(filename, update) {
  const next = parsePackSource(await update(await readPackSourceFile(filename)))
  await atomicWriteJson(filename, next, 0o600)
  return next
}
