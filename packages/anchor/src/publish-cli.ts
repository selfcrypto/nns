/**
 * Publisher CLI. One command, run on a schedule (every few hours) by a cron:
 *
 *   publish [--send]     read the pair, check everything, anchor; broadcast
 *                        only with --send
 *
 * §9's cadence is **on change with a daily floor**: the run anchors when the
 * log digest differs from its own last anchor's (never the commitment — §8.1
 * binds the height into it, so it moves every checkpoint), unconditionally
 * when its newest anchor is a day old, and otherwise reports "unchanged"
 * and exits clean — so the cron schedule is how often the publisher *looks*,
 * not how often it anchors.
 *
 * **Dry run by default**, the same contract `deploy` and `admin` make: the
 * plan is always printed and nothing is broadcast without `--send`. A dry
 * run stores nothing on either IPFS service (`only-hash` on kubo; upload
 * and delete under a dry-run key on Filebase).
 *
 * Exit codes are the cron's alerting surface:
 *
 *   0  anchored, already anchored, unchanged, or waiting on a pending
 *      checkpoint
 *   1  ALERT — CID mismatch, torn pair, divergence, balance, missing
 *      checkpoint, wrong chain, wrong contract: a human should look
 *   2  usage
 *
 * Idempotency is read off the chain, never off local state: before planning
 * a send, the publisher fetches its own `Anchored` events back and skips a
 * height it already anchored, so re-running after a crash or a double cron
 * fire never double-anchors. Catch-up anchors only the latest checkpoint,
 * and a missed daily floor is warned about, never silent
 * (see `docs/decisions.md`).
 */

import type { EvmAddress, Signer } from './chain.js'
import { normaliseAddress, viewOnlySigner } from './deploy.js'
import {
  loadPublisherSettings,
  requirePublisherIdentity,
  requirePublisherKey,
  type PublisherSettings,
} from './env.js'
import { createFilebaseAdd } from './filebase.js'
import { createKuboAdd } from './ipfs.js'
import { createNnsApi } from './nns-api.js'
import { describePublishPlan, executePublish, planPublish, PublishError, type PublishDeps } from './publish.js'
import { createPublisherRpc, createSigner } from './viem-rpc.js'

const USAGE = `usage:
  publish [--send]       plan this hour's anchor; --send pins the log and broadcasts

Dry run by default: without --send the plan is printed and nothing is sent or
pinned. A dry run needs no key — set NNS_ANCHOR_PUBLISHER_ADDRESS instead.

Settings come from the environment; see packages/anchor/.env.example.`

function signerFor(settings: PublisherSettings, send: boolean): Signer {
  const identity = requirePublisherIdentity(settings)
  if (identity.kind === 'planning') {
    if (send) requirePublisherKey(settings) // throws with the message that fits
    return viewOnlySigner(identity.address)
  }
  const signer = createSigner(identity.key)
  const declared = identity.declaredAddress
  if (declared !== undefined && normaliseAddress(declared) !== signer.address) {
    throw new PublishError(
      `NNS_ANCHOR_PUBLISHER_ADDRESS is ${normaliseAddress(declared)} but NNS_ANCHOR_PUBLISHER_KEY is the ` +
        `key for ${signer.address} — one of the two is stale.`,
    )
  }
  return signer
}

async function publish(send: boolean): Promise<number> {
  const settings = loadPublisherSettings()
  const secondary = settings.ipfsSecondary
  const deps: PublishDeps = {
    api: createNnsApi(settings.apiUrl),
    rpc: createPublisherRpc(settings.rpcUrl),
    ipfs: [
      createKuboAdd(settings.ipfsPrimary),
      secondary.kind === 'filebase' ? createFilebaseAdd(secondary) : createKuboAdd(secondary),
    ],
    signer: signerFor(settings, send),
    now: () => Math.floor(Date.now() / 1000),
  }
  const contractAddress: EvmAddress = normaliseAddress(settings.contractAddress)

  const outcome = await planPublish(deps, {
    expectedChainId: settings.chainId,
    contractAddress,
    minBalanceWei: settings.minBalanceWei,
    lookbackBlocks: settings.lookbackBlocks,
  })

  if (outcome.kind === 'waiting') {
    console.log(`waiting: ${outcome.detail} — nothing anchored, the next run retries`)
    return 0
  }
  if (outcome.kind === 'already-anchored') {
    console.log(
      `already anchored: height ${outcome.nimiqHeight}, commitment ${outcome.commitment} ` +
        `(tx ${outcome.transactionHash}) — nothing to do`,
    )
    return 0
  }
  if (outcome.kind === 'unchanged') {
    console.log(
      `unchanged: log digest ${outcome.logDigest} equals the newest own anchor's, at height ` +
        `${outcome.lastAnchoredHeight} ${Math.floor(outcome.ageSeconds / 3600)} h ago (tx ` +
        `${outcome.transactionHash}) — §9 anchors on change, or at the 24 h floor. Nothing to do`,
    )
    return 0
  }

  for (const line of describePublishPlan(outcome.plan)) console.log(line)

  if (!send) {
    console.log('')
    console.log('dry run — nothing was pinned or sent. Pass --send to pin and broadcast.')
    return 0
  }

  console.log('')
  console.log('pinning and sending…')
  const result = await executePublish(deps, outcome.plan)
  console.log(`anchored:  height ${outcome.plan.nimiqHeight}`)
  console.log(`  tx       ${result.transactionHash}`)
  console.log(`  block    ${result.blockNumber}`)
  console.log(`  gas used ${result.gasUsed}`)
  console.log(`  cid      ${outcome.plan.cid} (pinned on both services)`)
  return 0
}

async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  try {
    if (command === 'publish') return await publish(rest.includes('--send'))
    console.error(USAGE)
    return 2
  } catch (error) {
    if (error instanceof Error) {
      // Every named failure is an alert: the cron surfaces exit 1 plus this
      // line, and none of these resolve themselves by waiting.
      console.error(`ALERT ${error.name}: ${error.message}`)
      return 1
    }
    console.error(String(error))
    return 1
  }
}

process.exitCode = await run(process.argv.slice(2))
