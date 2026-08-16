// @nimiq/identicons ships no types. The bundle build is imported by explicit
// path because it embeds the SVG parts — the package's `browser` entry needs
// an `svgPath` pointed at a separately served asset, which is one more thing
// to misconfigure per host. The bundle needs nothing.
declare module '@nimiq/identicons/dist/identicons.bundle.min.js' {
  const Identicons: {
    toDataUrl(text: string): Promise<string>
    placeholder(color?: string, strokeWidth?: number): string
  }
  export default Identicons
}
