import { createHash, randomBytes } from 'node:crypto'
import { appendEvent, ensureProfileState, readState, updateState } from './state.mjs'
import { assertProfileName, resolveDshHome } from './paths.mjs'
import {
  createCandidateProfile, profileExists, readGeneration, updateGeneration,
} from './profile.mjs'

export async function extensionStatus(home, logicalProfile = 'web') {
  const dshHome = resolveDshHome(home)
  const logical = assertProfileName(logicalProfile)
  const state = await readState(dshHome)
  const profile = state.profiles[logical] ?? {
    current: logical,
    previous: null,
    pending: null,
    bootAttempt: null,
    failed: [],
    events: [],
  }
  const publicProfile = structuredClone(profile)
  if (publicProfile.bootAttempt !== null) delete publicProfile.bootAttempt.tokenHash
  return { schema: state.schema, logicalProfile: logical, ...publicProfile }
}

export async function resolveSelectedProfile(home, logicalProfile = 'web') {
  return (await extensionStatus(home, logicalProfile)).current
}

function hashBootToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export async function beginLaunch(home, logicalProfile = 'web', options = {}) {
  const dshHome = resolveDshHome(home)
  const logical = assertProfileName(logicalProfile)
  return updateState(dshHome, async (state) => {
    const profile = ensureProfileState(state, logical)
    const selectedProfile = assertProfileName(profile.current)
    if (!await profileExists(dshHome, selectedProfile)) {
      throw new Error(`selected profile does not exist: ${selectedProfile}`)
    }
    if (profile.bootAttempt === null) {
      return { logicalProfile: logical, selectedProfile, requiresConfirmation: false, token: null }
    }
    if (profile.bootAttempt.generation !== selectedProfile) {
      throw new Error(`profile ${logical} boot attempt is stale`)
    }
    const launcherPid = options.launcherPid ?? process.pid
    if (profile.bootAttempt.launcherPid !== undefined
      && profile.bootAttempt.launcherPid !== launcherPid
      && processExists(profile.bootAttempt.launcherPid)) {
      throw new Error(`profile ${logical} already has an active launcher`)
    }
    const token = randomBytes(24).toString('base64url')
    profile.bootAttempt = {
      ...profile.bootAttempt,
      launchedAt: new Date().toISOString(),
      launcherPid,
      tokenHash: hashBootToken(token),
    }
    appendEvent(profile, { type: 'boot/launched', generation: selectedProfile })
    return { logicalProfile: logical, selectedProfile, requiresConfirmation: true, token }
  })
}

export async function prepareCandidate(home, logicalProfile = 'web', options = {}) {
  const dshHome = resolveDshHome(home)
  const logical = assertProfileName(logicalProfile)
  return updateState(dshHome, async (state) => {
    const profile = ensureProfileState(state, logical)
    if (profile.pending !== null) throw new Error(`profile ${logical} already has pending generation ${profile.pending}`)
    const generation = await createCandidateProfile(dshHome, {
      logicalProfile: logical,
      sourceProfile: profile.current,
      ...options,
    })
    profile.pending = generation.id
    appendEvent(profile, { type: 'candidate/prepared', generation: generation.id, source: profile.current })
    return generation
  })
}

export async function markCandidateReady(home, logicalProfile = 'web') {
  const dshHome = resolveDshHome(home)
  const logical = assertProfileName(logicalProfile)
  return updateState(dshHome, async (state) => {
    const profile = ensureProfileState(state, logical)
    if (profile.pending === null) throw new Error(`profile ${logical} has no pending generation`)
    await updateGeneration(dshHome, profile.pending, metadata => ({ ...metadata, status: 'ready' }))
    appendEvent(profile, { type: 'candidate/ready', generation: profile.pending })
    return profile.pending
  })
}

export async function discardPending(home, logicalProfile = 'web', reason = 'discarded') {
  const dshHome = resolveDshHome(home)
  const logical = assertProfileName(logicalProfile)
  return updateState(dshHome, async (state) => {
    const profile = ensureProfileState(state, logical)
    if (profile.pending === null) return null
    const generation = profile.pending
    profile.pending = null
    if (!profile.failed.includes(generation)) profile.failed.push(generation)
    await updateGeneration(dshHome, generation, metadata => ({ ...metadata, status: 'failed', failure: reason }))
    appendEvent(profile, { type: 'candidate/failed', generation, reason })
    return generation
  })
}

export async function activatePending(home, logicalProfile = 'web') {
  const dshHome = resolveDshHome(home)
  const logical = assertProfileName(logicalProfile)
  return updateState(dshHome, async (state) => {
    const profile = ensureProfileState(state, logical)
    if (profile.pending === null) throw new Error(`profile ${logical} has no pending generation`)
    const generation = await readGeneration(dshHome, profile.pending)
    if (generation.status !== 'ready') throw new Error(`pending generation ${generation.id} is not ready`)
    profile.previous = profile.current
    profile.current = generation.id
    profile.pending = null
    profile.bootAttempt = { generation: generation.id, startedAt: new Date().toISOString() }
    await updateGeneration(dshHome, generation.id, metadata => ({ ...metadata, status: 'booting' }))
    appendEvent(profile, { type: 'candidate/activated', generation: generation.id, previous: profile.previous })
    return generation.id
  })
}

export async function confirmBoot(home, logicalProfile = 'web', options = {}) {
  const dshHome = resolveDshHome(home)
  const logical = assertProfileName(logicalProfile)
  return updateState(dshHome, async (state) => {
    const profile = ensureProfileState(state, logical)
    if (profile.bootAttempt === null) throw new Error(`profile ${logical} has no boot attempt to confirm`)
    if (profile.bootAttempt.generation !== profile.current) throw new Error(`profile ${logical} boot attempt is stale`)
    if (options.generation !== undefined && options.generation !== profile.current) {
      throw new Error(`runtime-ready generation does not match current profile`)
    }
    if (options.token !== undefined) {
      if (typeof options.token !== 'string' || options.token === '') throw new Error('runtime-ready token is required')
      if (profile.bootAttempt.tokenHash === undefined) throw new Error('boot attempt has no launch token')
      if (hashBootToken(options.token) !== profile.bootAttempt.tokenHash) throw new Error('invalid runtime-ready token')
    }
    const generation = profile.current
    profile.bootAttempt = null
    await updateGeneration(dshHome, generation, metadata => ({ ...metadata, status: 'current' }))
    appendEvent(profile, { type: 'boot/confirmed', generation })
    return generation
  })
}

export async function confirmRuntimeReady(home, options = {}) {
  const logical = options.logicalProfile ?? process.env.OMDSH_LOGICAL_PROFILE ?? 'web'
  const generation = options.generation ?? process.env.OMDSH_GENERATION
  const token = options.token ?? process.env.OMDSH_BOOT_TOKEN
  if (generation === undefined || generation === '') throw new Error('runtime-ready generation is required')
  if (token === undefined || token === '') throw new Error('runtime-ready token is required')
  return confirmBoot(home, logical, { generation, token })
}

export async function recoverProfile(home, logicalProfile = 'web', options = {}) {
  const dshHome = resolveDshHome(home)
  const logical = assertProfileName(logicalProfile)
  return updateState(dshHome, async (state) => {
    const profile = ensureProfileState(state, logical)
    const bad = new Set()
    if (profile.pending !== null) bad.add(profile.pending)
    if (profile.bootAttempt !== null) bad.add(profile.bootAttempt.generation)
    if (profile.current !== logical && profile.previous !== null) bad.add(profile.current)
    const target = assertProfileName(options.to ?? profile.previous ?? logical)
    if (bad.has(target) || profile.failed.includes(target)) {
      throw new Error(`recovery target profile is marked failed: ${target}`)
    }
    if (!await profileExists(dshHome, target)) throw new Error(`recovery target profile does not exist: ${target}`)
    for (const generation of bad) {
      if (!profile.failed.includes(generation)) profile.failed.push(generation)
      await updateGeneration(dshHome, generation, metadata => ({
        ...metadata,
        status: 'failed',
        failure: options.reason ?? 'recovered',
      })).catch(() => {})
    }
    const from = profile.current
    profile.current = target
    profile.previous = null
    profile.pending = null
    profile.bootAttempt = null
    appendEvent(profile, { type: 'recovery/completed', from, to: target, failed: [...bad] })
    return { logicalProfile: logical, from, to: target, failed: [...bad] }
  })
}
