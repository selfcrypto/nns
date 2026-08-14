import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The reader ships to the mini app, so its transitive **runtime** import
 * graph must stay browser-safe: no viem, no node builtins, no `fetch` edge
 * modules that hold credentials, and no key material anywhere. This test
 * walks the graph from `reader.ts` over the source files and fails when a
 * forbidden module becomes reachable — the seam that keeps "browser-safe"
 * a property rather than a hope.
 *
 * Type-only imports are skipped: they are erased at compile time and pull
 * no code into a bundle.
 */

const src = (name: string): string => fileURLToPath(new URL(`./${name}`, import.meta.url))

/** Static runtime imports of one module: relative and bare, `import type` excluded. */
function runtimeImports(file: string): readonly string[] {
  const source = readFileSync(src(file), 'utf8')
  const specifiers: string[] = []
  // Both `import x from 'y'` and bare `import 'y'`; `import type` carries no runtime code.
  for (const match of source.matchAll(/^import\s+(?!type\s)(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm)) {
    specifiers.push(match[1]!)
  }
  return specifiers
}

/** The graph a browser bundle of `entry` would contain, package-local part. */
function walk(entry: string): { local: Set<string>; external: Set<string> } {
  const local = new Set<string>()
  const external = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (local.has(file)) continue
    local.add(file)
    for (const specifier of runtimeImports(file)) {
      if (specifier.startsWith('./')) {
        queue.push(specifier.slice(2).replace(/\.js$/, '.ts'))
      } else {
        external.add(specifier)
      }
    }
  }
  return { local, external }
}

describe('the reader is browser-safe by import graph', () => {
  const graph = walk('reader.ts')

  it('never reaches viem, a node builtin, or a credentialed edge module', () => {
    for (const specifier of graph.external) {
      expect(specifier, `external import ${specifier}`).not.toMatch(/^viem/)
      expect(specifier, `external import ${specifier}`).not.toMatch(/^node:/)
    }
    // The modules that must stay out of a mini-app bundle: the viem/key
    // edge, the publisher's credentialed fetch edges, and the Node-only
    // compiler tooling.
    for (const forbidden of [
      'viem-rpc.ts',
      'ipfs.ts',
      'filebase.ts',
      'nns-api.ts',
      'compile.ts',
      'compile-cli.ts',
      'deploy-cli.ts',
      'publish-cli.ts',
      'env.ts',
    ]) {
      expect(graph.local.has(forbidden), `reader graph contains ${forbidden}`).toBe(false)
    }
  })

  it('reaches only the pure allowlist', () => {
    // Additions here are deliberate decisions, not drift: every module on
    // this list must itself be browser-safe, and `publish.ts` qualifies
    // because its edges are injected — it imports its services as types
    // only, which the walker above rightly ignores.
    // `chain.ts` is absent although everything uses its types: every import
    // of it is `import type`, so it costs a bundle nothing — asserted below.
    expect([...graph.local].sort()).toEqual(['artifact.ts', 'deploy.ts', 'publish.ts', 'reader.ts'].sort())
    for (const specifier of graph.external) {
      expect(specifier).toMatch(/^@nns\/core$|^@noble\/hashes\//)
    }
  })

  it('@nns/core is itself free of node builtins on the runtime paths', () => {
    // The reader pulls core; core's one Node-touching module is the test
    // fixture, which index.ts must never reach.
    const coreDir = fileURLToPath(new URL('../../core/src/', import.meta.url))
    const walkCore = (file: string, seen: Set<string>): void => {
      if (seen.has(file)) return
      seen.add(file)
      const source = readFileSync(`${coreDir}${file}`, 'utf8')
      for (const match of source.matchAll(/^import\s+(?!type\s)(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm)) {
        const specifier = match[1]!
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/^node:/)
        if (specifier.startsWith('./')) walkCore(specifier.slice(2).replace(/\.js$/, '.ts'), seen)
      }
    }
    walkCore('index.ts', new Set())
  })

  it('chain.ts stays types-only, so it costs a bundle nothing', () => {
    expect(runtimeImports('chain.ts')).toEqual([])
  })
})
