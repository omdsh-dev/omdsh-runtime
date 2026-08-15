#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { ExtensionManager } from './manager.mjs'
import { RegistryClient } from './registry.mjs'
import { RecipeClient } from './recipes.mjs'
import { WorkshopBridge } from './workshop-bridge.mjs'
import { ProfilePackManager } from './profile-pack.mjs'
import {
  addFixedSourceItem,
  addRegistryItem,
  createPackSource,
  removePackItem,
  updatePackSourceFile,
  writeNewPackSource,
} from './pack-authoring.mjs'

function usage() {
  return `Usage:
  omdsh status [--profile web] [--json]
  omdsh resolve [--profile web]
  omdsh recover [--profile web] [--to generation] [--json]
  omdsh doctor [--profile web] [--json]
  omdsh market install <entry-id> [--profile web] [--enable]
  omdsh recipe plan <recipe-id> [--profile web] [--json]
  omdsh recipe apply <recipe-id> [--profile web] [--registry-snapshot sha256:...] [--json]
  omdsh pack export [--profile web] [--preset standard] [--id name] [--version 1.0.0] [--output file.dshpack]
  omdsh pack init <pack.json> --id name [--version 0.1.0-preview.1] [--preset standard]
  omdsh pack add <pack.json> --release project@version
  omdsh pack add <pack.json> --source-id mine --package @me/plugin --version 0.1.0 --repository https://github.com/me/plugin --ref 40sha --license MIT
  omdsh pack remove <pack.json> <component-id>
  omdsh pack lock <pack.json> --output file.dshpack
  omdsh pack test <pack.json> [--profile web] [--trust-source]
  omdsh pack licenses <pack.json|file.dshpack>
  omdsh pack build <distribution.json|pack.json> [--output file.dshpack]
  omdsh pack sign <file.dshpack> --private-key publisher.pem --key-id id --publisher name --output signed.dshpack [--source https://...]
  omdsh pack inspect <file.dshpack> [--trusted-key publisher.pub] [--json]
  omdsh pack plan <file.dshpack> [--instance name] [--profile web] [--trusted-key publisher.pub] [--require-signature] [--trust-source] [--trust-preset] [--replace-preset]
  omdsh pack diff <old.dshpack> <new.dshpack>
  omdsh pack diff <new.dshpack> --instance name
  omdsh pack install <file.dshpack> [--instance name] [--profile web] [--trusted-key publisher.pub] [--require-signature] [--trust-source] [--trust-preset] [--replace-preset] [--json]
  omdsh pack apply <file.dshpack> [same options as install]
  omdsh pack update <file.dshpack> --instance name [--trusted-key publisher.pub]
  omdsh pack instance <name>
  omdsh pack rollback --instance name
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
    if (['json', 'enable', 'disabled', 'allow-scripts', 'help', 'no-retry', 'apply', 'allow-omitted', 'trust-source', 'trust-preset', 'replace-preset', 'require-signature'].includes(key)) {
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
  const packs = new ProfilePackManager({ manager, registry })
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
    case 'pack': {
      if (!['init', 'add', 'remove', 'lock', 'test', 'licenses', 'export', 'build', 'sign', 'inspect', 'verify', 'plan', 'diff', 'install', 'apply', 'update', 'instance', 'rollback'].includes(argument)) {
        throw new Error('pack needs: init | add | remove | lock | test | licenses | export | build | sign | inspect | verify | plan | install | update | instance | rollback')
      }
      if (argument === 'init') {
        if (nestedArgument === undefined || positionals.length !== 3 || options.id === undefined) {
          throw new Error('pack init needs <pack.json> --id <name>')
        }
        const value = createPackSource({ id: options.id, version: options.version, preset: options.preset })
        await writeNewPackSource(nestedArgument, value)
        print({ schema: 'omdsh-pack-source-write/v1', output: nestedArgument, id: value.id, version: value.version }, true)
        return
      }
      if (argument === 'add') {
        if (nestedArgument === undefined || positionals.length !== 3) throw new Error('pack add needs one pack source file')
        const value = await updatePackSourceFile(nestedArgument, (source) => {
          if (options.release !== undefined) {
            const offset = options.release.lastIndexOf('@')
            if (offset < 1) throw new Error('--release must use project@version')
            return addRegistryItem(source, {
              projectId: options.release.slice(0, offset),
              releaseId: options.release,
              enabled: options.disabled !== true,
            })
          }
          return addFixedSourceItem(source, {
            id: options['source-id'],
            packageName: options.package,
            version: options.version,
            repository: options.repository,
            ref: options.ref,
            license: options.license,
            licenseSource: options['license-source'],
            enabled: options.disabled !== true,
          })
        })
        print({ schema: 'omdsh-pack-source-write/v1', output: nestedArgument, components: value.items.length }, true)
        return
      }
      if (argument === 'remove') {
        if (nestedArgument === undefined || remainingArguments.length !== 1 || positionals.length !== 4) {
          throw new Error('pack remove needs <pack.json> <component-id>')
        }
        const value = await updatePackSourceFile(nestedArgument, source => removePackItem(source, remainingArguments[0]))
        print({ schema: 'omdsh-pack-source-write/v1', output: nestedArgument, components: value.items.length }, true)
        return
      }
      if (argument === 'export') {
        if (nestedArgument !== undefined || positionals.length !== 2) throw new Error('pack export takes no positional file')
        const value = await packs.exportProfile({
          profile,
          preset: options.preset,
          id: options.id,
          version: options.version,
          output: options.output,
          allowOmitted: options['allow-omitted'] === true,
        })
        print(options.output === undefined ? value : {
          schema: 'omdsh-profile-pack-write/v1',
          output: options.output,
          id: value.id,
          version: value.version,
          digest: value.digest,
        }, true)
        return
      }
      if (argument === 'instance') {
        if (nestedArgument === undefined || positionals.length !== 3) throw new Error('pack instance needs one name')
        print(await packs.instance(nestedArgument), true)
        return
      }
      if (argument === 'rollback') {
        const instance = options.instance ?? nestedArgument
        if (instance === undefined || positionals.length > 3) throw new Error('pack rollback needs --instance <name>')
        print(await packs.rollback(instance), true)
        return
      }
      if (argument === 'diff') {
        if (nestedArgument === undefined) throw new Error('pack diff needs a target Profile Pack')
        if (options.instance !== undefined) {
          if (positionals.length !== 3) throw new Error('pack diff with --instance accepts one target Profile Pack')
          print(await packs.diff(nestedArgument, undefined, { instance: options.instance }), true)
        } else {
          if (remainingArguments.length !== 1 || positionals.length !== 4) throw new Error('pack diff needs two Profile Packs')
          print(await packs.diff(nestedArgument, remainingArguments[0]), true)
        }
        return
      }
      if (nestedArgument === undefined || positionals.length !== 3) throw new Error(`pack ${argument} needs one file`)
      if (['build', 'lock'].includes(argument)) {
        const value = await packs.buildDistribution(nestedArgument, { output: options.output })
        print(options.output === undefined ? value : {
          schema: 'omdsh-profile-pack-write/v1',
          output: options.output,
          id: value.id,
          version: value.version,
          digest: value.digest,
        }, true)
        return
      }
      if (argument === 'sign') {
        if (options['private-key'] === undefined || options['key-id'] === undefined
          || options.publisher === undefined || options.output === undefined) {
          throw new Error('pack sign needs --private-key, --key-id, --publisher, and --output')
        }
        const value = await packs.sign(nestedArgument, {
          privateKey: await readFile(options['private-key'], 'utf8'),
          keyId: options['key-id'],
          publisher: options.publisher,
          source: options.source,
          output: options.output,
        })
        print({
          schema: 'omdsh-profile-pack-sign/v1',
          output: options.output,
          id: value.pack.id,
          version: value.pack.version,
          digest: value.pack.digest,
          publisher: value.provenance.publisher,
          keyId: value.signature.keyId,
        }, true)
        return
      }
      const publicKey = options['trusted-key'] === undefined
        ? undefined
        : await readFile(options['trusted-key'], 'utf8')
      if (['inspect', 'verify'].includes(argument)) {
        print(await packs.inspect(nestedArgument, { publicKey, requireSignature: argument === 'verify' || options['require-signature'] === true }), true)
        return
      }
      if (argument === 'plan') {
        print(await packs.plan(nestedArgument, {
          profile,
          instance: options.instance,
          publicKey,
          requireSignature: options['require-signature'] === true,
          trustSource: options['trust-source'] === true,
          trustPreset: options['trust-preset'] === true,
          replacePreset: options['replace-preset'] === true,
        }), true)
        return
      }
      if (argument === 'licenses') {
        let inspection
        try { inspection = await packs.inspect(nestedArgument) } catch {
          inspection = await packs.inspect(await packs.buildDistribution(nestedArgument))
        }
        print({ schema: 'omdsh-pack-licenses/v1', id: inspection.id, version: inspection.version, trust: inspection.trust, licenses: inspection.licenses }, true)
        return
      }
      if (argument === 'test') {
        const pack = await packs.buildDistribution(nestedArgument)
        print(await packs.apply(pack, {
          profile,
          trustSource: options['trust-source'] === true,
          trustPreset: options['trust-preset'] === true,
          replacePreset: options['replace-preset'] === true,
        }), true)
        return
      }
      if (argument === 'update') {
        if (options.instance === undefined) throw new Error('pack update requires --instance <name>')
        print(await packs.update(nestedArgument, {
          instance: options.instance,
          profile,
          publicKey,
          requireSignature: options['require-signature'] === true,
          trustSource: options['trust-source'] === true,
          trustPreset: options['trust-preset'] === true,
          replacePreset: options['replace-preset'] === true,
        }), true)
        return
      }
      print(await packs.apply(nestedArgument, {
        profile,
        instance: options.instance,
        publicKey,
        requireSignature: options['require-signature'] === true,
        trustSource: options['trust-source'] === true,
        trustPreset: options['trust-preset'] === true,
        replacePreset: options['replace-preset'] === true,
      }), true)
      return
    }
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
