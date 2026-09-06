/**
 * amount.ts — fiat → USDC conversion and amount-based order identification.
 *
 * An ERC-20 transfer carries no memo, so we identify the order by the amount itself:
 *   - the first 3 decimals (0.001 USDC) carry the quoted price
 *   - the last 3 decimals (0.000001 USDC) carry a per-order tag in 1..999
 *
 *   quoted 12.345 USDC + tag 217  ->  12.345217 USDC  (12_345_217 micro-USDC)
 *
 * This lets a merchant accept payments to a single plain address with no contract to
 * deploy or audit. 999 simultaneous pending orders at the same price is enough for a
 * small merchant; a larger one can widen TAG_DIGITS.
 */
import { USDC_DECIMALS } from './config';

const TAG_DIGITS = 3;
const TAG_RANGE = 10 ** TAG_DIGITS;

/** fiat total -> quoted amount in micro-USDC, rounded UP to 0.001 USDC (merchant never loses on rounding). */
export function fiatToBaseMicro(totalFiat: number, usdcPerFiat: number): number {
  if (!(usdcPerFiat > 0)) throw new Error('rate must be > 0');
  const usdc = totalFiat * usdcPerFiat;
  const milli = Math.ceil(usdc * 1000 - 1e-9);
  return milli * TAG_RANGE;
}

/** Attach the per-order tag to a quoted amount. */
export function withTag(baseMicro: number, tag: number): number {
  if (!Number.isInteger(tag) || tag < 1 || tag >= TAG_RANGE) throw new Error(`tag out of range: ${tag}`);
  if (baseMicro % TAG_RANGE !== 0) throw new Error('baseMicro must be a multiple of 0.001 USDC');
  return baseMicro + tag;
}

/** micro-USDC -> display string, e.g. 12345217 -> "12.345217" */
export function formatMicro(micro: number): string {
  const s = Math.trunc(micro).toString().padStart(USDC_DECIMALS + 1, '0');
  return `${s.slice(0, -USDC_DECIMALS)}.${s.slice(-USDC_DECIMALS)}`;
}

export function randomTag(): number {
  const buf = new Uint16Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % (TAG_RANGE - 1)) + 1;
}

/** Short, unguessable order id safe for URLs. */
export function newOrderId(): string {
  const buf = new Uint8Array(9);
  crypto.getRandomValues(buf);
  return 'u' + Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const ORDER_ID_RE = /^u[0-9a-f]{18}$/;
export const TX_HASH_RE = /^0x[0-9a-f]{64}$/;
