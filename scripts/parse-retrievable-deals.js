import assert from 'node:assert'
import { createReadStream, createWriteStream } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import split2 from 'split2'

// See https://docs.filecoin.io/networks/mainnet#genesis
const GENESIS_TS = new Date('2020-08-24T22:00:00Z').getTime()
const BLOCK_TIME = 30_000 // 30 seconds
const ONE_DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000

const stats = {
  total: 0n,
  ldn: 0n
}

const infile = resolve(dirname(fileURLToPath(import.meta.url)), '../generated/StateMarketDeals.ndjson')
const outfile = resolve(dirname(fileURLToPath(import.meta.url)), '../generated/retrievable-deals.ndjson')
const started = Date.now()

const abortController = new AbortController()
const signal = abortController.signal
process.on('SIGINT', () => abortController.abort('interrupted'))

process.on('beforeExit', () => {
  console.log('Finished after %s seconds', (Date.now() - started) / 1000)
  console.log()
  console.log('Total deals:    %s', stats.total)
  console.log('LDN with Label: %s', stats.ldn)
  console.log('Ratio:          %s%s', stats.total ? (stats.ldn * 100n / stats.total).toString() : '--', '%')
  console.log()
  console.log('LDN deals were written to %s', relative(process.cwd(), outfile))
})

console.log('Parsing ALL VERIFIED deals')

try {
  await pipeline(
    createReadStream(infile, 'utf-8'),
    split2(JSON.parse),
    async function * (source, { signal }) {
      for await (const deal of source) {
        stats.total++
        for await (const out of processDeal(deal, { signal })) {
          stats.ldn++
          yield JSON.stringify(out) + '\n'
        // console.log(JSON.stringify(out))
        }
        if (stats.total % 1_000_000n === 0n) {
          console.log(
            '%s processed %s million deals',
            new Date().toISOString(),
            (stats.total / 1_000_000n).toString()
          )
        }
      }
    },
    createWriteStream(outfile, 'utf-8'),
    { signal }
  )
} catch (err) {
  if (err.name === 'AbortError') {
    console.log('\nAborted.')
  } else {
    throw err
  }
}

/** @param {{
   Proposal: {
     PieceCID: {
      '/': string;
    };
    PieceSize: number;
    VerifiedDeal: boolean;
    Client: string;
    Provider: string;
    Label?: string;
    StartEpoch: number;
    EndEpoch: number;
    StoragePricePerEpoch: string;
    ProviderCollateral: string;
    ClientCollateral: string;
  },
  State: {
    SectorStartEpoch: number;
    LastUpdatedEpoch: number;
    SlashEpoch: number;
    VerifiedClaim: number;
  }
 }} deal
*/
function * processDeal (deal) {
  const { VerifiedDeal, StartEpoch, EndEpoch, Client, Label, Provider, PieceCID, PieceSize } = deal.Proposal
  assert.strictEqual(typeof VerifiedDeal, 'boolean', `VerifiedDeal is not a boolean: ${JSON.stringify(deal.Proposal)}`)
  if (!VerifiedDeal) return

  // FIXME: investigate why some deals don't have any PieceCID
  if (!PieceCID) return

  // Calculate when the deal started
  assert.strictEqual(typeof StartEpoch, 'number', `StartEpoch is not a number: ${JSON.stringify(deal.Proposal)}`)
  const started = StartEpoch * BLOCK_TIME + GENESIS_TS

  // Skip deals that are less than 24 hours old, to account for IPNI ingestion delays
  if (Date.now() - started < ONE_DAY_IN_MILLISECONDS) return

  // Calculate when the deal expires
  assert.strictEqual(typeof EndEpoch, 'number', `EndEpoch is not a number: ${JSON.stringify(deal.Proposal)}`)
  const expires = EndEpoch * BLOCK_TIME + GENESIS_TS

  // Skip deals that have expired or expire in less than 24 hours
  const tomorrow = Date.now() + ONE_DAY_IN_MILLISECONDS
  if (expires < tomorrow) return

  // Skip deals that don't have payload CID metadata
  // TODO: handle other CID formats
  assert.strictEqual(typeof Label, 'string', `Label is not a string: ${JSON.stringify(deal.Proposal)}`)
  if (!Label || !Label.match(/^(bafy|bafk|Qm)/)) return

  assert.strictEqual(typeof Provider, 'string', `Provider is not a string: ${JSON.stringify(deal.Proposal)}`)
  assert.strictEqual(typeof PieceCID['/'], 'string', `PieceCID is not a CID link: ${JSON.stringify(deal.Proposal)}`)
  const entry = {
    provider: Provider,
    client: Client,
    pieceCID: PieceCID['/'],
    pieceSize: PieceSize,
    payloadCID: Label,
    started,
    expires
  }
  yield entry
}
