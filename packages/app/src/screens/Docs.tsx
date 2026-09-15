/**
 * The documentation, `#/docs/<slug>` and `#/docs/<slug>/<heading>`.
 *
 * The pages are `packages/app/docs/*.md`, already HTML by the time this
 * renders: `plugins/docs.ts` fills the `{{format:KEY}}` placeholders from
 * `CONSTANTS`, converts the Markdown at build time and gives every `##` an
 * id, so nothing here parses anything and no Markdown library reaches the
 * bundle.
 *
 * `index.md` is the whole navigation: its `## Section` headings group the
 * sidebar, its flat order is the previous/next pair at the foot, and the
 * page being read lists its own `##` headings under itself as subsection
 * links. The sidebar is a column beside the article where there is room for
 * one and a disclosure above it on a phone, where a strip of twenty page
 * titles would be unreadable. Cross-links inside a page are ordinary
 * `#/docs/<slug>` anchors: the hash is the route, so `App.tsx`'s
 * `hashchange` listener is all the handling they need.
 */

import { useEffect, useState } from 'react'

import { DOC_PAGES } from 'virtual:docs'

import { groupDocPages } from '../lib/docsFormat'
import styles from './docs.module.css'

const SECTIONS = groupDocPages(DOC_PAGES)

/** `slug/heading` → the two halves; a bare slug has no heading. */
function splitParam(param: string | null): { readonly slug: string | null; readonly heading: string | null } {
  if (param === null) return { slug: null, heading: null }
  const slash = param.indexOf('/')
  if (slash === -1) return { slug: param, heading: null }
  return { slug: param.slice(0, slash), heading: param.slice(slash + 1) || null }
}

export function DocsScreen({ slug: param }: { readonly slug: string | null }) {
  const { slug, heading } = splitParam(param)
  const current = slug === null ? DOC_PAGES[0] : DOC_PAGES.find((page) => page.slug === slug)
  const [open, setOpen] = useState(false)

  // A page is a page: arriving at one from another must start at its top,
  // which a hash change inside the same screen does not do by itself. A
  // subsection route lands on its heading instead; the heading's own
  // `scroll-margin-top` keeps it clear of the sticky masthead. Either way the
  // phone menu closes, since the tap that got here was made inside it.
  useEffect(() => {
    setOpen(false)
    const target = heading === null ? null : document.getElementById(`doc-${heading}`)
    if (target === null) window.scrollTo({ top: 0 })
    else target.scrollIntoView({ block: 'start' })
  }, [slug, heading])

  const index = current === undefined ? -1 : DOC_PAGES.indexOf(current)
  const previous = index > 0 ? DOC_PAGES[index - 1] : undefined
  const next = index >= 0 && index < DOC_PAGES.length - 1 ? DOC_PAGES[index + 1] : undefined

  return (
    <div className={styles.docs}>
      <aside className={styles.side}>
        <button
          type="button"
          className={styles.menuToggle}
          aria-expanded={open}
          aria-controls="docs-tree"
          onClick={() => setOpen((value) => !value)}
        >
          <span className={styles.menuCrumb}>
            {current === undefined ? 'Documentation' : (
              <>
                <span className={styles.menuSection}>{current.section}</span>
                <span className={styles.menuTitle}>{current.title}</span>
              </>
            )}
          </span>
          <span className={open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron} aria-hidden="true" />
        </button>

        <nav id="docs-tree" className={open ? `${styles.tree} ${styles.treeOpen}` : styles.tree} aria-label="Documentation">
          {SECTIONS.map((section) => (
            <div key={section.title} className={styles.section}>
              <div className={styles.sectionTitle}>{section.title}</div>
              <ul className={styles.pages}>
                {section.pages.map((page) => {
                  const active = page.slug === current?.slug
                  return (
                    <li key={page.slug}>
                      <a
                        href={`#/docs/${page.slug}`}
                        className={active ? `${styles.page} ${styles.pageActive}` : styles.page}
                        aria-current={active ? 'page' : undefined}
                      >
                        {page.title}
                      </a>
                      {active && page.headings.length > 0 && (
                        <ul className={styles.headings}>
                          {page.headings.map((entry) => (
                            <li key={entry.id}>
                              <a
                                href={`#/docs/${page.slug}/${entry.id}`}
                                className={entry.id === heading ? `${styles.heading} ${styles.headingActive}` : styles.heading}
                              >
                                {entry.text}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      {current === undefined ? (
        <article className={styles.article}>
          <h1>No such page</h1>
          <p>
            The documentation has no page called “{slug}”. Every page is in the menu. Start at{' '}
            <a href={`#/docs/${DOC_PAGES[0]?.slug ?? ''}`}>{DOC_PAGES[0]?.title ?? 'the beginning'}</a>.
          </p>
        </article>
      ) : (
        <div className={styles.body}>
          <p className={styles.crumb}>{current.section}</p>
          {/* Build output, from this repository's own Markdown: there is no
              user content on this screen and nothing at runtime to sanitise. */}
          <article className={styles.article} dangerouslySetInnerHTML={{ __html: current.html }} />
          <nav className={styles.sequence} aria-label="Page sequence">
            {previous === undefined ? (
              <span />
            ) : (
              <a className={styles.previous} href={`#/docs/${previous.slug}`}>
                <span className={styles.sequenceLabel}>Previous</span>
                <span className={styles.sequenceTitle}>{previous.title}</span>
              </a>
            )}
            {next !== undefined && (
              <a className={styles.next} href={`#/docs/${next.slug}`}>
                <span className={styles.sequenceLabel}>Next</span>
                <span className={styles.sequenceTitle}>{next.title}</span>
              </a>
            )}
          </nav>
        </div>
      )}
    </div>
  )
}
