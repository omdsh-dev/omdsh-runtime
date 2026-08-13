import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export async function atomicWriteText(filename, value, mode = 0o600) {
  const directory = dirname(filename)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${basename(filename)}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', mode)
    await handle.writeFile(value, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, filename)
  } finally {
    await handle?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function atomicWriteJson(filename, value, mode = 0o600) {
  await atomicWriteText(filename, `${JSON.stringify(value, null, 2)}\n`, mode)
}

