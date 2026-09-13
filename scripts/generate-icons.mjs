import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const projectRoot = new URL('..', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1')
const buildDir = join(projectRoot, 'build')
const resourcesDir = join(projectRoot, 'resources')
const source = await readFile(join(buildDir, 'icon.svg'))
const installerDialog = await readFile(join(buildDir, 'installer-dialog.svg'))
const installerBanner = await readFile(join(buildDir, 'installer-banner.svg'))

await mkdir(resourcesDir, { recursive: true })

const sizes = [16, 32, 48, 64, 128, 256]
const pngFiles = []

for (const size of sizes) {
  const target = join(buildDir, `.icon-${size}.png`)
  await sharp(source).resize(size, size).png().toFile(target)
  pngFiles.push(target)
}

await sharp(source).resize(512, 512).png().toFile(join(buildDir, 'icon.png'))
await sharp(source).resize(512, 512).png().toFile(join(resourcesDir, 'icon.png'))
await sharp(installerDialog).png().toFile(join(buildDir, 'installer-dialog.png'))
await sharp(installerBanner).png().toFile(join(buildDir, 'installer-banner.png'))
await writeFile(join(buildDir, 'icon.ico'), await pngToIco(pngFiles))
await Promise.all(pngFiles.map((file) => unlink(file)))

console.log('Generated Windows and renderer icons.')
