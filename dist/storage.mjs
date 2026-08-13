import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { GENERATION_FILENAME } from './constants.mjs'
import { appendEvent, ensureProfileState, readState, updateState } from './state.mjs'
import { assertProfileName, profileDirectory, profilesDirectory, resolveDshHome } from './paths.mjs'
import { readGeneration } from './profile.mjs'

async function directoryUsage(filename) {
  const stats = await lstat(filename)
  const ownAllocated = typeof stats.blocks === 'number' ? stats.blocks * 512 : stats.size
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return { apparentBytes: stats.size, allocatedBytes: ownAllocated, entries: 1 }
  }
  const total = { apparentBytes: stats.size, allocatedBytes: ownAllocated, entries: 1 }
  for (const entry of await readdir(filename)) {
    const child = await directoryUsage(join(filename, entry))
    total.apparentBytes += child.apparentBytes
    total.allocatedBytes += child.allocatedBytes
    total.entries += child.entries
  }
  return total
}

function protectedGenerations(profile) {
  return new Set([
    profile.current,
    profile.previous,
    profile.pending,
    profile.bootAttempt?.generation,
  ].filter(value => typeof value === 'string'))
}

async function scanGenerations(home, logicalProfile, profile) {
  const root = profilesDirectory(home)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const protectedIds = protectedGenerations(profile)
  const generations = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const metadataFilename = join(root, entry.name, GENERATION_FILENAME)
    try {
      const metadataStats = await lstat(metadataFilename)
      if (!metadataStats.isFile() || metadataStats.isSymbolicLink()) continue
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    const metadata = await readGeneration(home, entry.name)
    if (metadata.logicalProfile !== logicalProfile) continue
    generations.push({
      ...metadata,
      protected: protectedIds.has(metadata.id),
      failed: metadata.status === 'failed' || profile.failed.includes(metadata.id),
      usage: await directoryUsage(profileDirectory(home, metadata.id)),
    })
  }
  return generations.sort((left, right) => {
    const byDate = String(right.createdAt).localeCompare(String(left.createdAt))
    return byDate || right.id.localeCompare(left.id)
  })
}

export async function generationStorage(home, logicalProfile = 'web') {
  const dshHome = resolveDshHome(home)
  const logical = assertProfileName(logicalProfile)
  const state = await readState(dshHome)
  const profile = state.profiles[logical] ?? {
    current: logical, previous: null, pending: null, bootAttempt: null, failed: [],
  }
  const generations = await scanGenerations(dshHome, logical, profile)
  return {
    logicalProfile: logical,
    totals: generations.reduce((total, generation) => ({
      generations: total.generations + 1,
      apparentBytes: total.apparentBytes + generation.usage.apparentBytes,
      allocatedBytes: total.allocatedBytes + generation.usage.allocatedBytes,
    }), { generations: 0, apparentBytes: 0, allocatedBytes: 0 }),
    generations,
  }
}

function assertKeepFailed(value) {
  const parsed = typeof value === 'string' && value !== '' ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('keepFailed must be a non-negative integer')
  return parsed
}

function cleanupPlan(generations, keepFailed) {
  const failed = generations.filter(generation => generation.failed && !generation.protected)
  return failed.slice(keepFailed)
}

async function assertSafeGenerationTarget(home, generation) {
  const root = await realpath(profilesDirectory(home))
  const target = profileDirectory(home, generation.id)
  const stats = await lstat(target)
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`unsafe generation target: ${target}`)
  const resolved = await realpath(target)
  if (dirname(resolved) !== root) throw new Error(`generation escapes Profile directory: ${target}`)
  const metadata = await readGeneration(home, generation.id)
  if (metadata.id !== generation.id || metadata.logicalProfile !== generation.logicalProfile) {
    throw new Error(`generation metadata changed before cleanup: ${generation.id}`)
  }
  return target
}

export async function cleanupFailedGenerations(home, logicalProfile = 'web', options = {}) {
  const dshHome = resolveDshHome(home)
  const logical = assertProfileName(logicalProfile)
  const keepFailed = assertKeepFailed(options.keepFailed ?? 3)
  if (options.apply !== true) {
    const storage = await generationStorage(dshHome, logical)
    const planned = cleanupPlan(storage.generations, keepFailed)
    return {
      logicalProfile: logical, applied: false, keepFailed,
      generations: planned.map(generation => generation.id),
      reclaimableBytes: planned.reduce((total, generation) => total + generation.usage.allocatedBytes, 0),
    }
  }
  return updateState(dshHome, async (state) => {
    const profile = ensureProfileState(state, logical)
    const generations = await scanGenerations(dshHome, logical, profile)
    const planned = cleanupPlan(generations, keepFailed)
    for (const generation of planned) {
      const target = await assertSafeGenerationTarget(dshHome, generation)
      await rm(target, { recursive: true, force: false })
      profile.failed = profile.failed.filter(id => id !== generation.id)
      appendEvent(profile, { type: 'generation/cleaned', generation: generation.id })
    }
    return {
      logicalProfile: logical, applied: true, keepFailed,
      generations: planned.map(generation => generation.id),
      reclaimedBytes: planned.reduce((total, generation) => total + generation.usage.allocatedBytes, 0),
    }
  })
}
