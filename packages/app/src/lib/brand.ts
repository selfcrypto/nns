/**
 * The logo, as it ships in `public/brand`. The site's mark is the hexagon
 * alone: the product is **Nimiq Names**, and the letters NNS name the
 * protocol it speaks (Rico, 2026-09-13). The social card,
 * `brand/og-image.png`, is the mark beside the words "Nimiq Names" — the
 * NNS lockup stood there for a day and was the one place the letters still
 * showed (Rico, 2026-09-14).
 *
 * A path rather than an import: these are public files, and one name typed
 * twice in two screens is a 404 nobody sees until a deploy.
 *
 * All of it is cut from the one source, `assets/nns-lockup-2048.png`:
 *
 *   magick $SRC -crop 679x611+5+0 +repage -background none -gravity center \
 *     -extent 679x679 -resize 512x512 public/brand/nns-mark.png
 *   magick public/brand/nns-mark.png -resize 32x32 public/brand/favicon-32.png
 *   magick public/brand/nns-mark.png -resize 192x192 public/brand/favicon-192.png
 *   # Apple composites its icon on black, so that one is flattened on white:
 *   magick public/brand/nns-mark.png -resize 160x160 -background white \
 *     -gravity center -extent 180x180 -alpha remove public/brand/apple-touch-icon.png
 *   # The card: the mark and the words, one block, centred on the gradient.
 *   # Noto Sans Bold stands in for the system-ui stack the app renders in;
 *   # #1F2348 is the lockup's letter colour. Flattened: WhatsApp mishandles alpha.
 *   magick public/brand/nns-mark.png -resize 230x230 mark.png
 *   magick -background none -fill '#1F2348' -font Noto-Sans-Bold -pointsize 106 -kerning 2 \
 *     label:'Nimiq Names' words.png
 *   magick mark.png words.png -background none -gravity center +smush 40 block.png
 *   magick -size 1200x630 gradient:'#FFFDF8-#F9FAFC' block.png -gravity center -composite \
 *     -alpha off public/brand/og-image.png
 */
export const BRAND_MARK = '/brand/nns-mark.png'
