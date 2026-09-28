// Do the constants on npm match the ones this tree builds?
//
//   pnpm --filter @nimiqnames/core build && node scripts/check-npm-release.mjs [version]
//
// `@nimiqnames/core` ships `CONSTANTS` to integrators, and a box rollout
// does not touch npm: the launch freeze moved LAUNCH_HEIGHT, FEE_BASE and the
// four §3 addresses on 2026-09-22 and `0.1.0`, published eight days earlier,
// kept the old ones until 2026-09-28. Nothing failed, because resolution
// never reads them. A transaction built with that package would have paid an
// address the registry does not read.
//
// Compares `dist/constants.js` in npm's `latest` tarball (or the version
// named) with the local build, byte for byte. Exit 0 when they agree, 1
// when a release is owed, 2 when the question could not be asked. Reads
// the registry and nothing else.
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = '@nimiqnames/core'
const FILE = 'dist/constants.js'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** One file out of a tar archive: 512-byte headers, the name at 0 and the octal size at 124. */
function fromTar(archive, wanted) {
  for (let at = 0; at + 512 <= archive.length; ) {
    const name = archive.subarray(at, at + 100).toString('utf8').replace(/\0.*$/, '')
    if (name === '') return null
    const size = parseInt(archive.subarray(at + 124, at + 136).toString('utf8').replace(/\0.*$/, '').trim(), 8)
    if (name === wanted) return archive.subarray(at + 512, at + 512 + size)
    at += 512 + Math.ceil(size / 512) * 512
  }
  return null
}

const fail = (code, message) => {
  console.error(message)
  process.exit(code)
}

let local
try {
  local = readFileSync(join(root, 'packages/core', FILE))
} catch {
  fail(2, `no local build at packages/core/${FILE}: build core first`)
}

let published, version
try {
  const packument = await (await fetch(`https://registry.npmjs.org/${PACKAGE.replace('/', '%2f')}`)).json()
  version = process.argv[2] ?? packument['dist-tags'].latest
  const tarball = await fetch(packument.versions[version].dist.tarball)
  published = fromTar(gunzipSync(Buffer.from(await tarball.arrayBuffer())), `package/${FILE}`)
} catch (error) {
  fail(2, `could not read ${PACKAGE} from the registry: ${error instanceof Error ? error.message : String(error)}`)
}
if (published === null) fail(2, `${PACKAGE}@${version} has no ${FILE}`)

if (published.equals(local)) {
  console.log(`${PACKAGE}@${version} carries the constants this tree builds`)
  process.exit(0)
}

const lines = (buffer) => buffer.toString('utf8').split('\n')
const theirs = new Set(lines(published))
const moved = lines(local).filter((line) => !theirs.has(line) && /^\s*[A-Z_]+:/.test(line))
console.error(`${PACKAGE}@${version} on npm differs from this tree. A release is owed (docs/runbooks/release.md).`)
for (const line of moved.slice(0, 12)) console.error(`  here: ${line.trim()}`)
process.exit(1)
