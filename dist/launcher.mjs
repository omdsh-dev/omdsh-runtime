import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import {
  beginLaunch, confirmRuntimeReady, extensionStatus, recoverProfile,
} from './generations.mjs'
import { resolveDshHome } from './paths.mjs'
import { withoutPackageCredentials } from './process-environment.mjs'

export const DEFAULT_RUNTIME_READY_TIMEOUT_MS = 120_000

function defaultRunner(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      shell: false,
      stdio: 'inherit',
    })
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
    const forwarders = new Map(signals.map(signal => [signal, () => child.kill(signal)]))
    for (const [signal, forward] of forwarders) process.on(signal, forward)
    let killTimer
    const abort = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      killTimer.unref()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const cleanup = () => {
      for (const [signal, forward] of forwarders) process.off(signal, forward)
      options.signal?.removeEventListener('abort', abort)
      if (killTimer !== undefined) clearTimeout(killTimer)
    }
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (code, signal) => {
      cleanup()
      const signalCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : signal === 'SIGHUP' ? 129 : 1
      resolve({ code: code ?? signalCode, signal })
    })
  })
}

function assertPositiveDuration(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`)
  return value
}

async function waitForBootResolution(home, logicalProfile, generation, options = {}) {
  const timeoutMs = assertPositiveDuration(
    options.timeoutMs ?? DEFAULT_RUNTIME_READY_TIMEOUT_MS,
    'runtime-ready timeout',
  )
  const pollIntervalMs = assertPositiveDuration(options.pollIntervalMs ?? 100, 'runtime-ready poll interval')
  const deadline = Date.now() + timeoutMs
  while (true) {
    const status = await extensionStatus(home, logicalProfile)
    if (status.bootAttempt?.generation !== generation) {
      return status.current === generation ? 'confirmed' : 'superseded'
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return 'timeout'
    try {
      await delay(Math.min(pollIntervalMs, remaining), undefined, { signal: options.signal })
    } catch (error) {
      if (error?.name === 'AbortError') return 'cancelled'
      throw error
    }
  }
}

export function selectProfileArguments(args, logicalProfile, selectedProfile) {
  const output = []
  let found = false
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    let supplied
    if (value === '--profile') {
      supplied = args[index + 1]
      if (supplied === undefined || supplied.startsWith('--')) throw new Error('--profile needs a value')
      index += 1
    } else if (value.startsWith('--profile=')) {
      supplied = value.slice('--profile='.length)
    } else {
      output.push(value)
      continue
    }
    if (found) throw new Error('DSH arguments contain more than one --profile')
    if (supplied !== logicalProfile && supplied !== selectedProfile) {
      throw new Error(`launcher profile ${logicalProfile} conflicts with DSH profile ${supplied}`)
    }
    output.push('--profile', selectedProfile)
    found = true
  }
  if (!found) output.unshift('--profile', selectedProfile)
  return output
}

function launchEnvironment(home, launch, environment) {
  const env = {
    ...withoutPackageCredentials(environment),
    DSH_HOME: home,
    OMDSH_LOGICAL_PROFILE: launch.logicalProfile,
    OMDSH_GENERATION: launch.selectedProfile,
  }
  if (launch.token !== null) env.OMDSH_BOOT_TOKEN = launch.token
  else delete env.OMDSH_BOOT_TOKEN
  return env
}

export async function launchDsh(options = {}) {
  const home = resolveDshHome(options.home)
  const logicalProfile = options.profile ?? 'web'
  const dshBin = options.dshBin ?? 'dsh'
  const runner = options.runner ?? defaultRunner
  const forwardedArgs = options.args ?? []
  const environment = options.environment ?? process.env
  const attempts = []
  let recovered = null

  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
    const launch = await beginLaunch(home, logicalProfile)
    const args = selectProfileArguments(forwardedArgs, logicalProfile, launch.selectedProfile)
    const runnerController = new AbortController()
    const runnerPromise = Promise.resolve(runner(dshBin, args, {
      env: launchEnvironment(home, launch, environment),
      signal: runnerController.signal,
    }))
    let result
    let readyTimeout = false

    if (launch.requiresConfirmation) {
      const monitorController = new AbortController()
      const outcome = await Promise.race([
        runnerPromise.then(value => ({ type: 'exit', value })),
        waitForBootResolution(home, logicalProfile, launch.selectedProfile, {
          timeoutMs: options.readyTimeoutMs,
          pollIntervalMs: options.readyPollIntervalMs,
          signal: monitorController.signal,
        }).then(type => ({ type })),
      ])
      monitorController.abort()
      if (outcome.type === 'exit') {
        result = outcome.value
      } else if (outcome.type === 'timeout') {
        readyTimeout = true
        runnerController.abort()
        result = await runnerPromise
      } else if (outcome.type === 'superseded') {
        runnerController.abort()
        result = await runnerPromise
      } else {
        result = await runnerPromise
      }
    } else {
      result = await runnerPromise
    }
    attempts.push({
      profile: launch.selectedProfile,
      code: result.code,
      signal: result.signal ?? null,
      readyTimeout,
    })

    if (!launch.requiresConfirmation) return { ...result, attempts, recovered }
    const status = await extensionStatus(home, logicalProfile)
    const remainsUnconfirmed = status.bootAttempt?.generation === launch.selectedProfile
    if (!remainsUnconfirmed) return { ...result, attempts, recovered }

    recovered = await recoverProfile(home, logicalProfile, {
      reason: readyTimeout
        ? `runtime-ready timeout after ${options.readyTimeoutMs ?? DEFAULT_RUNTIME_READY_TIMEOUT_MS}ms`
        : `process exited before runtime-ready (${result.signal ?? `exit ${result.code}`})`,
    })
    const interrupted = ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(result.signal)
    if (options.retryPrevious === false || (interrupted && !readyTimeout)) {
      return { ...result, attempts, recovered }
    }
  }
  throw new Error('recovery retry limit exceeded')
}

export { confirmRuntimeReady }
