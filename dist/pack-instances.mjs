import { readState, updateState } from './state.mjs'
import { assertProfileName, resolveDshHome } from './paths.mjs'

export const PACK_INSTANCE_SCHEMA = 'omdsh-pack-instance/v1'

function instances(state) {
  if (state.packInstances === undefined) state.packInstances = {}
  if (state.packInstances === null || typeof state.packInstances !== 'object' || Array.isArray(state.packInstances)) {
    throw new Error('OMDSH pack instance state is invalid')
  }
  return state.packInstances
}

function validate(value, name) {
  if (value === null) return null
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== PACK_INSTANCE_SCHEMA || value.name !== name) {
    throw new Error(`unsupported OMDSH pack instance ${JSON.stringify(name)}`)
  }
  assertProfileName(value.profile)
  return value
}

export async function readPackInstance(home, name) {
  const id = assertProfileName(name)
  const state = await readState(resolveDshHome(home))
  return validate(state.packInstances?.[id] ?? null, id)
}

export async function writePackInstance(home, name, update) {
  const dshHome = resolveDshHome(home)
  const id = assertProfileName(name)
  return updateState(dshHome, async (state) => {
    const values = instances(state)
    const current = validate(values[id] ?? null, id)
    const next = await update(structuredClone(current))
    if (next === null) delete values[id]
    else {
      validate(next, id)
      next.updatedAt = new Date().toISOString()
      values[id] = next
    }
    return structuredClone(next)
  })
}
