import { access, copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { atomicWriteJson } from './atomic.mjs'
import { GENERATION_FILENAME, GENERATION_SCHEMA } from './constants.mjs'
import { assertProfileName, profileDirectory, profilesDirectory, resolveDshHome } from './paths.mjs'

const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']

async function exists(filename) {
  try {
    await access(filename, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readJson(filename) {
  let text
  try {
    text = await readFile(filename, 'utf8')
  } catch (cause) {
    throw new Error(`failed to read ${filename}`, { cause })
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new Error(`invalid JSON in ${filename}`, { cause })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${filename} must contain a JSON object`)
  }
  return value
}

export async function profileExists(home, name) {
  return exists(join(profileDirectory(home, name), 'package.json'))
}

export async function readProfile(home, name) {
  const profileName = assertProfileName(name)
  const directory = profileDirectory(home, profileName)
  const manifest = await readJson(join(directory, 'package.json'))
  const dependencies = manifest.dependencies ?? {}
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error(`profile ${profileName} dependencies must be an object`)
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!Array.isArray(bundles) || !bundles.every(value => typeof value === 'string')) {
    throw new Error(`profile ${profileName} dsh.profile.bundles must be a string array`)
  }
  return {
    name: profileName,
    directory,
    manifest,
    installed: Object.freeze({ ...dependencies }),
    enabled: Object.freeze([...bundles]),
  }
}

export async function setEnabledBundles(home, profileName, bundleNames) {
  if (!Array.isArray(bundleNames) || !bundleNames.every(value => typeof value === 'string' && value !== '')) {
    throw new Error('enabled bundles must be a string array')
  }
  const profile = await readProfile(home, profileName)
  const bundles = [...new Set(bundleNames)]
  const dsh = profile.manifest.dsh ?? {}
  profile.manifest.dsh = { ...dsh, profile: { ...dsh.profile, bundles } }
  await atomicWriteJson(join(profile.directory, 'package.json'), profile.manifest, 0o644)
  return readProfile(home, profileName)
}

export async function setBundleEnabled(home, profileName, packageName, enabled) {
  if (typeof packageName !== 'string' || packageName === '') throw new Error('package name is required')
  const profile = await readProfile(home, profileName)
  const bundles = [...profile.enabled]
  const index = bundles.indexOf(packageName)
  if (enabled && index === -1) bundles.push(packageName)
  if (!enabled && index !== -1) bundles.splice(index, 1)
  return setEnabledBundles(home, profileName, bundles)
}

function generationName(logicalProfile, now = new Date()) {
  const logical = assertProfileName(logicalProfile)
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `omdsh-${logical}-${stamp}-${randomBytes(4).toString('hex')}`
}

export async function createCandidateProfile(home, options = {}) {
  const dshHome = resolveDshHome(home)
  const logicalProfile = assertProfileName(options.logicalProfile ?? 'web')
  const sourceProfile = assertProfileName(options.sourceProfile ?? logicalProfile)
  const name = assertProfileName(options.name ?? generationName(logicalProfile, options.now))
  if (await profileExists(dshHome, name)) throw new Error(`candidate profile already exists: ${name}`)
  const source = profileDirectory(dshHome, sourceProfile)
  if (!await exists(join(source, 'package.json'))) throw new Error(`source profile does not exist: ${sourceProfile}`)
  const root = profilesDirectory(dshHome)
  await mkdir(root, { recursive: true })
  const temporaryName = `.omdsh-candidate-${process.pid}-${randomBytes(5).toString('hex')}`
  const temporary = join(root, temporaryName)
  const target = profileDirectory(dshHome, name)
  await mkdir(temporary, { recursive: false })
  try {
    for (const filename of PROFILE_FILES) {
      const from = join(source, filename)
      if (await exists(from)) await copyFile(from, join(temporary, filename))
    }
    const metadata = {
      schema: GENERATION_SCHEMA,
      id: name,
      logicalProfile,
      sourceProfile,
      status: 'prepared',
      createdAt: (options.now ?? new Date()).toISOString(),
      updatedAt: (options.now ?? new Date()).toISOString(),
      operations: [],
    }
    await atomicWriteJson(join(temporary, GENERATION_FILENAME), metadata)
    await rename(temporary, target)
    return metadata
  } catch (cause) {
    await rm(temporary, { recursive: true, force: true })
    throw cause
  }
}

export async function readGeneration(home, name) {
  const filename = join(profileDirectory(home, name), GENERATION_FILENAME)
  const value = await readJson(filename)
  if (value.schema !== GENERATION_SCHEMA || value.id !== name) {
    throw new Error(`unsupported generation metadata in ${filename}`)
  }
  return value
}

export async function updateGeneration(home, name, update) {
  const current = await readGeneration(home, name)
  const next = typeof update === 'function' ? update(structuredClone(current)) : { ...current, ...update }
  next.schema = GENERATION_SCHEMA
  next.id = name
  next.updatedAt = new Date().toISOString()
  await atomicWriteJson(join(profileDirectory(home, name), GENERATION_FILENAME), next)
  return next
}
