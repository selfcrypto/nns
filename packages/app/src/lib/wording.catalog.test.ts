/**
 * The wording catalog: every user-visible string in one XML file, generated
 * from `wording.ts` and checked against it on every run.
 *
 * Rico, 2026-09-15: *"Maybe we could use an XML to collect the expressions
 * used, so it can be easily edited and placed, and also translated."* This is
 * the review-and-handoff half of that. `wording.ts` stays the source, because
 * a third of these strings read a constant — `XFER_TIMELOCK`, `OFFER_
 * IRREVOCABLE`, `MAX_DATA_BYTES` — and every wording bug found on the live
 * site so far has been a number typed in where a constant belonged. A catalog
 * that invited retyping them would be the same bug with better tooling.
 *
 * The loop it does support: read `wording.xml`, edit the sentences you want
 * changed, and the edit gets applied to `wording.ts` — at which point this
 * test agrees again. **A failure here is not a broken build, it is either an
 * edit waiting to be applied or a new string missing from the catalog**, and
 * the message says which. Regenerate with:
 *
 *     UPDATE_WORDING_XML=1 npx vitest run src/lib/wording.catalog.test.ts
 *
 * Parameters appear as `{name}`. Constants appear as the value they hold in
 * **this** era, which is why the check is skipped in a compressed one: the
 * committed catalog is mainnet's, and a tempo fork renders ~5 min where the
 * file says ~2.4 h. That is the catalog being right, not drifting.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import * as W from './wording'
import { isCompressedEra } from './wording'

const XML = new URL('../../wording.xml', import.meta.url)
const SOURCE = new URL('./wording.ts', import.meta.url)

/** A plausible argument per parameter name, so a function can be rendered at all. */
const argFor = (name: string, hasDefault: boolean): unknown => {
  // A parameter with a default is left alone: `termChoiceLabel(blocks =
  // CONSTANTS.TERM_LENGTH)` renders "1 year" on its own and "1 minutes" if
  // you hand it a number you invented.
  if (hasDefault) return undefined
  const n = name.toLowerCase()
  if (/^(set|subject|record|result|quorum|info|reply|replies|warnings|resolver|offer|auction|params|fees)/.test(n)) return undefined
  if (/blocks|height|ms$|count|len|bp$|used|budget|more|left|index|days/.test(n)) return 2
  if (/^(dark|open|netofburn|full|lifetime)/.test(n)) return false
  return `{${name}}`
}

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Export name to the `// ── … ──` heading it sits under, so the file has shape. */
function groups(): Map<string, string> {
  const out = new Map<string, string>()
  let heading = 'General'
  for (const line of readFileSync(SOURCE, 'utf8').split('\n')) {
    const h = /^(?:\/\/|\/\*) ─+ (.+?) ─+/.exec(line)
    if (h?.[1] !== undefined) heading = h[1].trim()
    const d = /^export (?:const|function) (\w+)/.exec(line)
    if (d?.[1] !== undefined && !out.has(d[1])) out.set(d[1], heading)
  }
  return out
}

interface Row { readonly id: string; readonly group: string; readonly params: readonly string[]; readonly text: string }

function rows(): Row[] {
  const group = groups()
  const order = [...group.keys()]
  const found: Row[] = []
  const add = (id: string, params: readonly string[], text: string) => {
    const base = id.split('.')[0]!
    found.push({ id, group: group.get(base) ?? 'General', params, text })
  }
  for (const [id, value] of Object.entries(W)) {
    if (typeof value === 'string') add(id, [], value)
    else if (typeof value === 'function') {
      const src = value.toString()
      const m = /^\s*(?:function\s*\w*\s*)?\(([^)]*)\)/.exec(src) ?? /^\s*(\w+)\s*=>/.exec(src)
      const declared = (m?.[1] ?? '')
        .split(',')
        .map((p) => ({ name: p.trim().split(/[:=]/)[0]!.trim(), hasDefault: p.includes('=') }))
        .filter((p) => p.name !== '' && /^[A-Za-z_]\w*$/.test(p.name))
      const params = declared.map((p) => p.name)
      let out: unknown
      try {
        out = (value as (...a: unknown[]) => unknown)(...declared.map((p) => argFor(p.name, p.hasDefault)))
      } catch {
        continue // a shape-taking helper, not a sentence
      }
      if (typeof out === 'string') add(id, params, out)
      else if (Array.isArray(out) && out.every((x) => typeof x === 'string')) add(id, params, (out as string[]).join(' / '))
    } else if (value !== null && typeof value === 'object' && !(value instanceof Set)) {
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'string')
      // `WARNING_TONE` and its kind map a code to a code; nothing in them is
      // read by a person, so they are not wording.
      if (entries.length > 0 && entries.every(([, v]) => /^[a-z][a-z-]*$/.test(v as string))) continue
      for (const [k, v] of entries) add(`${id}.${k}`, [], v as string)
    }
  }
  const rank = (r: Row) => {
    const i = order.indexOf(r.id.split('.')[0]!)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  return found.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
}

function render(): string {
  const all = rows()
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!--',
    '  Every user-visible string in the Nimiq Names app, generated from',
    '  src/lib/wording.ts by src/lib/wording.catalog.test.ts.',
    '',
    '  Edit a sentence here to propose a change; it is applied to wording.ts,',
    '  which stays the source of truth. {name} is a value filled in at runtime.',
    '  A number in the text comes from a constant in @nimiqnames/core and moves',
    '  with the era, so translate around it rather than typing it in.',
    '-->',
    '<wording>',
  ]
  let current: string | null = null
  for (const row of all) {
    if (row.group !== current) {
      if (current !== null) out.push('  </group>')
      out.push(`  <group name="${escape(row.group)}">`)
      current = row.group
    }
    const params = row.params.length === 0 ? '' : ` params="${escape(row.params.join(' '))}"`
    out.push(`    <string id="${escape(row.id)}"${params}>${escape(row.text)}</string>`)
  }
  if (current !== null) out.push('  </group>')
  out.push('</wording>', '')
  return out.join('\n')
}

describe('the wording catalog', () => {
  it('holds every string in wording.ts, and nothing it does not', () => {
    const built = render()
    if (process.env['UPDATE_WORDING_XML'] === '1') {
      writeFileSync(XML, built)
      return
    }
    // A compressed era renders its own constants, so the mainnet catalog is
    // correctly different there. Ids are still checked below.
    if (isCompressedEra()) {
      const ids = (s: string): string[] => [...s.matchAll(/<string id="([^"]+)"/g)].map((m) => m[1]!)
      expect(ids(built)).toEqual(ids(readFileSync(XML, 'utf8')))
      return
    }
    expect(built).toBe(readFileSync(XML, 'utf8'))
  })
})
