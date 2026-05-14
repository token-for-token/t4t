/**
 * Bundle src/index.ts → dist/index.js with esbuild.
 *
 * Why bundle? The project is ESM (`"type": "module"`) but TS emits extensionless
 * relative imports under `moduleResolution: "Bundler"`. Node's ESM resolver
 * requires explicit `.js` extensions, so `node dist/index.js` ERR_MODULE_NOT_FOUND.
 * Bundling collapses all relative imports into one file; node_modules stay
 * external and are resolved at runtime by Node's normal resolver.
 */
import {build} from 'esbuild'
import {createRequire} from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('./package.json')

// Everything in package dependencies stays external — they're installed in
// node_modules and resolved at runtime. Native modules (better-sqlite3) MUST
// be external; viem/express/pino are external for simplicity and smaller bundle.
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  outfile: 'dist/index.js',
  sourcemap: false,
  external,
  // ESM build of CommonJS interop: keep Node's createRequire visible.
  banner: {js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);'},
  logLevel: 'info',
})
