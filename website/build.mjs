import {build} from 'esbuild'
import {cp, mkdir, rm} from 'node:fs/promises'

const OUT = 'dist'

await rm(OUT, {recursive: true, force: true})
await mkdir(OUT, {recursive: true})

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  outfile: `${OUT}/bundle.js`,
  sourcemap: false,
  logLevel: 'info',
})

await cp('src/index.html', `${OUT}/index.html`)
await cp('src/style.css', `${OUT}/style.css`)

console.log(`built ${OUT}/`)
