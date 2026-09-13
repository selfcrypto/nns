/**
 * §4.3 rendering — the stylesheet an integrator inherits instead of reading
 * the spec.
 *
 * §4.3 is a SHOULD addressed to integrators: render names in a typeface that
 * separates `0`/`o`, `1`/`l` and `rn`/`m`. It is a SHOULD nobody follows by
 * accident, and the failure is silent — no error, no warning, just a name
 * drawn in a face where `rn` and `m` are the same shape, paid to whoever
 * registered the other one. So the rule ships as CSS: adopting the package
 * is adopting the rendering.
 *
 * **This file is the source of truth for both artefacts.** `RENDERING_CSS`
 * below is the stylesheet verbatim; `pnpm build` writes the same bytes to
 * `dist/rendering.css`, which is what the `@nimiqnames/resolver/rendering.css`
 * subpath resolves to. There is no second copy to drift from.
 *
 * Two ways in, because the package assumes no bundler:
 *
 * - a CSS loader or a `<link>`: `@nimiqnames/resolver/rendering.css`
 * - no build step at all: `injectRenderingCss(document)`
 *
 * Fonts are **referenced, never embedded**. No `@font-face`, no font binary,
 * no third-party request — a stylesheet that fetched a font would put a
 * network dependency, and a party who learns every user's IP, inside a
 * package whose whole argument (§2.2) is that a client depends on as few
 * parties as possible. Load Inter or JetBrains Mono yourself if you want the
 * best case; the stack lands on the platform monospace if you do not, and
 * that already satisfies §4.3.
 */

/**
 * The single class the stylesheet defines. Exported because it is the
 * contract between the CSS and the markup, and a typo in it fails the way
 * §4.3 failures always fail: silently, in a confusable face.
 */
export const NNS_NAME_CLASS = 'nns-name'

/**
 * The stylesheet, as a string.
 *
 * Scoped to the name field and nowhere else: one class, one compound rule
 * for form controls, no element selector, no `:root`, no `@layer`. It can be
 * dropped into any app without touching its design system — and a `@layer`
 * would be worse than useless here, since unlayered app rules beat layered
 * ones and the app's own font would win by default.
 */
export const RENDERING_CSS = `/* NNS §4.3 — confusable-safe rendering for the name field.
 * Apply to the element that shows or accepts an NNS name, and to nothing
 * else: class="nns-name". Part of @nimiqnames/resolver; see its README. */

.nns-name {
  /* Ordered by how well the face separates 0/o, 1/l and rn/m, not by taste:
     three faces that do it by design, then the platform monospace, and the
     generic \`monospace\` keyword last — never a proportional sans, which is
     what makes the no-webfont case safe rather than merely styled.
     Overriding --nns-name-font-family replaces the whole stack, fallback
     included; keep a monospace at the end of whatever you put there. */
  font-family: var(--nns-name-font-family, "JetBrains Mono", "IBM Plex Mono",
    "Inter", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);

  /* Inter has to be asked: ss02 is its disambiguation set, zero its slashed
     zero (§4.3 names both). A feature a face does not carry is inert, so one
     declaration serves the whole stack. calt off disables JetBrains Mono's
     contextual ligatures — nothing in a name may be fused into a glyph that
     is not a character, which is the rn/m failure by another route. */
  font-feature-settings: var(--nns-name-font-features, "ss02" 1, "zero" 1, "calt" 0);
  font-variant-ligatures: none;

  /* rn/m is the one pair no font feature addresses. The face separates the
     pair; a little tracking keeps it separated at small sizes. */
  letter-spacing: 0.01em;

  /* A truncated name is a different name: nimiq-foundation and
     nimiq-foundation-2 ellipsize to the same pixels. Wrap instead. A
     statement of intent, not a guarantee — a later app rule of equal
     specificity still wins. */
  overflow-wrap: break-word;
  text-overflow: clip;
}

/* Form controls do not inherit font, so an input styled only by the rule
   above renders at the UA's default size — smaller than its surroundings,
   in the one place the reader is deciding character by character. */
input.nns-name,
textarea.nns-name {
  font-size: inherit;
  line-height: inherit;
}
`

/** The subset of a `<style>` element this module writes to. */
export interface StyleSheetElement {
  setAttribute(name: string, value: string): void
  textContent: string | null
}

/**
 * What `head.appendChild` is declared to take: the widest type satisfied by
 * both a DOM `Node` and by `StyleSheetElement`. Narrowing it to the latter
 * would make a real `Document` fail to satisfy `StyleHost` — `Node` has no
 * `setAttribute` — and the fix for that is a cast at every call site, which
 * is a worse trade than a loose parameter on a method this module calls
 * exactly once.
 */
export interface AppendableNode {
  textContent: string | null
}

/**
 * The subset of `Document` the injector uses — typed structurally, the same
 * way `HttpFetch` is, so the injector is testable without a DOM. A real
 * `Document` satisfies it with no cast; `rendering.test.ts` pins that.
 */
export interface StyleHost {
  createElement(tagName: 'style'): StyleSheetElement
  querySelector(selectors: string): unknown
  head: { appendChild(node: AppendableNode): unknown }
}

/** Marks the injected element, so a second call is a no-op. */
const MARKER = 'data-nns-rendering'

/**
 * Append `RENDERING_CSS` to `host.head` as a `<style>` element, once.
 *
 * The no-build-step path: `injectRenderingCss(document)`. Idempotent — apps
 * that render the name field in several places, or remount it, call this
 * wherever they need it rather than tracking whether they already have.
 *
 * The host is a required argument rather than a reach for the global
 * `document`, because a package that touches ambient globals cannot be
 * imported into a worker, a server render or a test without arranging for
 * them first.
 */
export function injectRenderingCss(host: StyleHost): void {
  if (host.querySelector(`style[${MARKER}]`) != null) return
  const style = host.createElement('style')
  style.setAttribute(MARKER, '')
  style.textContent = RENDERING_CSS
  host.head.appendChild(style)
}
