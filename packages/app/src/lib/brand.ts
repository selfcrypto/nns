/**
 * The logo, as it ships in `public/brand`. The site's mark is the hexagon
 * alone: the product is **Nimiq Names**, and the letters NNS name the
 * protocol it speaks (Kike, 2026-09-13). The full lockup — mark plus those
 * letters — is the social card, `brand/og-image.png`, where the protocol's
 * name does belong.
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
 *   magick $SRC -trim +repage -resize 760x -background none -gravity center -extent 1200x630 \
 *     \( -size 1200x630 gradient:'#FFFDF8-#F9FAFC' \) -compose DstOver -composite \
 *     public/brand/og-image.png
 */
export const BRAND_MARK = '/brand/nns-mark.png'
