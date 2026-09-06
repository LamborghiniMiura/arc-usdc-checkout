/**
 * config.ts — chain + merchant configuration for USDC-on-Arc checkout.
 *
 * Everything is read from environment variables so that switching from
 * Arc Testnet to Arc mainnet is a config change, not a code change.
 *
 * Required:
 *   USDC_RECEIVER        merchant receive address (receive-only; no private key on the server)
 * Optional (defaults are Arc Testnet):
 *   ARC_CHAIN_ID         5042002
 *   ARC_RPC_URL          https://rpc.testnet.arc.network
 *   ARC_EXPLORER_URL     https://testnet.arcscan.app
 *   ARC_USDC_ADDRESS     0x3600000000000000000000000000000000000000
 *   USDC_ORDER_TTL_MIN   how long a quoted amount stays valid (default 30)
 *   USDC_RECEIVER_LABEL  human-readable chain label shown to the customer
 */

export interface ArcConfig {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  usdcAddress: `0x${string}`;
  receiver: `0x${string}`;
  orderTtlMs: number;
}

const TESTNET = {
  chainId: 5042002,
  chainName: 'Arc Testnet',
  rpcUrl: 'https://rpc.testnet.arc.network',
  explorerUrl: 'https://testnet.arcscan.app',
  usdcAddress: '0x3600000000000000000000000000000000000000',
} as const;

export type Env = Record<string, string | undefined>;

export function getArcConfig(env: Env): ArcConfig {
  const receiver = env.USDC_RECEIVER;
  if (!receiver || !/^0x[0-9a-fA-F]{40}$/.test(receiver)) {
    throw new Error('USDC_RECEIVER is not configured');
  }
  const chainId = Number(env.ARC_CHAIN_ID ?? TESTNET.chainId);
  const ttlMin = Number(env.USDC_ORDER_TTL_MIN ?? 30);
  return {
    chainId,
    chainName: env.ARC_CHAIN_NAME ?? (chainId === TESTNET.chainId ? TESTNET.chainName : 'Arc'),
    rpcUrl: env.ARC_RPC_URL ?? TESTNET.rpcUrl,
    explorerUrl: (env.ARC_EXPLORER_URL ?? TESTNET.explorerUrl).replace(/\/$/, ''),
    usdcAddress: (env.ARC_USDC_ADDRESS ?? TESTNET.usdcAddress).toLowerCase() as `0x${string}`,
    receiver: receiver.toLowerCase() as `0x${string}`,
    orderTtlMs: (Number.isFinite(ttlMin) && ttlMin > 0 ? ttlMin : 30) * 60_000,
  };
}

/**
 * USDC on Arc exposes the same balance through a native (18-decimal) interface and an
 * ERC-20 (6-decimal) interface. This module only ever uses the ERC-20 side.
 */
export const USDC_DECIMALS = 6;
