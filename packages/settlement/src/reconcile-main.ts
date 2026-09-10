/**
 * `reconcile` — settled versus owed, from `/log` and nothing else.
 *
 * Deliberately its own entry point rather than a subcommand of the settlement
 * service: this binary opens no database, holds no key, and can be run by
 * anyone against any operator's API. That is the property the whole custody
 * argument in §6 `B` rests on, and it is worth a separate `main`.
 *
 * Exit codes: 0 sound, 1 unsound, 2 usage or environment.
 */

import { initialState } from '@nns/core'

import { loadSettings } from './env.js'
import { describeReport, isSound, reconcile } from './reconcile.js'
import { replayLog } from './replay.js'
import { createShareCollector } from './share.js'
import { fetchLog, httpFetcher } from './source.js'

const USAGE = `usage: reconcile [--no-checkpoint-binding]

Fetches the §8.2 log from NNS_API_URL, verifies it against the hash and the
checkpoint served with it, replays it through @nns/core, and prints owed
versus settled. Reads no database and holds no key.

--no-checkpoint-binding  skip the /checkpoints/{height} confirmation. Only
                         honest when the server retains no checkpoint at the
                         height it stamped; the report says so in its header.

Settings come from the environment; see packages/settlement/.env.example.`

async function run(argv: readonly string[]): Promise<number> {
  let bind = true
  for (const argument of argv) {
    if (argument === '--no-checkpoint-binding') bind = false
    else {
      console.error(`unknown argument: ${argument}`)
      console.error(USAGE)
      return 2
    }
  }

  const settings = loadSettings()
  const snapshot = await fetchLog(settings.apiUrl, httpFetcher, bind)
  const shares = createShareCollector(settings.rates)
  const replay = replayLog(snapshot.lines, initialState(), settings.config, snapshot.checkpointHeight, shares.observe)
  const report = reconcile({
    replay,
    checkpointHeight: snapshot.checkpointHeight,
    boundToCheckpoint: snapshot.boundToCheckpoint,
    logHash: snapshot.logHash,
    shares: shares.result(),
  })

  for (const line of describeReport(report)) console.log(line)
  return isSound(report) ? 0 : 1
}

try {
  process.exitCode = await run(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = error instanceof Error && error.name === 'EnvError' ? 2 : 1
}
