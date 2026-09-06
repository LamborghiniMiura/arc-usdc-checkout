/**
 * pay.ts — browser side. Zero dependencies: talks to the wallet through EIP-1193
 * (window.ethereum), so it works with MetaMask, Rabby, Coinbase Wallet, etc.
 *
 * Flow:
 *   const quote = await createQuote({...})          // POST /api/usdc/create
 *   const txHash = await payQuote(quote, onStatus)  // wallet: switch/add chain -> ERC-20 transfer
 *   const result = await waitForConfirmation(quote.orderId, txHash)  // poll /api/usdc/confirm
 */

export interface Quote {
  orderId: string;
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  usdcAddress: string;
  receiver: string;
  amountMicro: number;
  amount: string;
  totalFiat: number;
  shippingFiat: number;
  fiatCurrency: string;
  expiresAt: string;
}

export type PayStatus = 'connecting' | 'switching-chain' | 'awaiting-signature' | 'confirming';
export type ConfirmResult =
  | { status: 'paid'; txHash: string }
  | { status: 'expired' }
  | { status: 'mismatch'; reason: string; expected?: string; received?: string }
  | { status: 'timeout' };

const TRANSFER_SELECTOR = '0xa9059cbb'; // transfer(address,uint256)
const hex = (n: number | bigint) => '0x' + BigInt(n).toString(16);
const pad32 = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');

export async function createQuote(
  body: { lang?: string; items: { sku: string; qty: number }[]; customer: { name: string; email: string; address?: { country: string; postal: string; line: string } } },
  base = '',
): Promise<Quote> {
  const res = await fetch(`${base}/api/usdc/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `create failed (${res.status})`);
  return data as Quote;
}

export class NoWalletError extends Error { constructor() { super('no EIP-1193 wallet found'); } }
export class UserRejectedError extends Error { constructor() { super('user rejected'); } }

/** Connect, switch (or add) the Arc chain, and send the ERC-20 transfer. Resolves to the tx hash. */
export async function payQuote(q: Quote, onStatus?: (s: PayStatus) => void): Promise<string> {
  const eth = (globalThis as any).ethereum;
  if (!eth) throw new NoWalletError();
  try {
    onStatus?.('connecting');
    const [from] = await eth.request({ method: 'eth_requestAccounts' });
    await ensureChain(eth, q, onStatus);
    onStatus?.('awaiting-signature');
    const data = TRANSFER_SELECTOR + pad32(q.receiver) + pad32(hex(q.amountMicro));
    return await eth.request({ method: 'eth_sendTransaction', params: [{ from, to: q.usdcAddress, data, value: '0x0' }] });
  } catch (e: any) {
    if (e?.code === 4001) throw new UserRejectedError();
    throw e;
  }
}

async function ensureChain(eth: any, q: Quote, onStatus?: (s: PayStatus) => void) {
  const current = parseInt(await eth.request({ method: 'eth_chainId' }), 16);
  if (current === q.chainId) return;
  onStatus?.('switching-chain');
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex(q.chainId) }] });
  } catch (e: any) {
    if (e?.code === 4001) throw e;
    // 4902 = unknown chain, but wallets are inconsistent about the code, so try adding on any other error.
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hex(q.chainId),
        chainName: q.chainName,
        nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, // Arc's native gas token is USDC with 18 decimals
        rpcUrls: [q.rpcUrl],
        blockExplorerUrls: [q.explorerUrl],
      }],
    });
  }
  const after = parseInt(await eth.request({ method: 'eth_chainId' }), 16);
  if (after !== q.chainId) await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex(q.chainId) }] });
}

/** Poll the server until it has verified the receipt. Arc finalizes in well under a second, so this normally returns on the first or second poll. */
export async function waitForConfirmation(orderId: string, txHash: string, base = '', maxMs = 60_000): Promise<ConfirmResult> {
  const started = Date.now();
  let delay = 700;
  while (Date.now() - started < maxMs) {
    const res = await fetch(`${base}/api/usdc/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, txHash }),
    });
    const d = await res.json();
    if (d.status === 'paid') return { status: 'paid', txHash };
    if (d.status === 'expired') return { status: 'expired' };
    if (d.status === 'mismatch') return { status: 'mismatch', reason: d.reason, expected: d.expected, received: d.received };
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.4, 2000);
  }
  return { status: 'timeout' };
}
