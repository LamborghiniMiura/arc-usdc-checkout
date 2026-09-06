/**
 * checkout.ts — framework-agnostic handlers. Wire them to your router of choice
 * (Astro endpoints, Hono, Cloudflare Worker fetch handler, Next.js route handlers...).
 *
 * Each handler takes (env, body/params) and returns { status, body }.
 */
import { getArcConfig, type Env } from './config';
import { fiatToBaseMicro, withTag, randomTag, newOrderId, formatMicro, ORDER_ID_RE, TX_HASH_RE } from './amount';
import { getReceipt, findIncomingTransfer, txUrl, rpc, logAmountToMicro, NATIVE_TRANSFER_LOG_ADDRESS, type Log } from './rpc';
import { getStore, saveOrder, loadOrder, claimTx, listPendingIds, type Order, type Customer } from './orders';
import type { MerchantAdapter } from './merchant';

export interface Result { status: number; body: unknown }
const ok = (body: unknown): Result => ({ status: 200, body });
const err = (status: number, error: string, extra: object = {}): Result => ({ status, body: { error, ...extra } });

export interface CreateRequest {
  lang?: string;
  items: { sku: string; qty: number }[];
  customer: { name: string; email: string; address?: { country: string; postal: string; line: string } };
}

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
  usdcPerFiat: number;
  expiresAt: string;
}

/** POST /api/usdc/create */
export async function createOrder(env: Env & Record<string, unknown>, merchant: MerchantAdapter, req: CreateRequest): Promise<Result> {
  let cfg;
  try { cfg = getArcConfig(env); } catch (e) { return err(500, (e as Error).message); }

  if (!Array.isArray(req.items) || req.items.length === 0) return err(400, 'empty items');
  const customer = parseCustomer(req.customer);
  if (!customer) return err(400, 'invalid customer');

  let items;
  try { items = await merchant.resolveItems(req.items, req.lang); } catch (e) { return err(400, (e as Error).message); }

  const hasPhysical = items.some((i) => i.physical);
  if (hasPhysical && !customer.address) return err(400, 'address required for physical items');
  if (!hasPhysical) delete customer.address;

  let shippingFiat = 0;
  if (hasPhysical) {
    const s = merchant.shippingFor(customer.address!.country);
    if (s === null) return err(400, 'shipping not available for country');
    shippingFiat = s;
  }
  const subtotal = items.reduce((a, i) => a + i.unitFiat * i.qty, 0);
  const totalFiat = subtotal + shippingFiat;

  const usdcPerFiat = await merchant.usdcPerFiat(env);
  const amountMicro = withTag(fiatToBaseMicro(totalFiat, usdcPerFiat), randomTag());

  const now = Date.now();
  const order: Order = {
    id: newOrderId(),
    status: 'pending',
    lang: req.lang,
    items: items.map(({ physical: _p, ...rest }) => rest),
    fiatCurrency: merchant.fiatCurrency,
    shippingFiat,
    totalFiat,
    usdcPerFiat,
    amountMicro,
    receiver: cfg.receiver,
    chainId: cfg.chainId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + cfg.orderTtlMs).toISOString(),
    customer,
  };
  await saveOrder(getStore(env), order);

  const quote: Quote = {
    orderId: order.id,
    chainId: cfg.chainId,
    chainName: cfg.chainName,
    rpcUrl: cfg.rpcUrl,
    explorerUrl: cfg.explorerUrl,
    usdcAddress: cfg.usdcAddress,
    receiver: cfg.receiver,
    amountMicro,
    amount: formatMicro(amountMicro),
    totalFiat,
    shippingFiat,
    fiatCurrency: merchant.fiatCurrency,
    usdcPerFiat,
    expiresAt: order.expiresAt,
  };
  return ok(quote);
}

/**
 * POST /api/usdc/confirm  { orderId, txHash }
 * Returns status: 'paid' | 'pending' (receipt not yet available; client should retry)
 *              | 'mismatch' (with reason: 'tx reverted' | 'no transfer to merchant' | 'underpaid' | 'tx already used')
 *              | 'expired'
 */
export async function confirmOrder(env: Env & Record<string, unknown>, merchant: MerchantAdapter, orderId: string, txHash: string): Promise<Result> {
  let cfg;
  try { cfg = getArcConfig(env); } catch (e) { return err(500, (e as Error).message); }
  txHash = String(txHash ?? '').toLowerCase();
  if (!ORDER_ID_RE.test(orderId) || !TX_HASH_RE.test(txHash)) return err(400, 'invalid request');

  const kv = getStore(env);
  const order = await loadOrder(kv, orderId);
  if (!order) return err(404, 'order not found');
  if (order.status === 'paid') return ok({ status: 'paid', orderId, txHash: order.txHash });
  if (order.status === 'expired') return ok({ status: 'expired', orderId });

  const receipt = await getReceipt(cfg, txHash);
  if (!receipt) return ok({ status: 'pending', orderId, reason: 'receipt not yet available' });

  const transfer = findIncomingTransfer(cfg, receipt);
  if (!transfer) {
    return { status: 422, body: { status: 'mismatch', orderId, reason: receipt.status !== '0x1' ? 'tx reverted' : 'no transfer to merchant' } };
  }
  if (!(await claimTx(kv, txHash, orderId))) return { status: 409, body: { status: 'mismatch', orderId, reason: 'tx already used' } };
  if (transfer.amountMicro < order.amountMicro) {
    return { status: 422, body: { status: 'mismatch', orderId, reason: 'underpaid', expected: formatMicro(order.amountMicro), received: formatMicro(transfer.amountMicro) } };
  }

  order.status = 'paid';
  order.txHash = txHash;
  order.payer = transfer.from;
  order.paidMicro = transfer.amountMicro;
  order.paidAt = new Date().toISOString();
  await saveOrder(kv, order);

  try { await merchant.onPaid?.(order, { txUrl: txUrl(cfg, txHash), env }); } catch (e) { console.error('onPaid failed', e); }

  return ok({ status: 'paid', orderId, txHash, overpaidMicro: transfer.amountMicro - order.amountMicro });
}

/** GET /api/usdc/status?orderId= — safe to expose; returns no customer data. */
export async function orderStatus(env: Env & Record<string, unknown>, orderId: string): Promise<Result> {
  if (!ORDER_ID_RE.test(orderId)) return err(400, 'invalid orderId');
  const o = await loadOrder(getStore(env), orderId);
  if (!o) return err(404, 'not found');
  return ok({
    orderId: o.id,
    status: o.status,
    amount: formatMicro(o.amountMicro),
    totalFiat: o.totalFiat,
    fiatCurrency: o.fiatCurrency,
    expiresAt: o.expiresAt,
    txHash: o.txHash ?? null,
    items: o.items.map((i) => ({ title: i.title, qty: i.qty })),
  });
}

/**
 * Reconcile — settle pending orders whose payment never went through /confirm
 * (customer paid straight from their wallet, or closed the tab before polling finished).
 *
 * Scans eth_getLogs for Transfer(*, merchant, *) from BOTH log sources (ERC-20 and the native
 * synthetic log), from a stored block cursor to the chain tip, and matches amounts against open
 * orders. Idempotent; call it from a cron every few minutes with an admin token in front of it.
 */
export async function reconcile(
  env: Env & Record<string, unknown>,
  merchant: MerchantAdapter,
  opts: { lookbackBlocks?: number; fromBlock?: number; graceMs?: number; maxRange?: number } = {},
): Promise<Result> {
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const CURSOR_KEY = 'reconcile:cursor';
  const { lookbackBlocks = 7200, graceMs = 15 * 60_000, maxRange = 2000 } = opts;

  let cfg;
  try { cfg = getArcConfig(env); } catch (e) { return err(500, (e as Error).message); }
  const kv = getStore(env);

  const candidates: Order[] = [];
  for (const id of await listPendingIds(kv)) {
    const o = await loadOrder(kv, id);
    if (!o) continue;
    if (o.status === 'pending' || (o.status === 'expired' && Date.now() - Date.parse(o.expiresAt) < graceMs)) candidates.push(o);
  }

  const latest = parseInt(await rpc<string>(cfg, 'eth_blockNumber', []), 16);
  const cursor = await kv.get(CURSOR_KEY);
  const from = opts.fromBlock ?? (cursor ? Number(cursor) + 1 : Math.max(0, latest - lookbackBlocks));
  if (from > latest) return ok({ scanned: 0, matched: [], latest });
  if (candidates.length === 0) { await kv.put(CURSOR_KEY, String(latest)); return ok({ scanned: latest - from + 1, matched: [], latest }); }

  const byAmount = new Map<number, Order>(candidates.map((o) => [o.amountMicro, o]));
  const receiverTopic = '0x' + cfg.receiver.slice(2).padStart(64, '0');
  const matched: { orderId: string; txHash: string; amount: string }[] = [];

  for (let start = from; start <= latest; start += maxRange) {
    const end = Math.min(start + maxRange - 1, latest);
    const logs = await rpc<(Log & { transactionHash: string })[]>(cfg, 'eth_getLogs', [{
      address: [cfg.usdcAddress, NATIVE_TRANSFER_LOG_ADDRESS],
      topics: [TRANSFER_TOPIC, null, receiverTopic],
      fromBlock: '0x' + start.toString(16),
      toBlock: '0x' + end.toString(16),
    }]);
    for (const log of logs) {
      const micro = logAmountToMicro(cfg, log);
      if (micro === null) continue;
      const order = byAmount.get(Number(micro));
      if (!order) continue;
      const txHash = log.transactionHash.toLowerCase();
      if (!(await claimTx(kv, txHash, order.id))) continue;
      order.status = 'paid';
      order.txHash = txHash;
      order.payer = ('0x' + log.topics[1].slice(-40)).toLowerCase();
      order.paidMicro = Number(micro);
      order.paidAt = new Date().toISOString();
      await saveOrder(kv, order);
      byAmount.delete(Number(micro));
      matched.push({ orderId: order.id, txHash, amount: formatMicro(order.paidMicro) });
      try { await merchant.onPaid?.(order, { txUrl: txUrl(cfg, txHash), env }); } catch (e) { console.error('onPaid failed', e); }
    }
  }
  await kv.put(CURSOR_KEY, String(latest));
  return ok({ scanned: latest - from + 1, from, latest, candidates: candidates.length, matched });
}

function parseCustomer(c: CreateRequest['customer'] | undefined): Customer | null {
  if (!c || typeof c !== 'object') return null;
  const name = String(c.name ?? '').trim().slice(0, 100);
  const email = String(c.email ?? '').trim().slice(0, 200);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  const out: Customer = { name, email };
  if (c.address && typeof c.address === 'object') {
    const country = String(c.address.country ?? '').trim().toUpperCase().slice(0, 2);
    const postal = String(c.address.postal ?? '').trim().slice(0, 20);
    const line = String(c.address.line ?? '').trim().slice(0, 300);
    if (country.length !== 2 || !postal || !line) return null;
    out.address = { country, postal, line };
  }
  return out;
}
