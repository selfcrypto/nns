/**
 * The landing marquee's five cards — illustrations, not records.
 *
 * Nobody is meant to look these names up: a card showing a real name would be
 * a resolution the app never verified, and the landing page resolves nothing.
 * So the addresses are **deliberately unusable**, and each in the way its own
 * chain refuses: the Nimiq ones fail the mod-97 checksum (`core.parseAddress`
 * rejects them, and so does every wallet), and the EVM ones are mixed-case
 * forms that fail EIP-55 (`core.tryParseEvmAddress` rejects them). Copying one
 * out of the picture cannot send money anywhere; `examples.test.ts` keeps that
 * true.
 *
 * They were `NQ00 0000 …0001` through `…0005` until 2026-09-13, which read as
 * five names all pointing at the same nothing (Kike). Random-looking is the
 * whole point — the illustration is "a name has an address behind it", and
 * five zeroed strings illustrate a broken registry. **These become five real
 * registered names once the era has run a few days.**
 */
export interface ExampleProfile {
  readonly name: string
  readonly address: string
  readonly evm: string
  readonly color: string
}

export const EXAMPLE_PROFILES: readonly ExampleProfile[] = [
  { name: 'alice', address: 'NQ10 2N3M 4HBT K4QB QY0C 2UX1 JR52 734Q CYAN', evm: '0x9CfED4efaBc143FCf102f5Ef318c9c902858F7b8', color: '#F6851B' },
  { name: 'bob', address: 'NQ33 G95G 2295 1VVY 07D2 CNHT S672 98RR CRR4', evm: '0xD962e31E2a735599a9528cED763c6DBaEc54533e', color: '#E9B213' },
  { name: 'carol', address: 'NQ16 G5JS RYVJ NUU5 UTXM 5YQA KTGQ CQHY R9C2', evm: '0x79C2F5ff5f2AB42E986128DEf0641396Ccc90B70', color: '#E25822' },
  { name: 'dave', address: 'NQ49 3KKS RQMP SYGE P0T7 E9T5 8XXN 14PF 3Y0N', evm: '0xFE7B968436385bDEDF845d63208Ee9C4aAcD030d', color: '#F9A826' },
  { name: 'erin', address: 'NQ89 0GSJ PB34 4QVQ BGVH XRCN 9PHF XSH0 VXM9', evm: '0xfD7FFDc3ebb0b31Fc5B80507e6d870C99169bcc1', color: '#D35400' },
]
