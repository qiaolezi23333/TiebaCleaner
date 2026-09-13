import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const projectRoot = new URL('..', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1')
const releaseDir = join(projectRoot, 'release')
const packageMetadata = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const requestedExtensions = process.argv.slice(2)
const extensions = requestedExtensions.length > 0 ? requestedExtensions : ['.msi']
const files = (await readdir(releaseDir))
  .filter(
    (name) =>
      name.includes(`-${packageMetadata.version}-`) &&
      extensions.some((extension) => name.endsWith(extension))
  )
  .sort()

if (files.length === 0) {
  throw new Error(`No release artifact ending in ${extensions.join(', ')} was found in release/.`)
}

const lines = []
for (const file of files) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(join(releaseDir, file))) {
    hash.update(chunk)
  }
  lines.push(`${hash.digest('hex')}  ${basename(file)}`)
}

await writeFile(join(releaseDir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8')
console.log('Wrote release/SHA256SUMS.txt')
