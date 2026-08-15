import { homedir } from 'node:os'
import { join } from 'node:path'
import { MANAGER_DIRECTORY, STATE_FILENAME } from './constants.mjs'

export function resolveDshHome(explicit) {
  if (explicit !== undefined && explicit !== '') return explicit
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '') return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

export function assertProfileName(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..'
    || name === 'node_modules' || name.includes('/') || name.includes('\\')) {
    throw new Error(`invalid DSH profile name ${JSON.stringify(name)}`)
  }
  return name
}

export function profilesDirectory(home) {
  return join(resolveDshHome(home), 'profiles')
}

export function agentPresetsDirectory(home) {
  return join(resolveDshHome(home), '.agent-presets')
}

export function profileDirectory(home, name) {
  return join(profilesDirectory(home), assertProfileName(name))
}

export function managerDirectory(home) {
  return join(resolveDshHome(home), MANAGER_DIRECTORY)
}

export function stateFilename(home) {
  return join(managerDirectory(home), STATE_FILENAME)
}
