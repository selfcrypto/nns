import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The reader ships to the mini app, so its transitive **runtime** import
 * graph must stay browser-safe: no viem, no node builtins, no `fetch` edge
 * modules that hold credentials, and no key material anywhere. This test
 * walks the graph over the source files and fails when a forbidden module
 * becomes reachable — the seam that keeps "browser-safe" a property rather
 * than a hope.
 *
 * It walks from **two** entry points, and the second is the one that makes
 * the property load-bearing: `packages/resolver` consumes the reader
 * (`@nimiqnames/anchor/reader`) so that §8.5 #1 exists exactly once, and the
 * resolver is the package other apps embed. The walk follows that edge
 * across the package boundary, so the composite bundle an integrator would
 * get is what gets checked, not this package's half of it. The test lives
 * here rather than in `packages/resolver` because the resolver deliberately
 * configures **no node types** — it cannot read its own source tree — and
 * because the promise being guarded is this package's.
 *
 * Type-only imports are skipped: they are erased at compile time and pull
 * no code into a bundle.
 */

const dirOf = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

const ANCHOR_SRC = dirOf('./')
const RESOLVER_SRC = dirOf('../../resolver/src/')
const CORE_SRC = dirOf('../../core/src/')

/** A file, addressed as `package:file.ts` so two packages' modules never collide. */
interface Module {
  readonly pkg: string
  readonly dir: string
  readonly file: string
}

/** The workspace entry points a bare specifier can resolve to. Anything else is external. */
const WORKSPACE_ENTRIES: Record<string, Module> = {
  '@nimiqnames/anchor/reader': { pkg: 'anchor', dir: ANCHOR_SRC, file: 'reader.ts' },
}

/**
 * Every specifier one module pulls at **runtime**.
 *
 * `import x from 'y'`, bare `import 'y'`, and **`export … from 'y'`** — the
 * last of which is not a detail: a package entry point is mostly re-exports,
 * and under `verbatimModuleSyntax` they are emitted verbatim, so a bundler
 * follows them exactly like an import. A walker that only matched `import`
 * would traverse `index.ts` and find nothing, then pass while asserting
 * nothing (which is what this one did until the resolver edge was added, and
 * why `@nimiqnames/core`'s check below was vacuous).
 *
 * `import type` / `export type` carry no runtime code and are skipped.
 */
function runtimeImports(module: Module): readonly string[] {
  const source = readFileSync(`${module.dir}${module.file}`, 'utf8')
  const specifiers: string[] = []
  for (const match of source.matchAll(/^(?:import|export)\s+(?!type\s)(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm)) {
    specifiers.push(match[1]!)
  }
  return specifiers
}

/**
 * The graph a browser bundle of `entry` would contain.
 *
 * `local` holds every source file reached, as `package:file.ts`. `external`
 * holds bare specifiers that leave the workspace — a workspace entry in
 * {@link WORKSPACE_ENTRIES} is recorded there *and* followed, since it is
 * both a dependency edge worth asserting on and code that lands in the
 * bundle.
 */
function walk(entry: Module): { local: Set<string>; external: Set<string> } {
  const local = new Set<string>()
  const external = new Set<string>()
  const queue: Module[] = [entry]
  while (queue.length > 0) {
    const module = queue.pop()!
    const key = `${module.pkg}:${module.file}`
    if (local.has(key)) continue
    local.add(key)
    for (const specifier of runtimeImports(module)) {
      if (specifier.startsWith('./')) {
        queue.push({ ...module, file: specifier.slice(2).replace(/\.js$/, '.ts') })
        continue
      }
      external.add(specifier)
      const crossed = WORKSPACE_ENTRIES[specifier]
      if (crossed !== undefined) queue.push(crossed)
    }
  }
  return { local, external }
}

const READER: Module = { pkg: 'anchor', dir: ANCHOR_SRC, file: 'reader.ts' }
const RESOLVER: Module = { pkg: 'resolver', dir: RESOLVER_SRC, file: 'index.ts' }

/** The modules that must stay out of a mini-app bundle: the viem/key edge, the publisher's credentialed fetch edges, and the Node-only compiler tooling. */
const FORBIDDEN = [
  'viem-rpc.ts',
  'ipfs.ts',
  'filebase.ts',
  'nns-api.ts',
  'compile.ts',
  'compile-cli.ts',
  'deploy-cli.ts',
  'publish-cli.ts',
  'env.ts',
]

/** Every module of this package the reader is allowed to pull in. Additions are decisions, not drift. */
const READER_GRAPH = ['anchor:artifact.ts', 'anchor:deploy.ts', 'anchor:publish.ts', 'anchor:reader.ts']

describe('the reader is browser-safe by import graph', () => {
  const graph = walk(READER)

  it('never reaches viem, a node builtin, or a credentialed edge module', () => {
    for (const specifier of graph.external) {
      expect(specifier, `external import ${specifier}`).not.toMatch(/^viem/)
      expect(specifier, `external import ${specifier}`).not.toMatch(/^node:/)
    }
    for (const forbidden of FORBIDDEN) {
      expect(graph.local.has(`anchor:${forbidden}`), `reader graph contains ${forbidden}`).toBe(false)
    }
  })

  it('reaches only the pure allowlist', () => {
    // Every module on this list must itself be browser-safe, and `publish.ts`
    // qualifies because its edges are injected — it imports its services as
    // types only, which the walker above rightly ignores.
    // `chain.ts` is absent although everything uses its types: every import
    // of it is `import type`, so it costs a bundle nothing — asserted below.
    expect([...graph.local].sort()).toEqual([...READER_GRAPH].sort())
    for (const specifier of graph.external) {
      expect(specifier).toMatch(/^@nimiqnames\/core$|^@noble\/hashes\//)
    }
  })

  it('@nimiqnames/core is itself free of node builtins on the runtime paths', () => {
    // The reader pulls core; core's one Node-touching module is the test
    // fixture, which index.ts must never reach.
    const walkCore = (file: string, seen: Set<string>): void => {
      if (seen.has(file)) return
      seen.add(file)
      const source = readFileSync(`${CORE_SRC}${file}`, 'utf8')
      for (const match of source.matchAll(/^import\s+(?!type\s)(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm)) {
        const specifier = match[1]!
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/^node:/)
        if (specifier.startsWith('./')) walkCore(specifier.slice(2).replace(/\.js$/, '.ts'), seen)
      }
    }
    walkCore('index.ts', new Set())
  })

  it('chain.ts stays types-only, so it costs a bundle nothing', () => {
    expect(runtimeImports({ pkg: 'anchor', dir: ANCHOR_SRC, file: 'chain.ts' })).toEqual([])
  })
})

describe('the edge `@nimiqnames/resolver` → `@nimiqnames/anchor/reader` keeps that property', () => {
  const graph = walk(RESOLVER)

  it('consumes the reader rather than reimplementing §8.5 #1', () => {
    // The assertion is deliberately positive. If this edge disappears, either
    // the resolver stopped checking anchors or it grew a second implementation
    // of a rule that must exist once — and both are worth failing over.
    expect([...graph.external]).toContain('@nimiqnames/anchor/reader')
  })

  it('imports the reader by its subpath, never the package root', () => {
    // `@nimiqnames/anchor` resolves to `index.ts`, which is fine today and is not
    // the contract: the subpath is what the browser-safety walk covers.
    expect([...graph.external]).not.toContain('@nimiqnames/anchor')
  })

  it('pulls no viem, no node builtin, and no credentialed module across the edge', () => {
    for (const specifier of graph.external) {
      expect(specifier, `external import ${specifier}`).not.toMatch(/^viem/)
      expect(specifier, `external import ${specifier}`).not.toMatch(/^node:/)
    }
    for (const forbidden of FORBIDDEN) {
      expect(graph.local.has(`anchor:${forbidden}`), `resolver graph contains ${forbidden}`).toBe(false)
    }
  })

  it('pulls in exactly the reader’s own graph and nothing else of this package', () => {
    const fromAnchor = [...graph.local].filter((key) => key.startsWith('anchor:')).sort()
    expect(fromAnchor).toEqual([...READER_GRAPH].sort())
  })

  it('leaves the workspace only for @nimiqnames/core, @noble/hashes and the reader', () => {
    for (const specifier of graph.external) {
      expect(specifier).toMatch(/^@nimiqnames\/core$|^@nimiqnames\/anchor\/reader$|^@noble\/hashes\//)
    }
  })
})
