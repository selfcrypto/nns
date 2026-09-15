/**
 * What `plugins/docs.ts` serves: every page of `packages/app/docs`, in
 * `index.md`'s order, with its placeholders filled and its Markdown already
 * HTML. The flat order is the prev/next chain; `section` groups the sidebar;
 * `headings` are the page's `##` anchors, each reachable at
 * `#/docs/<slug>/<id>` and carried in the HTML as `id="doc-<id>"`.
 */
declare module 'virtual:docs' {
  export interface DocHeading {
    readonly id: string
    readonly text: string
  }
  export interface DocPageContent {
    readonly slug: string
    readonly title: string
    readonly section: string
    readonly headings: readonly DocHeading[]
    readonly html: string
  }
  export const DOC_PAGES: readonly DocPageContent[]
}
