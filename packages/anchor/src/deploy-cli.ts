/**
 * Deploy CLI. Two commands:
 *
 *   deploy [--send]      plan the deployment; broadcast only with --send
 *   verify <address>     does that address hold this contract?
 *
 * **Dry run by default**, the same contract `packages/admin` makes: the plan
 * is always printed and nothing is broadcast without `--send`. Settings come
 * from the environment; see `packages/anchor/.env.example`.
 *
 * Deploy to Sepolia first. It is a rehearsal of this exact path — same
 * bytecode, same script, same env vars, only `NNS_ANCHOR_CHAIN_ID` and the
 * RPC URL differ — and the thing it rehearses is the configuration, which is
 * where the mistakes are.
 */

import { ARTIFACT } from './artifact.js'
import type { EvmAddress, Signer } from './chain.js'
import {
  DeployError,
  describeMismatch,
  describePlan,
  executeDeploy,
  normaliseAddress,
  planDeploy,
  verifyDeployedCode,
  viewOnlySigner,
} from './deploy.js'
import { EnvError, loadSettings, requireDeployer, requireDeployKey, type DeploySettings } from './env.js'
import { createRpc, createSigner } from './viem-rpc.js'

const USAGE = `usage:
  deploy [--send]        plan the NnsAnchor deployment; --send broadcasts it
  verify <address>       check that an address holds this exact contract

Dry run by default: without --send the plan is printed and nothing is sent.
A dry run needs no key — set NNS_ANCHOR_DEPLOY_ADDRESS instead and the plan
can be produced on a machine that has never seen the deploy key.

Settings come from the environment; see packages/anchor/.env.example.`

class UsageError extends Error {
  override readonly name = 'UsageError'
}

/**
 * The signer for a run. With a key it can sign; with only an address it can
 * plan. Both are cross-checked when both are present — a key and an address
 * that disagree means one of them is stale, and the plan would otherwise be
 * computed for an account the transaction will not come from.
 */
function signerFor(settings: DeploySettings, send: boolean): Signer {
  const deployer = requireDeployer(settings)
  if (deployer.kind === 'planning') {
    if (send) requireDeployKey(settings) // throws with the message that fits
    return viewOnlySigner(deployer.address)
  }

  const signer = createSigner(deployer.key)
  const declared = deployer.declaredAddress
  if (declared !== undefined && normaliseAddress(declared) !== signer.address) {
    throw new DeployError(
      `NNS_ANCHOR_DEPLOY_ADDRESS is ${normaliseAddress(declared)} but NNS_ANCHOR_DEPLOY_KEY is the ` +
        `key for ${signer.address} — one of the two is stale.`,
    )
  }
  return signer
}

async function deploy(send: boolean): Promise<number> {
  const settings = loadSettings()
  const rpc = createRpc(settings.rpcUrl)
  const signer = signerFor(settings, send)

  const plan = await planDeploy(rpc, signer, { expectedChainId: settings.chainId })
  for (const line of describePlan(plan)) console.log(line)

  if (!send) {
    console.log('')
    console.log('dry run — nothing was sent. Pass --send to broadcast.')
    return 0
  }

  console.log('')
  console.log('sending…')
  const outcome = await executeDeploy(rpc, signer, plan)
  console.log(`deployed:  ${outcome.address}`)
  console.log(`  tx       ${outcome.transactionHash}`)
  console.log(`  block    ${outcome.blockNumber}`)
  console.log(`  gas used ${outcome.gasUsed}`)
  console.log('  code     verified against the committed artifact')
  console.log('')
  console.log('Record the address in the publisher and reader configuration. It is not a')
  console.log('protocol constant (§9) and does not belong in @nns/core.')
  return 0
}

async function verify(rawAddress: string | undefined): Promise<number> {
  if (rawAddress === undefined) throw new UsageError('verify needs an address')
  const settings = loadSettings()
  const rpc = createRpc(settings.rpcUrl)

  const chainId = await rpc.chainId()
  if (chainId !== settings.chainId) {
    throw new DeployError(`endpoint is on chain ${chainId}, expected ${settings.chainId}`)
  }

  const address: EvmAddress = normaliseAddress(rawAddress)
  const result = await verifyDeployedCode(rpc, address)
  console.log(`chain id   ${chainId}`)
  console.log(`address    ${address}`)
  console.log(`solc       ${ARTIFACT.solcVersion}`)
  console.log(`sourceHash ${ARTIFACT.sourceHash}`)
  if (!result.match) {
    console.error(describeMismatch(address, result))
    return 1
  }
  console.log('MATCH — this address holds the contract in contracts/NnsAnchor.sol')
  return 0
}

async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  try {
    if (command === 'deploy') return await deploy(rest.includes('--send'))
    if (command === 'verify') return await verify(rest[0])
    console.error(USAGE)
    return 2
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message)
      console.error(USAGE)
      return 2
    }
    if (error instanceof EnvError || error instanceof DeployError) {
      console.error(`${error.name}: ${error.message}`)
      return 1
    }
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    return 1
  }
}

process.exitCode = await run(process.argv.slice(2))
