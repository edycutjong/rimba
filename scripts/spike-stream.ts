// Spike: prove the Sui gRPC stream decodes on real mainnet checkpoints.
// Subscribes, captures N checkpoints to test/fixtures/, decodes transfers, and calls
// LedgerService.GetCheckpoint + GetTransaction once each. Prints the endpoint source (tatum|public-dev).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCheckpoint, getTransaction, makeClients, subscribeCheckpoints, type RawSubscribeResponse } from '../src/stream/client.js';
import { decodeCheckpoint } from '../src/stream/decode.js';

const N = Number(process.argv[2] ?? 5);
const FIX = join(import.meta.dirname, '..', 'test', 'fixtures');
mkdirSync(FIX, { recursive: true });

const c = makeClients();
console.log(`endpoint=${c.endpoint.host} source=${c.endpoint.source}`);
const t0 = Date.now();
let got = 0;
let firstDigest: string | undefined;
const stream = subscribeCheckpoints(c);
stream.on('data', (r: RawSubscribeResponse) => {
  const cp = r.checkpoint;
  if (!cp?.sequence_number) return;
  got++;
  const transfers = decodeCheckpoint(cp);
  firstDigest ??= transfers[0]?.txDigest;
  writeFileSync(join(FIX, `checkpoint-${cp.sequence_number}.json`), JSON.stringify({ source: c.endpoint.source, response: r }, null, 1));
  console.log(`cp ${cp.sequence_number} txs=${cp.transactions?.length ?? 0} transfers=${transfers.length} first=${transfers[0] ? `${transfers[0].coinType.split('::').pop()} ${transfers[0].amountRaw}` : '-'} (+${Date.now() - t0}ms)`);
  if (got >= N) {
    stream.cancel();
    void unaries(cp.sequence_number);
  }
});
stream.on('error', (e: Error & { code?: number }) => {
  if (e.code === 1) return; // CANCELLED by us
  console.error('stream error', e.code, e.message);
  process.exit(1);
});

async function unaries(seq: string) {
  const a = Date.now();
  const cp = await getCheckpoint(c, seq);
  console.log(`GetCheckpoint(${seq}) → digest=${cp.checkpoint?.digest} txs=${cp.checkpoint?.transactions?.length} ${Date.now() - a}ms`);
  if (firstDigest) {
    const b = Date.now();
    const tx = await getTransaction(c, firstDigest);
    console.log(`GetTransaction(${firstDigest}) → checkpoint=${tx.transaction?.checkpoint} sender=${tx.transaction?.transaction?.sender?.slice(0, 10)}… balance_changes=${tx.transaction?.balance_changes?.length} ${Date.now() - b}ms`);
  }
  c.close();
  process.exit(0);
}
