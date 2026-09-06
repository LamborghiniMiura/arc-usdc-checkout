// Astro + @astrojs/cloudflare binding for POST /api/usdc/confirm
import type { APIRoute } from 'astro';
import { confirmOrder } from '../../../lib/checkout';
import { merchant } from '../../../lib/merchant';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as any).runtime?.env ?? import.meta.env;
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const r = await confirmOrder(env, merchant, String(body?.orderId ?? ''), String(body?.txHash ?? ''));
  return json(r.body, r.status);
};

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
