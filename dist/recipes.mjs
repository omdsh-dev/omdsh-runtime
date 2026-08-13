import { readFile } from 'node:fs/promises'
import { canonicalJson, REGISTRY_SCHEMA } from './registry.mjs'
import { resolveDshHome } from './paths.mjs'

export const RECIPES_SCHEMA = 'omdsh-workshop-recipes/v1'
export const RECIPE_ORIGINS = Object.freeze([
  'https://hub.omdsh.dev/recipes-v1.json',
  'https://hub.0.org.cn/recipes-v1.json',
])

const BUNDLED_RECIPES = new URL('./recipes-v1.json', import.meta.url)
const ID_RE = /^[a-z0-9][a-z0-9-]*$/
const SNAPSHOT_RE = /^sha256:[0-9a-f]{64}$/

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
  if (typeof value !== 'string' || value === '') throw new TypeError(`${name} must be a non-empty string`)
  if (options.pattern !== undefined && !options.pattern.test(value)) throw new TypeError(`${name} has an invalid format`)
  return value
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

function translations(value, name) {
  const item = object(value, name)
  exactKeys(item, ['en'], name)
  const english = object(item.en, `${name}.en`)
  exactKeys(english, ['title', 'summary'], `${name}.en`)
  string(english.title, `${name}.en.title`)
  string(english.summary, `${name}.en.summary`)
}

function taskIntents(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new TypeError(`${name} must contain between 1 and 5 items`)
  }
  const ids = new Set()
  value.forEach((candidate, index) => {
    const itemName = `${name}[${index}]`
    const item = object(candidate, itemName)
    exactKeys(item, ['id', 'title', 'translations'], itemName)
    string(item.id, `${itemName}.id`, { pattern: ID_RE })
    string(item.title, `${itemName}.title`)
    const localized = object(item.translations, `${itemName}.translations`)
    exactKeys(localized, ['en'], `${itemName}.translations`)
    string(localized.en, `${itemName}.translations.en`)
    if (ids.has(item.id)) throw new TypeError(`${name} contains duplicate task intents`)
    ids.add(item.id)
  })
}

function recipe(value, index) {
  const name = `recipes[${index}]`
  const item = object(value, name)
  const keys = [
    'id', 'kind', 'title', 'summary', 'translations', 'author', 'source',
    'compatibility', 'featured', 'items', 'apply',
  ]
  if (Object.hasOwn(item, 'useCases')) keys.push('useCases')
  exactKeys(item, keys, name)
  string(item.id, `${name}.id`, { pattern: ID_RE })
  if (!['configuration', 'distribution'].includes(item.kind)) throw new TypeError(`${name}.kind is unsupported`)
  string(item.title, `${name}.title`)
  string(item.summary, `${name}.summary`)
  translations(item.translations, `${name}.translations`)
  if (Object.hasOwn(item, 'useCases')) taskIntents(item.useCases, `${name}.useCases`)
  const author = object(item.author, `${name}.author`)
  exactKeys(author, ['name', 'url'], `${name}.author`)
  string(author.name, `${name}.author.name`)
  httpsUrl(author.url, `${name}.author.url`)
  const source = object(item.source, `${name}.source`)
  exactKeys(source, ['repository', 'ref'], `${name}.source`)
  httpsUrl(source.repository, `${name}.source.repository`)
  string(source.ref, `${name}.source.ref`, { pattern: /^[0-9a-f]{40}$/ })
  const compatibility = object(item.compatibility, `${name}.compatibility`)
  exactKeys(compatibility, ['harness', 'declared'], `${name}.compatibility`)
  string(compatibility.harness, `${name}.compatibility.harness`)
  string(compatibility.declared, `${name}.compatibility.declared`)
  if (typeof item.featured !== 'boolean') throw new TypeError(`${name}.featured must be boolean`)
  if (!Array.isArray(item.items) || item.items.length === 0) throw new TypeError(`${name}.items must be a non-empty array`)
  const projectIds = new Set()
  item.items.forEach((value, itemIndex) => {
    const itemName = `${name}.items[${itemIndex}]`
    const intent = object(value, itemName)
    exactKeys(intent, ['projectId', 'releaseId', 'enabled', 'management', 'availability'], itemName)
    string(intent.projectId, `${itemName}.projectId`)
    string(intent.releaseId, `${itemName}.releaseId`)
    if (typeof intent.enabled !== 'boolean') throw new TypeError(`${itemName}.enabled must be boolean`)
    if (!['transactional', 'managed', 'guided'].includes(intent.management)) throw new TypeError(`${itemName}.management is unsupported`)
    if (!['available', 'blocked'].includes(intent.availability)) throw new TypeError(`${itemName}.availability is unsupported`)
    if (projectIds.has(intent.projectId)) throw new TypeError(`${name}.items contains duplicate projects`)
    projectIds.add(intent.projectId)
  })
  const apply = object(item.apply, `${name}.apply`)
  exactKeys(apply, ['mode', 'recoveryScope', 'externalEffects', 'counts'], `${name}.apply`)
  if (!['single-candidate', 'guided', 'blocked'].includes(apply.mode)) throw new TypeError(`${name}.apply.mode is unsupported`)
  if (!['profile-generation', 'partial', 'none'].includes(apply.recoveryScope)) throw new TypeError(`${name}.apply.recoveryScope is unsupported`)
  if (apply.externalEffects !== 'not-covered') throw new TypeError(`${name}.apply.externalEffects is unsupported`)
  const counts = object(apply.counts, `${name}.apply.counts`)
  exactKeys(counts, ['total', 'managed', 'guided', 'blocked'], `${name}.apply.counts`)
  for (const key of ['total', 'managed', 'guided', 'blocked']) {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) throw new TypeError(`${name}.apply.counts.${key} is invalid`)
  }
  const expected = {
    total: item.items.length,
    guided: item.items.filter(candidate => candidate.management === 'guided').length,
    blocked: item.items.filter(candidate => candidate.availability === 'blocked').length,
  }
  expected.managed = expected.total - expected.guided
  if (Object.keys(expected).some(key => counts[key] !== expected[key])) throw new TypeError(`${name}.apply.counts do not match items`)
  const expectedMode = expected.blocked > 0 ? 'blocked' : expected.guided > 0 ? 'guided' : 'single-candidate'
  const expectedRecovery = expectedMode === 'single-candidate' ? 'profile-generation' : expected.managed > 0 ? 'partial' : 'none'
  if (apply.mode !== expectedMode || apply.recoveryScope !== expectedRecovery) {
    throw new TypeError(`${name}.apply does not match item capabilities`)
  }
  return item
}

export function parseRecipes(value) {
  const document = object(value, 'Recipe feed')
  exactKeys(document, ['schema', 'generatedAt', 'registry', 'recipes'], 'Recipe feed')
  if (document.schema !== RECIPES_SCHEMA) throw new TypeError('unsupported Recipe feed schema')
  timestamp(document.generatedAt, 'generatedAt')
  const registry = object(document.registry, 'registry')
  exactKeys(registry, ['schema', 'snapshotId', 'revision', 'origins'], 'registry')
  if (registry.schema !== REGISTRY_SCHEMA) throw new TypeError('Recipe feed uses an unsupported Registry schema')
  string(registry.snapshotId, 'registry.snapshotId', { pattern: SNAPSHOT_RE })
  if (!Number.isSafeInteger(registry.revision) || registry.revision < 0) throw new TypeError('registry.revision is invalid')
  if (!Array.isArray(registry.origins) || registry.origins.length === 0) throw new TypeError('registry.origins must be a non-empty array')
  registry.origins.forEach((origin, index) => httpsUrl(origin, `registry.origins[${index}]`))
  if (new Set(registry.origins).size !== registry.origins.length) throw new TypeError('registry.origins contains duplicates')
  if (!Array.isArray(document.recipes)) throw new TypeError('recipes must be an array')
  document.recipes.forEach(recipe)
  const ids = document.recipes.map(item => item.id)
  if (new Set(ids).size !== ids.length) throw new TypeError('Recipe feed contains duplicate IDs')
  if (ids.some((id, index) => index > 0 && ids[index - 1].localeCompare(id) >= 0)) {
    throw new TypeError('Recipe feed must be sorted by ID')
  }
  return document
}

export function assertRecipesRegistry(document, registry) {
  if (document.registry.schema !== registry.schema
    || document.registry.snapshotId !== registry.snapshotId
    || document.registry.revision !== registry.revision
    || canonicalJson(document.registry.origins) !== canonicalJson(registry.origins)) {
    throw new Error('Recipe feed does not match the selected Registry snapshot')
  }
  return document
}

async function jsonFile(filename) {
  return JSON.parse(await readFile(filename, 'utf8'))
}

export class RecipeClient {
  constructor(options = {}) {
    if (options.registry === undefined) throw new Error('RecipeClient requires the existing Registry client')
    this.registry = options.registry
    this.home = resolveDshHome(options.home ?? options.registry.home)
    this.bundledFile = options.bundledFile ?? BUNDLED_RECIPES
    this.loaded = null
  }

  async current() {
    const selectedRegistry = await this.registry.current()
    if (this.loaded !== null && this.loaded.registrySnapshotId === selectedRegistry.document.snapshotId) return this.loaded
    const bundled = assertRecipesRegistry(parseRecipes(await jsonFile(this.bundledFile)), selectedRegistry.document)
    this.loaded = {
      document: bundled,
      source: 'bundled',
      warning: null,
      registrySnapshotId: selectedRegistry.document.snapshotId,
    }
    return this.loaded
  }

  async view() {
    const selected = await this.current()
    return {
      schema: 'omdsh.recipe-view/v1',
      snapshot: {
        generatedAt: selected.document.generatedAt,
        registrySnapshotId: selected.registrySnapshotId,
        source: selected.source,
        warning: selected.warning,
      },
      recipes: selected.document.recipes,
    }
  }

  async resolve(id) {
    const selected = await this.current()
    const item = selected.document.recipes.find(recipe => recipe.id === id)
    if (item === undefined) throw new Error(`Recipe not found: ${JSON.stringify(id)}`)
    if (item.apply.mode !== 'single-candidate') {
      throw new Error(`Recipe ${JSON.stringify(id)} is ${item.apply.mode} and cannot be applied automatically`)
    }
    return Object.freeze({
      recipe: item,
      registrySnapshotId: selected.registrySnapshotId,
      items: Object.freeze(item.items.map(intent => Object.freeze({
        id: intent.projectId,
        releaseId: intent.releaseId,
        enabled: intent.enabled,
      }))),
    })
  }

  async sync() {
    throw new Error('Runtime Workshop snapshots are read-only; update them with workshop:vendor')
  }
}
