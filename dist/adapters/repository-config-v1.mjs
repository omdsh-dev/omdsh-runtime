import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from '../atomic.mjs'
import { discardPending, markCandidateReady, prepareCandidate } from '../generations.mjs'
import { profileDirectory } from '../paths.mjs'
import { updateGeneration } from '../profile.mjs'

export const REPOSITORY_CONFIG_ADAPTER = 'official-repository/v1'
export const REPOSITORY_BLOCK_START = '# >>> omdsh repository-plugin'
export const REPOSITORY_BLOCK_END = '# <<< omdsh repository-plugin'

const SPEC_RE = /^github:([^/\s#&]+)\/([^/\s#&]+)#([0-9a-f]{40})(?:&path:(\/[^\s&]+))?$/
const DEFAULT_PATH = '/.dsh-plugin'

function validPath(path) {
  const segments = path.split('/').slice(1)
  return segments.length > 0
    && segments.at(-1) === '.dsh-plugin'
    && segments.every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

export function parseRepositorySpec(value) {
  if (typeof value !== 'string') throw new Error('Repository Plugin spec must be a string')
  const match = SPEC_RE.exec(value)
  if (match === null) throw new Error(`invalid Repository Plugin spec ${JSON.stringify(value)}`)
  const path = match[4] ?? DEFAULT_PATH
  if (!validPath(path)) throw new Error(`invalid Repository Plugin path ${JSON.stringify(path)}`)
  return Object.freeze({ repo: `github:${match[1]}/${match[2]}`, ref: match[3], path })
}

export function formatRepositorySpec(value) {
  const parsed = typeof value === 'string' ? parseRepositorySpec(value) : value
  const path = parsed.path === DEFAULT_PATH ? '' : `&path:${parsed.path}`
  return `${parsed.repo}#${parsed.ref}${path}`
}

export function repositorySpecIdentity(spec) {
  const parsed = parseRepositorySpec(spec)
  return `${parsed.repo}&path:${parsed.path}`
}

function blockBounds(content) {
  const start = content.indexOf(REPOSITORY_BLOCK_START)
  const end = content.indexOf(REPOSITORY_BLOCK_END)
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error('OMDSH Repository Plugin block is incomplete')
  }
  if (start !== -1
    && (content.indexOf(REPOSITORY_BLOCK_START, start + 1) !== -1
      || content.indexOf(REPOSITORY_BLOCK_END, end + 1) !== -1)) {
    throw new Error('multiple OMDSH Repository Plugin blocks found')
  }
  if (start === -1) return null
  return { start, end: end + REPOSITORY_BLOCK_END.length }
}

function withoutManagedBlock(content) {
  const bounds = blockBounds(content)
  if (bounds === null) return content
  const before = content.slice(0, bounds.start)
  const afterStart = content[bounds.end] === '\r' && content[bounds.end + 1] === '\n'
    ? bounds.end + 2
    : content[bounds.end] === '\n' ? bounds.end + 1 : bounds.end
  return `${before}${content.slice(afterStart)}`
}

function assertNoExternalRepositoryRow(content) {
  const visible = content.split(/\r?\n/).filter(line => !line.trimStart().startsWith('#')).join('\n')
  if (/\brepository-plugins\b/.test(visible)) {
    throw new Error('repository-plugins is already configured outside the OMDSH managed block')
  }
}

function parseManagedBlock(content) {
  const bounds = blockBounds(content)
  if (bounds === null) return []
  const bodyStart = bounds.start + REPOSITORY_BLOCK_START.length
  const bodyEnd = content.indexOf(REPOSITORY_BLOCK_END, bodyStart)
  const lines = content.slice(bodyStart, bodyEnd)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
  if (lines.length !== 1 || !lines[0].startsWith('- ')) {
    throw new Error('OMDSH Repository Plugin block has an unsupported shape')
  }
  let row
  try { row = JSON.parse(lines[0].slice(2)) } catch { throw new Error('OMDSH Repository Plugin block is not valid JSON-as-YAML') }
  if (row?.id !== 'repository-plugins'
    || row?.name !== '@deepseek-ai/dsh-repository-plugin'
    || !Array.isArray(row?.config?.repositories)
    || !row.config.repositories.every(spec => typeof spec === 'string')) {
    throw new Error('OMDSH Repository Plugin block has an invalid repository-plugins row')
  }
  const specs = row.config.repositories.map(formatRepositorySpec)
  if (new Set(specs).size !== specs.length) throw new Error('OMDSH Repository Plugin block contains duplicate specs')
  return specs
}

function renderManagedBlock(specs) {
  const row = {
    id: 'repository-plugins',
    name: '@deepseek-ai/dsh-repository-plugin',
    config: { repositories: specs },
  }
  return `${REPOSITORY_BLOCK_START}\n- ${JSON.stringify(row)}\n${REPOSITORY_BLOCK_END}\n`
}

function patchFilename(home, profile) {
  return join(profileDirectory(home, profile), 'cordis.patch.yml')
}

export async function readRepositorySpecs(home, profile) {
  const content = await readFile(patchFilename(home, profile), 'utf8')
  return Object.freeze(parseManagedBlock(content))
}

export async function writeRepositorySpecs(home, profile, values) {
  const specs = values.map(formatRepositorySpec)
  if (new Set(specs).size !== specs.length) throw new Error('duplicate Repository Plugin specs')
  const filename = patchFilename(home, profile)
  const current = await readFile(filename, 'utf8')
  const unmanaged = withoutManagedBlock(current)
  assertNoExternalRepositoryRow(unmanaged)
  let base = unmanaged
  if (base.trim() === '[]') base = ''
  base = base.replace(/[\t ]+$/gm, '').replace(/\s+$/, '')
  const next = specs.length === 0
    ? (base === '' ? '[]\n' : `${base}\n`)
    : `${base === '' ? '' : `${base}\n`}${renderManagedBlock(specs)}`
  await atomicWriteText(filename, next, 0o644)
  return Object.freeze([...specs])
}

export class RepositoryConfigAdapter {
  constructor(options) {
    if (options?.manager === undefined) throw new Error('RepositoryConfigAdapter requires ExtensionManager')
    this.manager = options.manager
  }

  async list(profile = 'web') {
    const selected = await this.manager.resolve(profile)
    return readRepositorySpecs(this.manager.home, selected)
  }

  install(intent, options = {}) { return this.#stage(intent, options.profile ?? 'web', 'install') }
  update(intent, options = {}) { return this.#stage(intent, options.profile ?? 'web', 'update') }
  remove(intent, options = {}) { return this.#stage(intent, options.profile ?? 'web', 'remove') }

  async #stage(intent, profile, requestedAction) {
    if (intent?.adapter !== REPOSITORY_CONFIG_ADAPTER || intent.mode !== 'repository-plugin') {
      throw new Error('unsupported Repository Plugin install intent')
    }
    await this.manager.requireRepositoryPlugin(profile)
    const selected = await this.manager.resolve(profile)
    const installed = [...await readRepositorySpecs(this.manager.home, selected)]
    const targetIdentity = repositorySpecIdentity(intent.spec)
    const index = installed.findIndex(spec => repositorySpecIdentity(spec) === targetIdentity)
    if (requestedAction === 'remove' && index === -1) {
      throw new Error(`Repository Plugin is not installed: ${intent.spec}`)
    }
    const next = [...installed]
    let operation = requestedAction
    if (requestedAction === 'remove') next.splice(index, 1)
    else if (index === -1) next.push(formatRepositorySpec(intent.spec))
    else {
      next[index] = formatRepositorySpec(intent.spec)
      operation = 'update'
    }
    const candidate = await prepareCandidate(this.manager.home, profile)
    try {
      await writeRepositorySpecs(this.manager.home, candidate.id, next)
      await updateGeneration(this.manager.home, candidate.id, metadata => ({
        ...metadata,
        operations: [...metadata.operations, {
          type: `repository-${operation}`,
          entryId: intent.id,
          releaseId: intent.releaseId,
          spec: intent.spec,
          adapter: REPOSITORY_CONFIG_ADAPTER,
        }],
      }))
      await this.manager.validateCandidate(candidate.id)
      await markCandidateReady(this.manager.home, profile)
      return this.manager.status(profile)
    } catch (error) {
      await discardPending(this.manager.home, profile, error instanceof Error ? error.message : String(error)).catch(() => {})
      throw error
    }
  }
}
