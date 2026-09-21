// Generate the four §3 keys offline and write them to one env file.
//
//   node scripts/gen-protocol-keys.mjs <out-file>           # create; refuses an existing file
//   node scripts/gen-protocol-keys.mjs --verify <file>      # re-derive and print the addresses
//
// Prints addresses only — a private key never reaches the terminal. Entropy
// is the OS's (core.generateKeypair → Web Crypto); no node, no network. Run it
// with the network off, then back the file up before funding anything.
//
// The file is the format scripts/lib/wallet.mjs reads as
// ~/.nns/protocol-keys.env. `--verify` is the restore test: it proves a
// decrypted backup still derives the addresses frozen in constants.ts.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { generateKeypair, keypairFromPrivateKey } from '../packages/core/dist/index.js'

const ROLES = ['TREASURY', 'PROTOCOL', 'ADMIN', 'MARKETPLACE']
const args = process.argv.slice(2)
const verify = args[0] === '--verify'
const file = verify ? args[1] : args[0]
if (!file) {
  console.error('usage: gen-protocol-keys.mjs <out-file> | --verify <file>')
  process.exit(2)
}

if (verify) {
  const env = Object.fromEntries(
    readFileSync(file, 'utf8').split('\n').filter((l) => /^NNS_\w+=/.test(l)).map((l) => l.split('=')),
  )
  for (const role of ROLES) {
    const priv = env[`NNS_${role}_PRIVKEY`]
    if (!priv) throw new Error(`${file} has no NNS_${role}_PRIVKEY`)
    const pair = keypairFromPrivateKey(priv)
    if (env[`NNS_${role}_PUBKEY`] !== pair.publicKey) throw new Error(`${role}: the stored public key is not this private key's`)
    console.log(`${role.padEnd(12)} ${pair.address}`)
  }
  process.exit(0)
}

if (existsSync(file)) {
  console.error(`${file} exists — refusing to overwrite a key file. Move it aside first.`)
  process.exit(1)
}
const lines = [`# NNS §3 keys, generated ${new Date().toISOString()}. Never commit, never paste.`]
const addresses = []
for (const role of ROLES) {
  const pair = generateKeypair()
  // Round-trip before trusting it: the stored key must derive the printed address.
  if (keypairFromPrivateKey(pair.privateKey).address !== pair.address) throw new Error(`${role}: derivation does not round-trip`)
  lines.push(`NNS_${role}_PUBKEY=${pair.publicKey}`, `NNS_${role}_PRIVKEY=${pair.privateKey}`)
  addresses.push([role, pair.address])
}
if (new Set(addresses.map(([, a]) => a)).size !== ROLES.length) throw new Error('two roles share an address')
writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' })
for (const [role, address] of addresses) console.log(`${role.padEnd(12)} ${address}`)
console.error(`\nwritten to ${file} (mode 600). Back it up and run --verify on the restored copy before funding.`)
