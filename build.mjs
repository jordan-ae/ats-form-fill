// The in-page bundle: one self-contained script that leaves `__arkooFill` on
// the page's global, for callers that can only pass strings across
// (Playwright's addInitScript, an extension's executeScript).
import { build } from 'esbuild'

await build({
  entryPoints: ['src/inject.ts'],
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  outfile: 'dist/fill.iife.js',
  logLevel: 'info',
})
