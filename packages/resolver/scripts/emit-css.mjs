// Writes dist/rendering.css from the one source of truth, src/rendering.ts.
//
// The stylesheet has to exist twice — as a file a `<link>` or a CSS loader
// can take, and as a string for hosts with no build step — and two hand-kept
// copies of a file whose whole job is to be correct would drift. So the
// string is authored and the file is derived, after tsc, from the built
// module. Plain .mjs and outside both tsconfigs on purpose: `src` has no node
// types, and it may not acquire any.
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const { RENDERING_CSS } = await import('../dist/rendering.js')

await writeFile(
  fileURLToPath(new URL('../dist/rendering.css', import.meta.url)),
  RENDERING_CSS,
  'utf8',
)
