/**
 * merchant.ts — the ONE file a shop customizes.
 *
 * Everything else in this repo is generic. Implement these three hooks against your own
 * product catalog, shipping rules and FX source, and the API routes do the rest.
 *
 * The example below is a hard-coded catalog so the repo runs out of the box.
 */
import type { Order, OrderItem } from './orders';

export interface MerchantAdapter {
  /** ISO currency your prices are in. */
  fiatCurrency: string;

  /**
   * Resolve cart lines to priced items. Throw to reject the cart (unknown SKU, out of stock,
   * quantity limit). Return `physical: true` on items that need a shipping address.
   */
  resolveItems(lines: { sku: string; qty: number }[], lang?: string): Promise<(OrderItem & { physical: boolean })[]>;

  /** Shipping cost in fiat for a destination country (only called when a physical item is present). */
  shippingFor(country: string): number | null;

  /**
   * USDC per 1 unit of fiat at this moment. Include any margin you want here; the quote is
   * held for USDC_ORDER_TTL_MIN minutes. Returning a slightly worse rate than market
   * protects you from FX moves during the hold and from off-ramp spreads.
   */
  usdcPerFiat(env: Record<string, string | undefined>): Promise<number>;

  /** Called once when an order settles. Send an email, post to Discord, create a fulfilment task, etc. */
  onPaid?(order: Order, ctx: { txUrl: string; env: Record<string, string | undefined> }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Example adapter: two products, THB pricing, Discord webhook on payment.
// ---------------------------------------------------------------------------
const CATALOG: Record<string, { title: string; priceFiat: number; physical: boolean; maxQty?: number }> = {
  'zine-01': { title: 'Original manga zine vol.1', priceFiat: 280, physical: true, maxQty: 5 },
  'wallpaper-01': { title: 'Digital wallpaper pack', priceFiat: 90, physical: false },
};

const SHIPPING: Record<string, number> = { TH: 50, JP: 450 };

export const merchant: MerchantAdapter = {
  fiatCurrency: 'THB',

  async resolveItems(lines) {
    return lines.map(({ sku, qty }) => {
      const p = CATALOG[sku];
      if (!p) throw new Error(`unknown sku: ${sku}`);
      if (!Number.isInteger(qty) || qty < 1 || qty > (p.maxQty ?? 20)) throw new Error(`invalid qty for ${sku}`);
      return { sku, qty, title: p.title, unitFiat: p.priceFiat, physical: p.physical };
    });
  },

  shippingFor(country) {
    return SHIPPING[country] ?? null;
  },

  async usdcPerFiat(env) {
    // Simplest possible source: a fixed env var (e.g. refreshed daily by a cron job).
    // In production you might read a rates.json written by a scheduled task, or call an FX API.
    const thbPerUsdc = Number(env.USDC_THB_RATE ?? 32.5);
    const marginPct = Number(env.USDC_RATE_MARGIN_PCT ?? 1);
    return 1 / (thbPerUsdc * (1 - marginPct / 100));
  },

  async onPaid(order, { txUrl, env }) {
    if (!env.DISCORD_WEBHOOK_URL) return;
    const lines = order.items.map((i) => `- ${i.title} × ${i.qty}`).join('\n');
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: 'New order (USDC on Arc)',
          color: 0x2775ca,
          fields: [
            { name: 'Customer', value: `${order.customer.name} (${order.customer.email})` },
            { name: 'Total', value: `${order.totalFiat} ${order.fiatCurrency} = ${(order.paidMicro! / 1e6).toFixed(6)} USDC` },
            { name: 'Items', value: lines },
            { name: 'Ship to', value: order.customer.address ? `${order.customer.address.country} ${order.customer.address.postal} ${order.customer.address.line}` : '(digital)' },
            { name: 'Tx', value: txUrl },
            { name: 'Order', value: order.id },
          ],
          timestamp: order.paidAt,
        }],
      }),
    });
  },
};
