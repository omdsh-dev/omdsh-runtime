import { open, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { atomicWriteJson } from './atomic.mjs'
import { EVENT_LIMIT, STATE_SCHEMA } from './constants.mjs'
import { assertProfileName, resolveDshHome, stateFilename } from './paths.mjs'

function emptyState() {
  return { schema: STATE_SCHEMA, profiles: {} }
}

function validateState(value, filename) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== STATE_SCHEMA || value.profiles === null
    || typeof value.profiles !== 'object' || Array.isArray(value.profiles)) {
    throw new Error(`unsupported OMDSH state in ${filename}`)
  }
  return value
}

export async function readState(home) {
  const filename = stateFilename(home)
  let text
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState()
    throw error
  }
  return validateState(JSON.parse(text), filename)
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

async function acquireStateLock(home) {
  const filename = `${stateFilename(home)}.lock`
  await mkdir(dirname(filename), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(filename, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`)
      await handle.sync()
      return async () => {
        await handle.close().catch(() => {})
        await rm(filename, { force: true })
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let stale = false
      try {
        const lock = JSON.parse(await readFile(filename, 'utf8'))
        stale = !processExists(lock.pid)
      } catch {
        stale = true
      }
      if (!stale || attempt > 0) throw new Error('another OMDSH extension operation is active')
      await rm(filename, { force: true })
    }
  }
  throw new Error('failed to acquire OMDSH state lock')
}

export function ensureProfileState(state, logicalProfile) {
  const logical = assertProfileName(logicalProfile)
  if (state.profiles[logical] === undefined) {
    state.profiles[logical] = {
      current: logical,
      previous: null,
      pending: null,
      bootAttempt: null,
      failed: [],
      events: [],
      updatedAt: new Date().toISOString(),
    }
  }
  return state.profiles[logical]
}

export function appendEvent(profile, event) {
  const events = Array.isArray(profile.events) ? profile.events : []
  events.push({ at: new Date().toISOString(), ...event })
  profile.events = events.slice(-EVENT_LIMIT)
  profile.updatedAt = new Date().toISOString()
}

export async function updateState(home, update) {
  const dshHome = resolveDshHome(home)
  const release = await acquireStateLock(dshHome)
  try {
    const state = await readState(dshHome)
    const result = await update(state)
    await atomicWriteJson(stateFilename(dshHome), state)
    return result
  } finally {
    await release()
  }
}

