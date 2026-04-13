/**
 * Rasterizes build/icon.svg → build/icon.png for Electron window + electron-builder.
 */
import { readFileSync, mkdirSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const svgPath = path.join(root, 'build', 'icon.svg')
const outPath = path.join(root, 'build', 'icon.png')

async function main() {
  if (!existsSync(svgPath)) {
    console.warn('generate-app-icon: missing', svgPath)
    process.exit(0)
  }
  const { default: sharp } = await import('sharp')
  const svg = readFileSync(svgPath)
  mkdirSync(path.dirname(outPath), { recursive: true })
  await sharp(svg).resize(512, 512).png({ compressionLevel: 9 }).toFile(outPath)
  console.log('generate-app-icon: wrote', outPath)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
