/**
 * rpc.ts — minimal Arc JSON-RPC client and incoming-transfer verification.
 *
 * Plain fetch, no viem/ethers, so it runs anywhere fetch does (Cloudflare Workers,
 * Node 18+, Deno, Bun). Arc has deterministic finality with no reorgs, so a receipt
 * with status 0x1 is final — one confirmation is enough.
 */
import type { ArcConfig } from './config';

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface Log {
  address: string;
  topics: string[];
  data: string;
}
export interface Receipt {
  status: string; // "0x1" | "0x0"
  blockNumber: string;
  transactionHash: string;
  from: string;
  to: string | null;
  logs: Log[];
}

export async function rpc<T>(cfg: ArcConfig, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(cfg.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
  return body.result as T;
}

export const getReceipt = (cfg: ArcConfig, txHash: string) =>
  rpc<Receipt | null>(cfg, 'eth_getTransactionReceipt', [txHash]);

export const getChainId = async (cfg: ArcConfig) => parseInt(await rpc<string>(cfg, 'eth_chainId', []), 16);

const topicToAddress = (t: string) => ('0x' + t.slice(-40)).toLowerCase();

export interface TransferMatch {
  from: `0x${string}`;
  amountMicro: number;
  blockNumber: number;
}

/**
 * Find USDC Transfer logs in a receipt whose recipient is the merchant address.
 * Multiple matching logs are summed. Returns null on a reverted tx or no match.
 */
export function findIncomingTransfer(cfg: ArcConfig, receipt: Receipt): TransferMatch | null {
  if (receipt.status !== '0x1') return null;
  let total = 0n;
  let from: string | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== cfg.usdcAddress) continue;
    if (log.topics.length < 3 || log.topics[0] !== TRANSFER_TOPIC) continue;
    if (topicToAddress(log.topics[2]) !== cfg.receiver) continue;
    total += BigInt(log.data);
    from ??= topicToAddress(log.topics[1]);
  }
  if (!from || total === 0n) return null;
  // 6-decimal USDC fits comfortably in a JS number (2^53 micro ≈ 9 billion USDC).
  return { from: from as `0x${string}`, amountMicro: Number(total), blockNumber: parseInt(receipt.blockNumber, 16) };
}

export const txUrl = (cfg: ArcConfig, txHash: string) => `${cfg.explorerUrl}/tx/${txHash}`;
