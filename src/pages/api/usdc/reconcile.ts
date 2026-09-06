// Astro + @astrojs/cloudflare binding for GET /api/usdc/reconcile
// Protect with a bearer token and ping it from a cron every few minutes.
import type { APIRoute } from 'astro';
import { reconcile } from '../../../lib/checkout';
import { merchant } from '../../../lib/merchant';

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = (locals as any).runtime?.env ?? import.meta.env;
  const token = env.USDC_ADMIN_TOKEN;
  if (!token || request.headers.get('authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
  const fromBlock = Number(url.searchParams.get('from'));
  const r = await reconcile(env, merchant, Number.isFinite(fromBlock) && fromBlock > 0 ? { fromBlock } : {});
  return new Response(JSON.stringify(r.body, null, 2), { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
};
