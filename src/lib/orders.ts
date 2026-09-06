/**
 * orders.ts — order state on Cloudflare KV (or any KV-like store).
 *
 * Keys:
 *   order:<orderId>   -> Order JSON. TTL = quote expiry + 30 days (keeps paid records).
 *   tx:<txHash>       -> orderId. Prevents one tx from settling two orders.
 *   pending:<orderId> -> "1". Enumerable index of open orders; expires with the quote.
 *
 * When the KV binding is absent (local dev) an in-process Map is used instead.
 */

export type OrderStatus = 'pending' | 'paid' | 'expired';

export interface OrderItem {
  sku: string;
  qty: number;
  title: string;
  unitFiat: number;
}

export interface Customer {
  name: string;
  email: string;
  address?: { country: string; postal: string; line: string };
}

export interface Order {
  id: string;
  status: OrderStatus;
  lang?: string;
  items: OrderItem[];
  fiatCurrency: string; // ISO code, e.g. "THB"
  shippingFiat: number;
  totalFiat: number;
  /** USDC per 1 unit of fiat at quote time. Stored so accounting can use the quoted rate. */
  usdcPerFiat: number;
  /** exact amount the customer must send, in micro-USDC (tag included) */
  amountMicro: number;
  receiver: string;
  chainId: number;
  createdAt: string;
  expiresAt: string;
  customer: Customer;
  // set on settlement
  txHash?: string;
  payer?: string;
  paidMicro?: number;
  paidAt?: string;
}

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

const mem = new Map<string, { v: string; exp: number | null }>();
export const memoryKV: KVLike = {
  async get(k) {
    const e = mem.get(k);
    if (!e) return null;
    if (e.exp && Date.now() > e.exp) { mem.delete(k); return null; }
    return e.v;
  },
  async put(k, v, o) { mem.set(k, { v, exp: o?.expirationTtl ? Date.now() + o.expirationTtl * 1000 : null }); },
  async delete(k) { mem.delete(k); },
  async list({ prefix }) {
    return { keys: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
  },
};

let warned = false;
export function getStore(env: Record<string, unknown>, binding = 'ORDERS'): KVLike {
  const kv = env[binding] as KVLike | undefined;
  if (kv && typeof kv.get === 'function') return kv;
  if (!warned) { console.warn(`[usdc] KV binding ${binding} not found — using in-memory store (dev only)`); warned = true; }
  return memoryKV;
}

const KEEP_AFTER_SEC = 30 * 24 * 3600;
const secondsUntil = (iso: string) => Math.max(60, Math.floor((Date.parse(iso) - Date.now()) / 1000));

export async function saveOrder(kv: KVLike, o: Order) {
  await kv.put(`order:${o.id}`, JSON.stringify(o), { expirationTtl: secondsUntil(o.expiresAt) + KEEP_AFTER_SEC });
  if (o.status === 'pending') await kv.put(`pending:${o.id}`, '1', { expirationTtl: secondsUntil(o.expiresAt) });
  else await kv.delete(`pending:${o.id}`);
}

export async function loadOrder(kv: KVLike, id: string): Promise<Order | null> {
  const raw = await kv.get(`order:${id}`);
  if (!raw) return null;
  const o = JSON.parse(raw) as Order;
  if (o.status === 'pending' && Date.now() > Date.parse(o.expiresAt)) {
    o.status = 'expired';
    await saveOrder(kv, o);
  }
  return o;
}

/** Lock a tx hash to an order. Returns false if another order already claimed it. */
export async function claimTx(kv: KVLike, txHash: string, orderId: string): Promise<boolean> {
  const key = `tx:${txHash.toLowerCase()}`;
  const existing = await kv.get(key);
  if (existing && existing !== orderId) return false;
  await kv.put(key, orderId, { expirationTtl: KEEP_AFTER_SEC });
  return true;
}

export async function listPendingIds(kv: KVLike): Promise<string[]> {
  const { keys } = await kv.list({ prefix: 'pending:' });
  return keys.map((k) => k.name.slice('pending:'.length));
}
