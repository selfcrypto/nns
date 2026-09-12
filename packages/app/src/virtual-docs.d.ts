/**
 * What `plugins/docs.ts` serves: every page of `packages/app/docs`, in
 * `index.md`'s order, with its placeholders filled and its Markdown already
 * HTML. The order is the sidebar and the prev/next chain.
 */
declare module 'virtual:docs' {
  export interface DocPageContent {
    readonly slug: string
    readonly title: string
    readonly html: string
  }
  export const DOC_PAGES: readonly DocPageContent[]
}
