import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  addFixedSourceItem,
  addRegistryItem,
  createPackSource,
  removePackItem,
} from '../dist/pack-authoring.mjs'

const execFileAsync = promisify(execFile)

test('authors a small Pack source with Registry and author-owned components', () => {
  let source = createPackSource({ id: 'research-kit', preset: 'code' })
  source = addRegistryItem(source, { projectId: 'sample', releaseId: 'sample@1.2.3' })
  source = addFixedSourceItem(source, {
    id: 'mine',
    packageName: '@example/mine',
    version: '0.1.0',
    repository: 'https://github.com/example/mine',
    ref: 'a'.repeat(40),
    license: 'MIT',
    licenseSource: 'package-manifest',
  })
  assert.equal(source.items.length, 2)
  assert.equal(source.items[1].install.spec, `github:example/mine#${'a'.repeat(40)}`)
  source = removePackItem(source, 'sample')
  assert.deepEqual(source.items.map(item => item.id), ['mine'])
})

test('rejects floating sources and duplicate component identities', () => {
  let source = createPackSource({ id: 'safe-kit' })
  assert.throws(() => addFixedSourceItem(source, {
    id: 'mine', packageName: '@example/mine', version: '0.1.0',
    repository: 'https://github.com/example/mine', ref: 'main', license: 'MIT',
  }), /commit/)
  assert.throws(() => addFixedSourceItem(source, {
    id: 'mine', packageName: '@example/mine', version: '0.1.0',
    repository: 'https://github.com/example/mine', ref: 'a'.repeat(40), license: 'MIT Apache-2.0',
  }), /SPDX expression/)
  source = addRegistryItem(source, { projectId: 'sample', releaseId: 'sample@1.2.3' })
  assert.throws(() => addRegistryItem(source, { projectId: 'sample', releaseId: 'sample@2.0.0' }), /already contains/)
})

test('CLI authors, inventories, and locks an author-owned Pack end to end', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'omdsh-pack-authoring-cli-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'profiles'), { recursive: true })
  const dsh = join(home, 'fake-dsh')
  await writeFile(dsh, '#!/bin/sh\nprintf "0.1.0-rc.6\\n"\n', { mode: 0o755 })
  const source = join(home, 'my-pack.json')
  const output = join(home, 'my-pack.dshpack')
  const ref = 'd'.repeat(40)
  const cli = new URL('../dist/cli.mjs', import.meta.url)

  await execFileAsync(process.execPath, [cli.pathname, 'pack', 'init', source, '--id', 'my-pack', '--preset', 'code'])
  await execFileAsync(process.execPath, [
    cli.pathname, 'pack', 'add', source,
    '--source-id', 'mine', '--package', '@example/mine', '--version', '0.1.0',
    '--repository', 'https://github.com/example/mine', '--ref', ref, '--license', 'Apache-2.0',
  ])

  const inventory = JSON.parse((await execFileAsync(process.execPath, [
    cli.pathname, 'pack', 'licenses', source, '--home', home, '--dsh', dsh,
  ])).stdout)
  assert.equal(inventory.trust.level, 'experimental-fixed-source')
  assert.equal(inventory.licenses[0].expression, 'Apache-2.0')
  assert.equal(inventory.licenses[0].source, 'author-declared')

  await execFileAsync(process.execPath, [
    cli.pathname, 'pack', 'lock', source, '--home', home, '--dsh', dsh, '--output', output,
  ])
  const locked = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(locked.sourcePlugins[0].source.ref, ref)
  assert.equal(locked.sourcePlugins[0].install.spec, `github:example/mine#${ref}`)
})
