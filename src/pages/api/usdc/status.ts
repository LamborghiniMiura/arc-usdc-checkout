// Astro + @astrojs/cloudflare binding for GET /api/usdc/status?orderId=
import type { APIRoute } from 'astro';
import { orderStatus } from '../../../lib/checkout';

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  const env = (locals as any).runtime?.env ?? import.meta.env;
  const r = await orderStatus(env, url.searchParams.get('orderId') ?? '');
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
