/**
 * The documentation, `#/docs/<slug>`.
 *
 * The pages are `packages/app/docs/*.md`, already HTML by the time this
 * renders: `plugins/docs.ts` fills the `{{format:KEY}}` placeholders from
 * `CONSTANTS` and converts the Markdown at build time, so nothing here parses
 * anything and no Markdown library reaches the bundle.
 *
 * The order in `index.md` is the whole navigation: the page list, and the
 * previous/next pair at the foot. Cross-links inside a page are ordinary
 * `#/docs/<slug>` anchors — the hash is the route, so `App.tsx`'s
 * `hashchange` listener is all the handling they need.
 */

import { useEffect, useRef } from 'react'

import { DOC_PAGES } from 'virtual:docs'

import styles from './docs.module.css'

export function DocsScreen({ slug }: { readonly slug: string | null }) {
  const current = slug === null ? DOC_PAGES[0] : DOC_PAGES.find((page) => page.slug === slug)
  const active = useRef<HTMLAnchorElement | null>(null)

  // A page is a page: arriving at one from another must start at its top,
  // which a hash change inside the same screen does not do by itself. On a
  // phone the page list is a strip that scrolls sideways, so the page being
  // read has to be brought into it — otherwise the tenth page shows the first
  // three titles and no sign of where the reader is.
  useEffect(() => {
    window.scrollTo({ top: 0 })
    active.current?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [slug])

  const index = current === undefined ? -1 : DOC_PAGES.indexOf(current)
  const previous = index > 0 ? DOC_PAGES[index - 1] : undefined
  const next = index >= 0 && index < DOC_PAGES.length - 1 ? DOC_PAGES[index + 1] : undefined

  return (
    <div className={styles.docs}>
      <nav className={styles.pages} aria-label="Documentation">
        {DOC_PAGES.map((page) => (
          <a
            key={page.slug}
            ref={page.slug === current?.slug ? active : null}
            href={`#/docs/${page.slug}`}
            className={page.slug === current?.slug ? `${styles.page} ${styles.pageActive}` : styles.page}
            aria-current={page.slug === current?.slug ? 'page' : undefined}
          >
            {page.title}
          </a>
        ))}
      </nav>

      {current === undefined ? (
        <article className={styles.article}>
          <h1>No such page</h1>
          <p>
            The documentation has no page called “{slug}”. Everything there is is in the list above — start at{' '}
            <a href={`#/docs/${DOC_PAGES[0]?.slug ?? ''}`}>{DOC_PAGES[0]?.title ?? 'the beginning'}</a>.
          </p>
        </article>
      ) : (
        <div className={styles.body}>
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
