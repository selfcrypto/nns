/**
 * Regenerates `src/artifact.ts` from `contracts/NnsAnchor.sol`.
 *
 *     pnpm --filter @nns/anchor compile
 *
 * Run it after any change to the contract or to {@link SETTINGS}, and commit
 * the result. `artifact.test.ts` recompiles independently and fails if the
 * committed file is not what this produces, so forgetting is loud rather
 * than silent — which is the only reason committing a generated file is
 * acceptable at all.
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileAnchor } from './compile.js'
import { renderArtifactModule } from './render.js'

const target = fileURLToPath(new URL('../src/artifact.ts', import.meta.url))
const artifact = compileAnchor()
writeFileSync(target, renderArtifactModule(artifact), 'utf8')

process.stdout.write(
  `wrote ${target}\n` +
    `  solc            ${artifact.solcVersion}\n` +
    `  evmVersion      ${artifact.evmVersion}\n` +
    `  initCodeHash    ${artifact.initCodeHash}\n` +
    `  Anchored topic0 ${artifact.anchoredTopic0}\n`,
)
