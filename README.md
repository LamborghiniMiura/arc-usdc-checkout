# arc-usdc-checkout

**Accept USDC on [Arc](https://www.arc.network) in a small online shop — no smart contract, no payment processor, no dependencies.**

This is the payment module running in production at [yume-moon.com](https://yume-moon.com/en/shop), the online shop of a small manga studio in Bangkok. It sits next to Stripe and PromptPay as a third checkout option. It went live on Arc Testnet on 2026-09-05 and switches to Arc mainnet on launch day (2026-09-16) by changing environment variables only.

Example settlement on Arc Testnet: [`0x033ed9…dd063`](https://testnet.arcscan.app/tx/0x033ed9d79ddf74275feaa22bc999e5f23ff95a3d98a1f5543ecb6555a17dd063)

## Why this exists

Most "accept stablecoins" tooling assumes you are a DeFi protocol or a large merchant with a payments team. We are two people selling manga, classes and tote bags to customers in Thailand, Japan and overseas. We wanted:

- payments settled to **one plain address we control** — no contract to deploy, audit or upgrade
- **finality in seconds** so the customer sees "paid" before they close the tab (Arc has deterministic finality, no reorgs)
- something that runs on **Cloudflare Pages Functions** next to our existing Astro site, with no long-running process
- customers who have never used crypto to still get through: the wallet is added/switched automatically, the amount is copy-exact, failures are explained

## How it works

```
 browser                         Pages Function                    Arc
 ───────                         ──────────────                    ───
 cart + customer form ──POST /api/usdc/create──▶ price cart, quote USDC
                                                 amount = quote + 3-digit tag
                                                 save order (KV, pending)
        ◀──── { amount 12.345217, receiver, chainId, expiresAt } ────
 wallet: switch/add Arc chain
 wallet: USDC.transfer(receiver, 12.345217) ───────────────────────▶ tx
 POST /api/usdc/confirm { orderId, txHash } ──▶ eth_getTransactionReceipt ──▶
                                                 status == 0x1 ?
                                                 Transfer log to receiver ?
                                                 amount >= quoted ?
                                                 tx not used by another order ?
                                                 mark paid, run onPaid hook
        ◀──── { status: "paid" } ────
```

**Order identification without a memo field.** ERC-20 transfers carry no reference, so the amount *is* the reference: the first three decimals carry the price, the last three carry a random per-order tag (`12.345` + `217` → `12.345217 USDC`). One address, no contract, and the server can match an incoming transfer to an order from the receipt alone.

**Verification is a receipt lookup, not an indexer.** Because Arc finalizes deterministically, `eth_getTransactionReceipt` returning `status: 0x1` is the end of the story. No confirmation counting, no reorg handling, no event subscription. That is what lets this run in a stateless edge function.

**FX and rounding favour the merchant.** Prices are in fiat (THB for us). The quote converts at a rate you supply — typically market minus a small margin — rounds *up* to 0.001 USDC, and is held for 30 minutes. Overpayment settles the order and is reported; underpayment is rejected with the exact shortfall.

## Layout

```
src/lib/config.ts      chain + merchant config from env (testnet defaults; mainnet = change env)
src/lib/amount.ts      fiat→USDC, amount tagging, formatting
src/lib/rpc.ts         minimal JSON-RPC client, Transfer-log verification
src/lib/orders.ts      order state on Cloudflare KV (in-memory fallback for dev)
src/lib/merchant.ts    ← the one file you customize: catalog, shipping, FX, onPaid hook
src/lib/checkout.ts    framework-agnostic handlers: createOrder / confirmOrder / orderStatus / reconcile
src/pages/api/usdc/    Astro endpoint bindings (create, confirm, status, reconcile)
src/client/pay.ts      browser side, EIP-1193 only (MetaMask, Rabby, …)
```

`checkout.ts` has no framework imports; the Astro files are 15-line adapters. Wiring it to Hono, a bare Worker, or Next.js is the same three functions.

## Setup

1. Copy `src/` into your project (or use it as a reference).
2. Edit `src/lib/merchant.ts`: your catalog lookup, shipping table, FX source, and what to do on payment.
3. Environment variables (Cloudflare Pages → Settings → Variables):

   | name | testnet value | notes |
   |---|---|---|
   | `USDC_RECEIVER` | your address | receive-only; no key on the server |
   | `ARC_CHAIN_ID` | `5042002` | mainnet id announced 2026-09-16 |
   | `ARC_RPC_URL` | `https://rpc.testnet.arc.network` | |
   | `ARC_EXPLORER_URL` | `https://testnet.arcscan.app` | |
   | `ARC_USDC_ADDRESS` | `0x3600000000000000000000000000000000000000` | verify for mainnet |
   | `USDC_ORDER_TTL_MIN` | `30` | quote validity |
   | `USDC_ADMIN_TOKEN` | random string | bearer token for `/api/usdc/reconcile` |

4. KV: create a namespace and bind it as `ORDERS` (Pages → Settings → Bindings). Without it the module falls back to an in-memory store, which is fine for `astro dev` and wrong for production.
5. Testnet USDC for your test wallet: https://faucet.circle.com

## Browser usage

```ts
import { createQuote, payQuote, waitForConfirmation } from './client/pay';

const quote = await createQuote({ items: cart, customer });
const txHash = await payQuote(quote, (s) => render(s));   // wallet prompts
const result = await waitForConfirmation(quote.orderId, txHash);
if (result.status === 'paid') location.href = `/thanks?order=${quote.orderId}`;
```

## Things we learned building this

- **Arc's USDC has two faces.** The native balance (18 decimals, used for gas) and the ERC-20 interface at `0x3600…0000` (6 decimals) are the same balance. Do all accounting on the ERC-20 side and never mix the two decimals.
- **Native sends emit a *synthetic* Transfer log from `0xffff…fffe`, in 18 decimals.** If a customer ignores your pay button and just "sends USDC" from their wallet to your address, the receipt has no calldata and no log from `0x3600…` — but it does carry a `Transfer(from, to, value)` log emitted by `0xfffffffffffffffffffffffffffffffffffffffe` with an 18-decimal value. Match on both log sources and normalize to 6 decimals, or you will silently miss every manual payment. We found this on our first reconciliation test.
- **Reconcile with `eth_getLogs`, not Circle's Event Monitor.** Event Monitors subscribe per contract + event signature and cannot filter by recipient, so monitoring USDC `Transfer` on Arc means receiving every USDC transfer on the chain. A periodic `eth_getLogs` with `topics[2] = your address` across both log sources is precise and cheap; that is what `reconcile()` in `checkout.ts` does (scan from a stored block cursor, settle any pending order whose tagged amount matches).
- **A reverted `transfer` is the most common failure** and it's almost always insufficient balance — the faucet gives 20 USDC and our first test order was 27. Report `status: 0x0` to the customer as "transfer failed", not "not found".
- **Wallets disagree on the error code for an unknown chain.** MetaMask returns 4902, Rabby didn't. Treat any non-4001 error from `wallet_switchEthereumChain` as "try `wallet_addEthereumChain`".
- **Pages Functions can't hold a WebSocket**, so the primary path verifies on the client's report of the tx hash, and a cron-pinged reconcile endpoint (`eth_getLogs` to your address, both log sources) catches the case where the customer paid and closed the tab.

## Roadmap

- [x] Reconcile endpoint for payments that bypass the pay page (native sends, closed tabs)
- [ ] Per-chapter / per-lesson micropayments for our manga classes
- [ ] Packaging as a drop-in for Shopify / WooCommerce for other small creators in SEA and Japan

Not on the roadmap: a paymaster. On Arc the gas token *is* USDC, so a customer who can pay you can already pay for gas; sponsoring fees only matters for ERC-4337 smart accounts, which our customers don't use.

## License

MIT — Yume Moon Co., Ltd.

Built by [Daisuke Hiramura](https://www.linkedin.com/in/daisuke-hiramura-318002256), co-founder & CTO, Yume Moon Co., Ltd., Bangkok.
