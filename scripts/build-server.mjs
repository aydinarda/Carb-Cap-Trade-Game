import { build } from 'esbuild'

await build({
  entryPoints: ['server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: 'dist/server/index.js',
})
console.log('server bundled → dist/server/index.js')
