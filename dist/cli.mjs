#!/usr/bin/env node
import { ExtensionManager } from './manager.mjs'
import { RegistryClient } from './registry.mjs'
import { RecipeClient } from './recipes.mjs'
import { WorkshopBridge } from './workshop-bridge.mjs'

function usage() {
  return `Usage:
  omdsh status [--profile web] [--json]
  omdsh resolve [--profile web]
  omdsh recover [--profile web] [--to generation] [--json]
  omdsh doctor [--profile web] [--json]
  omdsh market install <entry-id> [--profile web] [--enable]
  omdsh recipe plan <recipe-id> [--profile web] [--json]
  omdsh recipe apply <recipe-id> [--profile web] [--registry-snapshot sha256:...] [--json]
  omdsh install <spec> --name <package> [--profile web] [--enable] [--allow-scripts]
  omdsh update <spec> --name <package> [--profile web] [--allow-scripts]
  omdsh enable <package> [--profile web]
  omdsh disable <package> [--profile web]
  omdsh uninstall <package> [--profile web]
  omdsh activate [--profile web]
  omdsh confirm [--profile web]
  omdsh launch [--profile web] [--dsh /path/to/dsh] [--ready-timeout 120] -- [dsh arguments]
  omdsh ready [--profile web] [--generation name] [--token token]
  omdsh storage [--profile web] [--json]
  omdsh cleanup [--profile web] [--keep-failed 3] [--apply] [--json]
  omdsh discard [--profile web]

OMDSH Runtime executes exact, reviewed plans. Discovery, authoring, submission, and feed governance belong to DSH Hub Workshop.`
}

function parse(argv) {
  const positionals = []
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }
    const key = value.slice(2)
    if (['json', 'enable', 'allow-scripts', 'help', 'no-retry', 'apply'].includes(key)) {
      options[key] = true
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`--${key} needs a value`)
    if (key === 'use-case') {
      options[key] = [...(options[key] ?? []), next]
    } else options[key] = next
    index += 1
  }
  return { positionals, options }
}

function print(value, json = false) {
  if (json || typeof value !== 'string') process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  else process.stdout.write(`${value}\n`)
}

async function main() {
  const argv = process.argv.slice(2)
  const separator = argv.indexOf('--')
  const commandArgs = separator === -1 ? argv : argv.slice(0, separator)
  const forwardedArgs = separator === -1 ? [] : argv.slice(separator + 1)
  const { positionals, options } = parse(commandArgs)
  const [command, argument, nestedArgument, ...remainingArguments] = positionals
  if (command === undefined || command === 'help' || options.help === true) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const profile = options.profile ?? 'web'
  const registry = new RegistryClient({ home: options.home })
  const manager = new ExtensionManager({ home: options.home, dshBin: options.dsh, registry })
  const recipes = new RecipeClient({ home: options.home, registry })
  const workshop = new WorkshopBridge({ manager, registry, recipes })
  switch (command) {
    case 'status': print(await manager.status(profile), options.json); return
    case 'resolve': print(await manager.resolve(profile), options.json); return
    case 'recover': print(await manager.recover(profile, { to: options.to }), options.json); return
    case 'doctor': {
      const [selectedRegistry, officialPackage] = await Promise.all([
        registry.current(), manager.officialPackage(),
      ])
      let local
      try {
        local = { state: 'available', status: await manager.status(profile), capabilities: await manager.capabilities(profile) }
      } catch (error) {
        local = { state: 'unavailable', error: error instanceof Error ? error.message : String(error) }
      }
      print({
        schema: 'omdsh.runtime-doctor/v1',
        profile,
        checks: {
          registry: {
            state: 'ok', source: selectedRegistry.source,
            snapshotId: selectedRegistry.document.snapshotId,
            warning: selectedRegistry.warning,
          },
          officialPackage,
          localHarness: local,
        },
        boundaries: {
          loader: 'official-harness',
          installAuthority: 'omdsh-registry/v1',
          discoveryAndAuthoring: 'dsh-hub-workshop',
        },
      }, true)
      return
    }
    case 'market':
      if (argument !== 'install' || nestedArgument === undefined || positionals.length !== 3) {
        throw new Error('market needs: install <entry-id>')
      }
      print(await manager.stageMarketInstall(nestedArgument, {
        profile,
        ...(options.enable === true ? { enable: true } : {}),
      }), options.json)
      return
    case 'recipe':
      if (!['plan', 'apply'].includes(argument) || nestedArgument === undefined || positionals.length !== 3) {
        throw new Error('recipe needs: plan|apply <recipe-id>')
      }
      if (argument === 'plan') {
        print(await workshop.planRecipe(nestedArgument, { profile }), options.json)
        return
      }
      print(await workshop.applyRecipe(nestedArgument, {
        profile,
        ...(typeof options['registry-snapshot'] === 'string'
          ? { expectedSnapshotId: options['registry-snapshot'] }
          : {}),
      }), options.json)
      return
    case 'install':
      if (argument === undefined || options.name === undefined) throw new Error('install needs <spec> and --name <package>')
      print(await manager.stageInstall({
        profile,
        spec: argument,
        packageName: options.name,
        enable: options.enable === true,
        allowScripts: options['allow-scripts'] === true,
      }), options.json)
      return
    case 'update':
      if (argument === undefined || options.name === undefined) throw new Error('update needs <spec> and --name <package>')
      print(await manager.stageUpdate({
        profile,
        spec: argument,
        packageName: options.name,
        allowScripts: options['allow-scripts'] === true,
      }), options.json)
      return
    case 'enable':
    case 'disable':
      if (argument === undefined) throw new Error(`${command} needs <package>`)
      print(await manager.stageEnable(argument, profile, command === 'enable'), options.json)
      return
    case 'uninstall':
      if (argument === undefined) throw new Error('uninstall needs <package>')
      print(await manager.stageUninstall(argument, profile), options.json)
      return
    case 'activate': print(await manager.activate(profile), options.json); return
    case 'confirm': print(await manager.confirm(profile), options.json); return
    case 'ready':
      print(await manager.runtimeReady({
        logicalProfile: profile,
        generation: options.generation,
        token: options.token,
      }), options.json)
      return
    case 'launch': {
      if (argument !== undefined) throw new Error('launch forwards dsh arguments only after --')
      if (forwardedArgs[0] === 'web') {
        throw new Error('launch already selects the Profile; remove the official web alias (use: omdsh launch --profile web --)')
      }
      const readyTimeoutSeconds = options['ready-timeout'] === undefined
        ? undefined
        : Number(options['ready-timeout'])
      if (readyTimeoutSeconds !== undefined && (!Number.isFinite(readyTimeoutSeconds) || readyTimeoutSeconds <= 0)) {
        throw new Error('--ready-timeout must be a positive number of seconds')
      }
      const result = await manager.launch(forwardedArgs, profile, {
        retryPrevious: options['no-retry'] !== true,
        readyTimeoutMs: readyTimeoutSeconds === undefined ? undefined : readyTimeoutSeconds * 1_000,
      })
      if (result.recovered !== null) {
        process.stderr.write(`omdsh: recovered ${result.recovered.from} -> ${result.recovered.to}\n`)
      }
      process.exitCode = result.code
      return
    }
    case 'storage': print(await manager.storage(profile), options.json); return
    case 'cleanup':
      print(await manager.cleanup(profile, {
        keepFailed: options['keep-failed'], apply: options.apply === true,
      }), options.json)
      return
    case 'discard': print(await manager.discard(profile), options.json); return
    default: throw new Error(`unknown command ${JSON.stringify(command)}\n\n${usage()}`)
  }
}

main().catch((error) => {
  process.stderr.write(`omdsh: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
