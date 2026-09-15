/**
 * `packages/app/docs/*.md` → the `virtual:docs` module the Docs screen reads.
 *
 * The Node half of the docs build step: read the directory, fill every
 * `{{format:KEY}}` from `CONSTANTS` (`src/lib/docsFormat.ts`, which is where
 * the testable logic lives) and convert the Markdown with `marked`. It runs
 * in `vite build` and in `vite dev`; **`marked` never reaches the bundle** —
 * what ships is the HTML string, the same relationship `solc` has to the
 * anchor contract.
 *
 * A *virtual* module rather than a generated file: nothing is committed,
 * nothing is gitignored, and `dev`, `build` and a fresh clone all work with
 * no extra step. `src/virtual-docs.d.ts` is what `tsc` reads instead.
 *
 * It fails the build, never degrades: an unknown placeholder, a page in
 * `index.md` with no file, a file no `index.md` entry lists, or a cross-link
 * to a slug that does not exist. Every one of those ships a broken page to a
 * reader if it is allowed through, and all four are cheap to catch here.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Marked, type Tokens } from 'marked'
import type { Plugin } from 'vite'

import { fillPlaceholders, headingId, parseDocIndex } from '../src/lib/docsFormat'

const VIRTUAL_ID = 'virtual:docs'
const RESOLVED_ID = '\0virtual:docs'

const DOCS_DIR = fileURLToPath(new URL('../docs', import.meta.url))

/** `index.md` fixes the order; `README.md` documents the directory for whoever edits it. */
const NOT_A_PAGE = new Set(['index.md', 'README.md'])

interface Heading {
  readonly id: string
  readonly text: string
}

/**
 * The Markdown converter for one page. `headings` fills as the page renders:
 * every `##` gets an `id` so `#/docs/<slug>/<id>` can land on it, and the
 * screen lists those ids under the page in the sidebar. A repeated heading
 * gets a numbered id rather than a duplicate, which two anchors would be.
 */
function renderer(slugs: ReadonlySet<string>, headings: Heading[]): Marked {
  const seen = new Set<string>()
  return new Marked({
    renderer: {
      heading(token: Tokens.Heading): string {
        const text = this.parser.parseInline(token.tokens)
        if (token.depth === 1) return `<h1>${text}</h1>\n`
        const base = headingId(token.text)
        let id = base
        for (let n = 2; seen.has(id); n += 1) id = `${base}-${n}`
        seen.add(id)
        if (token.depth === 2) headings.push({ id, text: token.text.replace(/[\x60*_]/g, '') })
        return `<h${token.depth} id="doc-${id}">${text}</h${token.depth}>\n`
      },
      /**
       * Every cross-link in these pages is a bare slug (`[Prices](prices)`),
       * because the pages are the app's own and the app's routes are the
       * hash. An absolute URL is left alone and opens out; anything else is
       * a slug, and an unknown one fails the build rather than rendering a
       * link that 404s inside the app.
       */
      link(token: Tokens.Link): string {
        const text = this.parser.parseInline(token.tokens)
        const title = token.title === null || token.title === undefined ? '' : ` title="${token.title}"`
        if (/^[a-z][a-z0-9+.-]*:/i.test(token.href) || token.href.startsWith('#')) {
          const external = token.href.startsWith('#') ? '' : ' target="_blank" rel="noopener noreferrer"'
          return `<a href="${token.href}"${title}${external}>${text}</a>`
        }
        if (!slugs.has(token.href)) throw new Error(`docs: link to "${token.href}", which is not a page in index.md`)
        return `<a href="#/docs/${token.href}"${title}>${text}</a>`
      },
    },
  })
}

interface BuiltPage {
  readonly slug: string
  readonly title: string
  readonly section: string
  readonly headings: readonly Heading[]
  readonly html: string
}

export function buildDocs(): readonly BuiltPage[] {
  const index = parseDocIndex(readFileSync(join(DOCS_DIR, 'index.md'), 'utf8'))
  const slugs = new Set(index.map((page) => page.slug))

  const orphans = readdirSync(DOCS_DIR)
    .filter((file) => file.endsWith('.md') && !NOT_A_PAGE.has(file) && !slugs.has(file.slice(0, -3)))
  if (orphans.length > 0) throw new Error(`docs: ${orphans.join(', ')} — not listed in index.md, so unreachable`)

  return index.map((page) => {
    const source = readFileSync(join(DOCS_DIR, `${page.slug}.md`), 'utf8')
    const headings: Heading[] = []
    const html = renderer(slugs, headings).parse(fillPlaceholders(source), { async: false })
    // A phone cannot fit the reference tables, and a table is the one block
    // that must scroll sideways on its own rather than widen the page. The
    // wrapper is an element, not a class, because the screen's CSS module
    // would hash a class the build step wrote.
    const wrapped = html.replace(/<table>/g, '<figure><table>').replace(/<\/table>/g, '</table></figure>')
    return { slug: page.slug, title: page.title, section: page.section, headings, html: wrapped }
  })
}

export function docsPlugin(): Plugin {
  return {
    name: 'nns-docs',
    resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_ID : null),
    load(id) {
      if (id !== RESOLVED_ID) return null
      for (const file of readdirSync(DOCS_DIR)) {
        if (file.endsWith('.md')) this.addWatchFile(join(DOCS_DIR, file))
      }
      return `export const DOC_PAGES = ${JSON.stringify(buildDocs())}\n`
    },
    configureServer(server) {
      // Editing a page reloads it. The virtual module holds every page, so
      // there is nothing finer to invalidate, and a docs edit is not a state
      // the dev session needs to keep.
      server.watcher.add(DOCS_DIR)
      const reload = (path: string): void => {
        if (!path.startsWith(DOCS_DIR) || !path.endsWith('.md')) return
        const module = server.moduleGraph.getModuleById(RESOLVED_ID)
        if (module !== undefined) server.moduleGraph.invalidateModule(module)
        server.ws.send({ type: 'full-reload' })
      }
      server.watcher.on('change', reload)
      server.watcher.on('add', reload)
    },
  }
}
