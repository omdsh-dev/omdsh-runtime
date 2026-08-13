import { readFile } from 'node:fs/promises'
import { canonicalJson, REGISTRY_SCHEMA } from './registry.mjs'
import { resolveDshHome } from './paths.mjs'

export const AGENT_ECOSYSTEM_SCHEMA = 'omdsh-agent-ecosystem/v1'
export const AGENT_ECOSYSTEM_ORIGINS = Object.freeze([
  'https://hub.omdsh.dev/api/v1/ecosystem.json',
  'https://hub.0.org.cn/api/v1/ecosystem.json',
])

const BUNDLED_ECOSYSTEM = new URL('./agent-ecosystem-v1.json', import.meta.url)
const SNAPSHOT_RE = /^sha256:[0-9a-f]{64}$/
const COMMIT_RE = /^[0-9a-f]{40}$/
const FORBIDDEN_KEYS = new Set([
  'command', 'installCommand', 'shellCommand', 'packageName', 'spec', 'verifier',
  'githubId', 'memberLogin', 'accessToken', 'SESSION_SECRET',
])

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
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
  if (typeof value !== 'string' || value === '') throw new TypeError(`${name} must be a non-empty string`)
  if (options.pattern !== undefined && !options.pattern.test(value)) throw new TypeError(`${name} has an invalid format`)
  return value
}

function timestamp(value, name) {
  const text = string(value, name)
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw new TypeError(`${name} must be a normalized ISO timestamp`)
  return text
}

function httpsUrl(value, name) {
  const text = string(value, name)
  let parsed
  try { parsed = new URL(text) } catch { throw new TypeError(`${name} must be a URL`) }
  if (parsed.protocol !== 'https:') throw new TypeError(`${name} must use HTTPS`)
  return text
}

function assertNoExecutionData(value, name = 'Agent ecosystem feed') {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoExecutionData(item, `${name}[${index}]`))
  if (value === null || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new TypeError(`${name} contains forbidden field ${JSON.stringify(key)}`)
    assertNoExecutionData(item, `${name}.${key}`)
  }
}

function relation(value, name) {
  const item = object(value, name)
  exactKeys(item, ['projectId', 'releaseId'], name)
  string(item.projectId, `${name}.projectId`)
  string(item.releaseId, `${name}.releaseId`)
  return item
}

function release(value, name) {
  const item = object(value, name)
  exactKeys(item, ['id', 'version', 'channel', 'state', 'source', 'compatibility', 'relations', 'management', 'capabilities', 'listing'], name)
  string(item.id, `${name}.id`)
  if (item.version !== null) string(item.version, `${name}.version`)
  if (!['stable', 'beta', 'nightly'].includes(item.channel)) throw new TypeError(`${name}.channel is unsupported`)
  if (!['active', 'yanked', 'revoked'].includes(item.state)) throw new TypeError(`${name}.state is unsupported`)
  const source = object(item.source, `${name}.source`)
  exactKeys(source, ['repository', 'ref', 'path'], `${name}.source`)
  httpsUrl(source.repository, `${name}.source.repository`)
  string(source.ref, `${name}.source.ref`, { pattern: COMMIT_RE })
  if (source.path !== null) string(source.path, `${name}.source.path`)
  const compatibility = object(item.compatibility, `${name}.compatibility`)
  exactKeys(compatibility, ['declared', 'successfulRuns'], `${name}.compatibility`)
  if (compatibility.declared !== null) string(compatibility.declared, `${name}.compatibility.declared`)
  if (!Array.isArray(compatibility.successfulRuns)) throw new TypeError(`${name}.compatibility.successfulRuns must be an array`)
  compatibility.successfulRuns.forEach((value, index) => {
    const run = object(value, `${name}.compatibility.successfulRuns[${index}]`)
    exactKeys(run, ['environment', 'task', 'verifiedAt', 'evidenceUrl', 'independentlyReproduced'], `${name}.compatibility.successfulRuns[${index}]`)
    const environment = object(run.environment, `${name}.compatibility.successfulRuns[${index}].environment`)
    const environmentName = `${name}.compatibility.successfulRuns[${index}].environment`
    exactKeys(environment, ['harnessArtifact', 'profile', 'platform'], environmentName)
    const artifact = object(environment.harnessArtifact, `${environmentName}.harnessArtifact`)
    exactKeys(artifact, ['source', 'packageName', 'version', 'integrity'], `${environmentName}.harnessArtifact`)
    if (artifact.source !== 'npm') throw new TypeError(`${environmentName}.harnessArtifact.source must be npm`)
    if (artifact.packageName !== '@deepseek-ai/dsh') throw new TypeError(`${environmentName}.harnessArtifact.packageName must be @deepseek-ai/dsh`)
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(artifact.version)) throw new TypeError(`${environmentName}.harnessArtifact.version must be exact semver`)
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(artifact.integrity)) throw new TypeError(`${environmentName}.harnessArtifact.integrity must be sha512 SRI`)
    string(environment.profile, `${environmentName}.profile`)
    string(environment.platform, `${environmentName}.platform`)
    object(run.task, `${name}.compatibility.successfulRuns[${index}].task`)
    timestamp(run.verifiedAt, `${name}.compatibility.successfulRuns[${index}].verifiedAt`)
    httpsUrl(run.evidenceUrl, `${name}.compatibility.successfulRuns[${index}].evidenceUrl`)
    if (typeof run.independentlyReproduced !== 'boolean') throw new TypeError(`${name}.compatibility.successfulRuns[${index}].independentlyReproduced must be boolean`)
  })
  const relations = object(item.relations, `${name}.relations`)
  exactKeys(relations, ['state', 'required', 'optional'], `${name}.relations`)
  if (!['declared', 'not-declared'].includes(relations.state)) throw new TypeError(`${name}.relations.state is unsupported`)
  for (const kind of ['required', 'optional']) {
    if (!Array.isArray(relations[kind])) throw new TypeError(`${name}.relations.${kind} must be an array`)
    relations[kind].forEach((value, index) => relation(value, `${name}.relations.${kind}[${index}]`))
  }
  if (relations.state === 'not-declared' && (relations.required.length > 0 || relations.optional.length > 0)) throw new TypeError(`${name}.relations contradicts its state`)
  const management = object(item.management, `${name}.management`)
  exactKeys(management, ['mode', 'recoveryScope', 'externalEffects'], `${name}.management`)
  if (!['transactional', 'managed', 'guided'].includes(management.mode)) throw new TypeError(`${name}.management.mode is unsupported`)
  if (!['profile-generation', 'configuration-only', 'none'].includes(management.recoveryScope)) throw new TypeError(`${name}.management.recoveryScope is unsupported`)
  if (management.externalEffects !== 'not-covered') throw new TypeError(`${name}.management.externalEffects is unsupported`)
  object(item.capabilities, `${name}.capabilities`)
  const listing = object(item.listing, `${name}.listing`)
  exactKeys(listing, ['state'], `${name}.listing`)
  string(listing.state, `${name}.listing.state`)
  return item
}

function project(value, index) {
  const name = `projects[${index}]`
  const item = object(value, name)
  exactKeys(item, ['id', 'name', 'summary', 'summaryEvidence', 'kind', 'categories', 'tags', 'latestRelease', 'releases', 'links'], name)
  for (const key of ['id', 'name', 'summary', 'kind', 'latestRelease']) string(item[key], `${name}.${key}`)
  const evidence = object(item.summaryEvidence, `${name}.summaryEvidence`)
  exactKeys(evidence, ['state', 'trust'], `${name}.summaryEvidence`)
  if (!['declared', 'readme', 'missing'].includes(evidence.state) || evidence.trust !== 'untrusted-repository-text') throw new TypeError(`${name}.summaryEvidence is unsupported`)
  for (const key of ['categories', 'tags']) {
    if (!Array.isArray(item[key]) || item[key].some(value => typeof value !== 'string' || value === '')) throw new TypeError(`${name}.${key} is invalid`)
    if (new Set(item[key]).size !== item[key].length) throw new TypeError(`${name}.${key} contains duplicates`)
  }
  if (!Array.isArray(item.releases) || item.releases.length === 0) throw new TypeError(`${name}.releases must be a non-empty array`)
  item.releases.forEach((value, releaseIndex) => release(value, `${name}.releases[${releaseIndex}]`))
  if (!item.releases.some(candidate => candidate.id === item.latestRelease)) throw new TypeError(`${name}.latestRelease is missing`)
  object(item.links, `${name}.links`)
  return item
}

function composition(value, index) {
  const name = `compositions[${index}]`
  const item = object(value, name)
  exactKeys(item, ['id', 'kind', 'title', 'summary', 'translations', 'useCases', 'items', 'apply'], name)
  for (const key of ['id', 'title', 'summary']) string(item[key], `${name}.${key}`)
  if (!['collection', 'configuration', 'distribution'].includes(item.kind)) throw new TypeError(`${name}.kind is unsupported`)
  object(item.translations, `${name}.translations`)
  if (!Array.isArray(item.useCases)) throw new TypeError(`${name}.useCases must be an array`)
  item.useCases.forEach((value, useCaseIndex) => {
    const useCase = object(value, `${name}.useCases[${useCaseIndex}]`)
    exactKeys(useCase, ['id', 'title', 'translations'], `${name}.useCases[${useCaseIndex}]`)
    string(useCase.id, `${name}.useCases[${useCaseIndex}].id`)
    string(useCase.title, `${name}.useCases[${useCaseIndex}].title`)
    object(useCase.translations, `${name}.useCases[${useCaseIndex}].translations`)
  })
  if (!Array.isArray(item.items) || item.items.length === 0) throw new TypeError(`${name}.items must be a non-empty array`)
  item.items.forEach((value, itemIndex) => {
    const intent = object(value, `${name}.items[${itemIndex}]`)
    exactKeys(intent, ['projectId', 'releaseId', 'enabled'], `${name}.items[${itemIndex}]`)
    string(intent.projectId, `${name}.items[${itemIndex}].projectId`)
    string(intent.releaseId, `${name}.items[${itemIndex}].releaseId`)
    if (typeof intent.enabled !== 'boolean') throw new TypeError(`${name}.items[${itemIndex}].enabled must be boolean`)
  })
  const apply = object(item.apply, `${name}.apply`)
  const applyKeys = ['mode', 'recoveryScope', 'externalEffects']
  if (Object.hasOwn(apply, 'counts')) applyKeys.push('counts')
  exactKeys(apply, applyKeys, `${name}.apply`)
  if (!['single-candidate', 'guided', 'blocked'].includes(apply.mode)) throw new TypeError(`${name}.apply.mode is unsupported`)
  if (!['profile-generation', 'partial', 'none'].includes(apply.recoveryScope)) throw new TypeError(`${name}.apply.recoveryScope is unsupported`)
  if (apply.externalEffects !== 'not-covered') throw new TypeError(`${name}.apply.externalEffects is unsupported`)
  return item
}

export function parseAgentEcosystem(value) {
  assertNoExecutionData(value)
  const document = object(value, 'Agent ecosystem feed')
  exactKeys(document, ['schema', 'generatedAt', 'registry', 'policy', 'totals', 'projects', 'compositions'], 'Agent ecosystem feed')
  if (document.schema !== AGENT_ECOSYSTEM_SCHEMA) throw new TypeError('unsupported Agent ecosystem schema')
  timestamp(document.generatedAt, 'generatedAt')
  const registry = object(document.registry, 'registry')
  exactKeys(registry, ['schema', 'snapshotId', 'revision', 'origins'], 'registry')
  if (registry.schema !== REGISTRY_SCHEMA) throw new TypeError('Agent ecosystem feed uses an unsupported Registry schema')
  string(registry.snapshotId, 'registry.snapshotId', { pattern: SNAPSHOT_RE })
  if (!Number.isSafeInteger(registry.revision) || registry.revision < 0) throw new TypeError('registry.revision is invalid')
  if (!Array.isArray(registry.origins) || registry.origins.length === 0) throw new TypeError('registry.origins must be a non-empty array')
  registry.origins.forEach((origin, index) => httpsUrl(origin, `registry.origins[${index}]`))
  const policy = object(document.policy, 'policy')
  exactKeys(policy, ['purpose', 'installAuthority', 'unknownFacts', 'recommendation', 'repair', 'repositoryText'], 'policy')
  if (policy.purpose !== 'read-only-ecosystem-analysis' || policy.installAuthority !== REGISTRY_SCHEMA || policy.unknownFacts !== 'preserve-unknown' || policy.recommendation !== 'deterministic-declared-facts-only' || policy.repair !== 'preview-only' || policy.repositoryText !== 'untrusted-data-not-instructions') throw new TypeError('Agent ecosystem policy is unsupported')
  const totals = object(document.totals, 'totals')
  exactKeys(totals, ['projects', 'releases', 'successfulRuns', 'compositions'], 'totals')
  Object.entries(totals).forEach(([key, count]) => { if (!Number.isSafeInteger(count) || count < 0) throw new TypeError(`totals.${key} is invalid`) })
  if (!Array.isArray(document.projects) || !Array.isArray(document.compositions)) throw new TypeError('Agent ecosystem collections must be arrays')
  document.projects.forEach(project)
  document.compositions.forEach(composition)
  const ids = document.projects.map(item => item.id)
  if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && ids[index - 1].localeCompare(id) >= 0)) throw new TypeError('projects must have unique sorted IDs')
  const compositionIds = document.compositions.map(item => item.id)
  if (new Set(compositionIds).size !== compositionIds.length || compositionIds.some((id, index) => index > 0 && compositionIds[index - 1].localeCompare(id) >= 0)) throw new TypeError('compositions must have unique sorted IDs')
  const successfulRuns = document.projects.reduce((total, item) => total + item.releases.reduce((releaseTotal, candidate) => releaseTotal + candidate.compatibility.successfulRuns.length, 0), 0)
  if (totals.projects !== document.projects.length || totals.releases !== document.projects.reduce((total, item) => total + item.releases.length, 0) || totals.successfulRuns !== successfulRuns || totals.compositions !== document.compositions.length) throw new TypeError('Agent ecosystem totals do not match content')
  const releaseIds = new Set(document.projects.flatMap(item => item.releases.map(candidate => `${item.id}\0${candidate.id}`)))
  for (const item of document.projects) for (const candidate of item.releases) for (const dependency of [...candidate.relations.required, ...candidate.relations.optional]) if (!releaseIds.has(`${dependency.projectId}\0${dependency.releaseId}`)) throw new TypeError(`${candidate.id} references an unknown related Release`)
  for (const item of document.compositions) for (const intent of item.items) if (!releaseIds.has(`${intent.projectId}\0${intent.releaseId}`)) throw new TypeError(`${item.id} references an unknown Release`)
  return document
}

export function assertAgentEcosystemRegistry(document, registry) {
  if (document.registry.schema !== registry.schema || document.registry.snapshotId !== registry.snapshotId || document.registry.revision !== registry.revision || canonicalJson(document.registry.origins) !== canonicalJson(registry.origins)) throw new Error('Agent ecosystem feed does not match the selected Registry snapshot')
  return document
}

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ')
}

function selectedRelease(project, releaseId) {
  const id = releaseId ?? project.latestRelease
  const value = project.releases.find(item => item.id === id)
  if (value === undefined) throw new Error(`Release not found: ${JSON.stringify(id)}`)
  return value
}

function releaseIndex(document) {
  return new Map(document.projects.flatMap(project => project.releases.map(item => [`${project.id}\0${item.id}`, { project, release: item }])))
}

function available(release) {
  return release.state === 'active' && !['blocked', 'review-required'].includes(release.listing.state)
}

export function inspectEcosystemProject(document, id, releaseId) {
  const project = document.projects.find(item => item.id === id)
  if (project === undefined) throw new Error(`Project not found: ${JSON.stringify(id)}`)
  const selected = selectedRelease(project, releaseId)
  const { releases: _releases, ...summary } = project
  return Object.freeze({ schema: 'omdsh.agent-project/v1', registrySnapshotId: document.registry.snapshotId, project: summary, release: selected })
}

export function searchEcosystem(document, query, options = {}) {
  const text = normalize(query)
  if (text === '') throw new TypeError('query must be a non-empty string')
  const terms = text.split(' ')
  const limit = Math.min(Math.max(Number.isSafeInteger(options.limit) ? options.limit : 8, 1), 20)
  const matches = document.projects.flatMap(project => {
    const fields = [project.id, project.name, project.summary, project.kind, ...project.categories, ...project.tags].map(normalize)
    if (!terms.every(term => fields.some(field => field.includes(term)))) return []
    const id = normalize(project.id)
    const name = normalize(project.name)
    const score = id === text || name === text ? 0 : id.startsWith(text) || name.startsWith(text) ? 1 : 2
    return [{ id: project.id, name: project.name, summary: project.summary, kind: project.kind, latestRelease: project.latestRelease, score }]
  }).sort((left, right) => left.score - right.score || left.id.localeCompare(right.id)).slice(0, limit)
  return Object.freeze({ schema: 'omdsh.agent-search/v1', registrySnapshotId: document.registry.snapshotId, query, count: matches.length, projects: matches.map(({ score, ...item }) => item) })
}

export function ecosystemDependencies(document, id, releaseId) {
  const { release } = inspectEcosystemProject(document, id, releaseId)
  return Object.freeze({ schema: 'omdsh.agent-dependencies/v1', registrySnapshotId: document.registry.snapshotId, projectId: id, releaseId: release.id, state: release.relations.state, required: release.relations.required, optional: release.relations.optional })
}

export function ecosystemCompatibility(document, id, releaseId) {
  const { release } = inspectEcosystemProject(document, id, releaseId)
  const runs = release.compatibility.successfulRuns
  return Object.freeze({ schema: 'omdsh.agent-compatibility/v1', registrySnapshotId: document.registry.snapshotId, projectId: id, releaseId: release.id, declared: release.compatibility.declared, observed: runs.length === 0 ? 'unknown' : 'passed-in-recorded-environments', successfulRuns: runs, independentlyReproduced: runs.some(run => run.independentlyReproduced), recoveryScope: release.management.recoveryScope, externalEffects: release.management.externalEffects })
}

export function preflightComposition(document, compositionId) {
  const composition = document.compositions.find(item => item.id === compositionId)
  if (composition === undefined) throw new Error(`Composition not found: ${JSON.stringify(compositionId)}`)
  const releases = releaseIndex(document)
  const selected = new Set(composition.items.map(item => `${item.projectId}\0${item.releaseId}`))
  const issues = []
  const additions = new Map()
  let availableCount = 0
  let relationsDeclared = 0
  let successfulRuns = 0
  for (const item of composition.items) {
    const match = releases.get(`${item.projectId}\0${item.releaseId}`)
    if (match === undefined) {
      issues.push({ severity: 'blocked', kind: 'release-missing', projectId: item.projectId, releaseId: item.releaseId })
      continue
    }
    if (available(match.release)) availableCount += 1
    else issues.push({ severity: 'blocked', kind: 'release-unavailable', projectId: item.projectId, releaseId: item.releaseId })
    if (match.release.relations.state === 'declared') {
      relationsDeclared += 1
      for (const dependency of match.release.relations.required) {
        const key = `${dependency.projectId}\0${dependency.releaseId}`
        if (selected.has(key)) continue
        issues.push({ severity: 'blocked', kind: 'required-release-missing', projectId: item.projectId, releaseId: item.releaseId, dependency })
        if (available(releases.get(key)?.release)) additions.set(key, dependency)
      }
    } else issues.push({ severity: 'incomplete', kind: 'relations-not-declared', projectId: item.projectId, releaseId: item.releaseId })
    if (match.release.compatibility.successfulRuns.length > 0) successfulRuns += 1
    else issues.push({ severity: 'incomplete', kind: 'run-record-missing', projectId: item.projectId, releaseId: item.releaseId })
  }
  const edges = new Map(composition.items.map(item => [`${item.projectId}\0${item.releaseId}`, []]))
  for (const [key, targets] of edges) {
    const candidate = releases.get(key)?.release
    if (candidate?.relations.state !== 'declared') continue
    for (const dependency of candidate.relations.required) {
      const target = `${dependency.projectId}\0${dependency.releaseId}`
      if (selected.has(target)) targets.push(target)
    }
  }
  const visiting = new Set()
  const visited = new Set()
  const cycles = new Set()
  const visit = (key, path) => {
    if (visiting.has(key)) {
      const start = path.indexOf(key)
      cycles.add(path.slice(start).concat(key).join(' -> '))
      return
    }
    if (visited.has(key)) return
    visiting.add(key)
    for (const target of edges.get(key) ?? []) visit(target, [...path, key])
    visiting.delete(key)
    visited.add(key)
  }
  for (const key of edges.keys()) visit(key, [])
  if (cycles.size > 0) issues.push({ severity: 'blocked', kind: 'dependency-cycle', cycles: [...cycles] })
  const status = issues.some(issue => issue.severity === 'blocked') ? 'blocked' : issues.some(issue => issue.severity === 'incomplete') ? 'incomplete' : 'ready'
  return Object.freeze({
    schema: 'omdsh.agent-preflight/v1', registrySnapshotId: document.registry.snapshotId, compositionId, status,
    facts: { items: composition.items.length, available: availableCount, relationsDeclared, successfulRuns, recoveryScope: composition.apply.recoveryScope, externalEffects: composition.apply.externalEffects },
    issues,
    repairPreview: { executable: false, candidateRequired: true, requiresUserReview: true, additions: [...additions.values()] },
  })
}

export function recommendCompositions(document, task, options = {}) {
  const text = normalize(task)
  if (text === '') throw new TypeError('task must be a non-empty string')
  const terms = text.split(' ')
  const limit = Math.min(Math.max(Number.isSafeInteger(options.limit) ? options.limit : 5, 1), 10)
  const matches = document.compositions.flatMap(composition => {
    const uses = composition.useCases.map(item => ({ id: item.id, text: normalize([item.id, item.title, item.translations?.en].filter(Boolean).join(' ')) }))
    const matched = uses.filter(item => terms.every(term => item.text.includes(term)))
    if (matched.length === 0) return []
    return [{ id: composition.id, kind: composition.kind, title: composition.title, summary: composition.summary, useCases: matched.map(item => item.id), preflight: preflightComposition(document, composition.id) }]
  }).sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit)
  return Object.freeze({ schema: 'omdsh.agent-recommendations/v1', registrySnapshotId: document.registry.snapshotId, task, basis: 'declared-use-cases-only', count: matches.length, recommendations: matches, unknown: matches.length === 0 })
}

async function jsonFile(filename) {
  return JSON.parse(await readFile(filename, 'utf8'))
}

export class AgentEcosystemClient {
  constructor(options = {}) {
    if (options.registry === undefined) throw new Error('AgentEcosystemClient requires the existing Registry client')
    this.registry = options.registry
    this.home = resolveDshHome(options.home ?? options.registry.home)
    this.bundledFile = options.bundledFile ?? BUNDLED_ECOSYSTEM
    this.loaded = null
  }

  async current() {
    const selectedRegistry = await this.registry.current()
    if (this.loaded?.registrySnapshotId === selectedRegistry.document.snapshotId) return this.loaded
    const bundled = assertAgentEcosystemRegistry(parseAgentEcosystem(await jsonFile(this.bundledFile)), selectedRegistry.document)
    this.loaded = { document: bundled, source: 'bundled', warning: null, registrySnapshotId: selectedRegistry.document.snapshotId }
    return this.loaded
  }

  async sync() {
    throw new Error('Runtime Workshop snapshots are read-only; update them with workshop:vendor')
  }
}
