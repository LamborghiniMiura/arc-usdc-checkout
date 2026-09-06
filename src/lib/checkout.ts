/**
 * checkout.ts — framework-agnostic handlers. Wire them to your router of choice
 * (Astro endpoints, Hono, Cloudflare Worker fetch handler, Next.js route handlers...).
 *
 * Each handler takes (env, body/params) and returns { status, body }.
 */
import { getArcConfig, type Env } from './config';
import { fiatToBaseMicro, withTag, randomTag, newOrderId, formatMicro, ORDER_ID_RE, TX_HASH_RE } from './amount';
import { getReceipt, findIncomingTransfer, txUrl } from './rpc';
import { getStore, saveOrder, loadOrder, claimTx, type Order, type Customer } from './orders';
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
