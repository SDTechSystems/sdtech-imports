/**
 * SD Tech Imports — API en la nube (Cloudflare Workers + KV).
 *
 * Además de las copias de seguridad:
 *   GET    /api/rate             tasa del dólar del día (TRM oficial), pública
 *   POST   /api/receipts         registra un recibo para su QR (requiere clave)
 *   DELETE /api/receipts/<cód>   marca un recibo como anulado (requiere clave)
 *   GET    /api/verify/<cód>     verifica un recibo, pública
 *   GET    /verificar/<cód>      página del recibo para el cliente (HTML), pública
 *
 * En recibos.sdtechsystems.dev solo se sirve la página del recibo: la app de
 * caja y la API de copias siguen en la dirección workers.dev.
 *
 * Copias de seguridad:
 *
 * La app sube su base de datos completa (el mismo JSON de "Exportar copia")
 * y este Worker la guarda en KV:
 *   backup:latest      la copia más reciente
 *   backup:previous    la copia anterior a la más reciente
 *   backup:AAAA-MM-DD  la última copia de cada día (hora de Colombia), 180 días
 *
 * Acceso: la primera clave que se usa queda registrada (solo su hash SHA-256).
 * Desde entonces cada petición debe enviar esa clave en
 * "Authorization: Bearer <clave>". Si existe el secreto BACKUP_TOKEN en el
 * Worker, se usa ese en lugar de la clave registrada.
 */

interface KVNamespace {
  get(key: string, type: 'text'): Promise<string | null>;
  getWithMetadata<M>(key: string, type: 'text'): Promise<{ value: string | null; metadata: M | null }>;
  put(key: string, value: string, options?: { metadata?: unknown; expirationTtl?: number }): Promise<void>;
  list<M>(options: { prefix: string; cursor?: string }): Promise<{
    keys: { name: string; metadata?: M }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

import { renderReceiptPage, RECEIPT_PAGE_HEADERS, BRAND_SITE, type ReceiptPageState } from './receipt-page';

/** Dominio público de los recibos (QR). */
const RECEIPTS_HOST = 'recibos.sdtechsystems.dev';

interface Env {
  BACKUPS: KVNamespace;
  BACKUP_TOKEN?: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

interface BackupMeta {
  savedAt: string;
  size: number;
  device?: string;
  transactions?: number;
  products?: number;
}

const AUTH_KEY = 'auth:hash';
const MAX_BODY = 20 * 1024 * 1024; // KV admite 25 MiB por valor
const DAILY_TTL = 180 * 24 * 60 * 60;
const MIN_KEY_LENGTH = 8;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Fecha AAAA-MM-DD en hora de Colombia. */
function colombiaDate(date = new Date()): string {
  return new Date(date.getTime() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

type AuthResult = { ok: true } | { ok: false; response: Response };

async function authorize(request: Request, env: Env, allowClaim: boolean): Promise<AuthResult> {
  const header = request.headers.get('authorization') || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (key.length < MIN_KEY_LENGTH) {
    return { ok: false, response: json({ error: 'missing_key' }, 401) };
  }

  if (env.BACKUP_TOKEN) {
    return safeEqual(key, env.BACKUP_TOKEN) ? { ok: true } : { ok: false, response: json({ error: 'wrong_key' }, 403) };
  }

  const hash = await sha256(key);
  const stored = await env.BACKUPS.get(AUTH_KEY, 'text');
  if (!stored) {
    if (!allowClaim) return { ok: false, response: json({ error: 'not_configured' }, 404) };
    await env.BACKUPS.put(AUTH_KEY, hash);
    return { ok: true };
  }
  return safeEqual(hash, stored) ? { ok: true } : { ok: false, response: json({ error: 'wrong_key' }, 403) };
}

// === Tasa de cambio ===

interface RateResponse {
  rate: number;
  date?: string;
  source: string;
}

const RATE_TTL = 6 * 60 * 60;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json();
}

/** TRM vigente hoy según la Superintendencia Financiera (datos.gov.co); si falla, un servicio público. */
async function currentRate(env: Env): Promise<RateResponse> {
  const today = colombiaDate();
  const cacheKey = `rate:${today}`;
  const cached = await env.BACKUPS.get(cacheKey, 'text');
  if (cached) return JSON.parse(cached) as RateResponse;

  let result: RateResponse | null = null;
  try {
    const where = encodeURIComponent(`vigenciadesde <= '${today}T00:00:00'`);
    const rows = (await fetchJson(
      `https://www.datos.gov.co/resource/32sa-8pi3.json?$where=${where}&$order=vigenciadesde%20DESC&$limit=1`,
    )) as { valor?: string; vigenciadesde?: string }[];
    const rate = Number(rows?.[0]?.valor);
    if (rate > 0) result = { rate, date: rows[0].vigenciadesde?.slice(0, 10), source: 'trm' };
  } catch {
    // se intenta el respaldo
  }
  if (!result) {
    const body = (await fetchJson('https://open.er-api.com/v6/latest/USD')) as { rates?: Record<string, number> };
    const rate = Number(body?.rates?.COP);
    if (!(rate > 0)) throw new Error('rate_unavailable');
    result = { rate: Math.round(rate * 100) / 100, date: today, source: 'open.er-api.com' };
  }
  await env.BACKUPS.put(cacheKey, JSON.stringify(result), { expirationTtl: RATE_TTL });
  return result;
}

// === Recibos verificables ===

interface PublicReceipt {
  code: string;
  receiptNumber: string;
  date: string;
  store: string;
  phone?: string;
  total: number;
  shippingFee?: number;
  items: { name: string; quantity: number; subtotal: number }[];
  status?: 'valid' | 'void';
}

const CONTACT_KEY = 'store:contact';

const CODE_RE = /^[2-9A-HJ-NP-Z]{8,16}$/;
const MAX_RECEIPT = 32 * 1024;

function cleanReceipt(raw: unknown): PublicReceipt | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.code !== 'string' || !CODE_RE.test(r.code)) return null;
  if (!Array.isArray(r.items)) return null;
  const text = (v: unknown, max: number) => String(v ?? '').slice(0, max);
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    code: r.code,
    receiptNumber: text(r.receiptNumber, 40),
    date: text(r.date, 40),
    store: text(r.store, 80),
    phone: r.phone ? text(r.phone, 30) : undefined,
    total: num(r.total),
    shippingFee: r.shippingFee ? num(r.shippingFee) : undefined,
    items: r.items.slice(0, 200).map((i) => {
      const it = (i ?? {}) as Record<string, unknown>;
      return { name: text(it.name, 120), quantity: num(it.quantity), subtotal: num(it.subtotal) };
    }),
    status: r.status === 'void' ? 'void' : 'valid',
  };
}

/** Busca el recibo en la última copia de seguridad (por si no se registró al vender). */
async function receiptFromBackup(env: Env, code: string): Promise<PublicReceipt | null> {
  const raw = await env.BACKUPS.get('backup:latest', 'text');
  if (!raw) return null;
  // Evita leer toda la copia si el código ni aparece.
  if (!raw.includes(code)) return null;
  type Tx = { id?: number; verifyCode?: string; receiptNumber?: string; date?: string; total?: number; shippingFee?: number; status?: string };
  type Item = { transactionId?: number; productName?: string; quantity?: number; subtotal?: number };
  const data = JSON.parse(raw) as { transactions?: Tx[]; transactionItems?: Item[]; storeSettings?: { storeName?: string; phone?: string }[] };
  const tx = data.transactions?.find((t) => t.verifyCode === code && t.status === 'completed');
  if (!tx) return null;
  const items = (data.transactionItems || []).filter((i) => i.transactionId === tx.id);
  return cleanReceipt({
    code,
    receiptNumber: tx.receiptNumber,
    date: tx.date,
    store: data.storeSettings?.[0]?.storeName || 'SD Tech Imports',
    phone: data.storeSettings?.[0]?.phone,
    total: tx.total,
    shippingFee: tx.shippingFee,
    items: items.map((i) => ({ name: i.productName, quantity: i.quantity, subtotal: i.subtotal })),
  });
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.BACKUPS) return json({ error: 'storage_unavailable' }, 503);

  if (url.pathname === '/api/rate' && request.method === 'GET') {
    try {
      return json(await currentRate(env));
    } catch {
      return json({ error: 'rate_unavailable' }, 502);
    }
  }

  const verifyMatch = url.pathname.match(/^\/api\/verify\/([^/]+)$/);
  if (verifyMatch && request.method === 'GET') {
    const code = decodeURIComponent(verifyMatch[1]).toUpperCase();
    if (!CODE_RE.test(code)) return json({ error: 'not_found' }, 404);
    const stored = await env.BACKUPS.get(`receipt:${code}`, 'text');
    const receipt = stored ? (JSON.parse(stored) as PublicReceipt) : await receiptFromBackup(env, code);
    if (!receipt) return json({ error: 'not_found' }, 404);
    return json({ receipt });
  }

  if (url.pathname === '/api/receipts' && request.method === 'POST') {
    const auth = await authorize(request, env, false);
    if (!auth.ok) return auth.response;
    const body = await request.text();
    if (body.length > MAX_RECEIPT) return json({ error: 'too_large' }, 413);
    let receipt: PublicReceipt | null = null;
    try {
      receipt = cleanReceipt(JSON.parse(body));
    } catch {
      receipt = null;
    }
    if (!receipt) return json({ error: 'invalid_receipt' }, 400);
    await env.BACKUPS.put(`receipt:${receipt.code}`, JSON.stringify({ ...receipt, status: 'valid' }));
    // El teléfono más reciente de la tienda, para los recibos que no lo traen.
    if (receipt.phone) await env.BACKUPS.put(CONTACT_KEY, receipt.phone);
    return json({ ok: true });
  }

  const receiptMatch = url.pathname.match(/^\/api\/receipts\/([^/]+)$/);
  if (receiptMatch && request.method === 'DELETE') {
    const auth = await authorize(request, env, false);
    if (!auth.ok) return auth.response;
    const code = decodeURIComponent(receiptMatch[1]).toUpperCase();
    if (!CODE_RE.test(code)) return json({ error: 'bad_code' }, 400);
    const stored = await env.BACKUPS.get(`receipt:${code}`, 'text');
    const receipt = stored ? (JSON.parse(stored) as PublicReceipt) : await receiptFromBackup(env, code);
    if (!receipt) return json({ error: 'not_found' }, 404);
    await env.BACKUPS.put(`receipt:${code}`, JSON.stringify({ ...receipt, status: 'void' }));
    return json({ ok: true });
  }

  // GET /api/status — ¿ya hay una clave registrada? (no requiere clave)
  if (url.pathname === '/api/status' && request.method === 'GET') {
    const configured = Boolean(env.BACKUP_TOKEN) || Boolean(await env.BACKUPS.get(AUTH_KEY, 'text'));
    return json({ configured });
  }

  // POST /api/connect — valida la clave; la registra si es la primera vez.
  if (url.pathname === '/api/connect' && request.method === 'POST') {
    const auth = await authorize(request, env, true);
    if (!auth.ok) return auth.response;
    const { metadata } = await env.BACKUPS.getWithMetadata<BackupMeta>('backup:latest', 'text');
    return json({ ok: true, latest: metadata });
  }

  if (url.pathname === '/api/backups' && request.method === 'GET') {
    const auth = await authorize(request, env, false);
    if (!auth.ok) return auth.response;
    const items: { key: string; meta: BackupMeta | null }[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.BACKUPS.list<BackupMeta>({ prefix: 'backup:', cursor });
      for (const k of page.keys) items.push({ key: k.name.slice('backup:'.length), meta: k.metadata ?? null });
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    items.sort((a, b) => (b.meta?.savedAt || '').localeCompare(a.meta?.savedAt || ''));
    return json({ items });
  }

  if (url.pathname === '/api/backup' && request.method === 'GET') {
    const auth = await authorize(request, env, false);
    if (!auth.ok) return auth.response;
    const key = url.searchParams.get('key') || 'latest';
    if (!/^(latest|previous|\d{4}-\d{2}-\d{2})$/.test(key)) return json({ error: 'bad_key' }, 400);
    const value = await env.BACKUPS.get(`backup:${key}`, 'text');
    if (value === null) return json({ error: 'not_found' }, 404);
    return new Response(value, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  if (url.pathname === '/api/backup' && request.method === 'PUT') {
    const auth = await authorize(request, env, true);
    if (!auth.ok) return auth.response;
    const body = await request.text();
    if (body.length > MAX_BODY) return json({ error: 'too_large' }, 413);

    let parsed: { version?: number; transactions?: unknown[]; products?: unknown[] };
    try {
      parsed = JSON.parse(body);
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.version) return json({ error: 'invalid_backup' }, 400);

    const meta: BackupMeta = {
      savedAt: new Date().toISOString(),
      size: body.length,
      device: (request.headers.get('x-device-name') || '').slice(0, 60) || undefined,
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions.length : 0,
      products: Array.isArray(parsed.products) ? parsed.products.length : 0,
    };

    const previous = await env.BACKUPS.getWithMetadata<BackupMeta>('backup:latest', 'text');
    if (previous.value !== null) {
      await env.BACKUPS.put('backup:previous', previous.value, { metadata: previous.metadata ?? undefined });
    }
    await env.BACKUPS.put('backup:latest', body, { metadata: meta });
    await env.BACKUPS.put(`backup:${colombiaDate()}`, body, { metadata: meta, expirationTtl: DAILY_TTL });
    return json({ ok: true, meta });
  }

  return json({ error: 'not_found' }, 404);
}

async function findReceipt(env: Env, code: string): Promise<PublicReceipt | null> {
  const stored = await env.BACKUPS.get(`receipt:${code}`, 'text');
  return stored ? (JSON.parse(stored) as PublicReceipt) : await receiptFromBackup(env, code);
}

/** GET /verificar/<código>: la página que abre el QR del recibo. */
async function receiptPage(env: Env, rawCode: string): Promise<Response> {
  const code = decodeURIComponent(rawCode).trim().toUpperCase().slice(0, 32);
  let state: ReceiptPageState;
  if (!CODE_RE.test(code)) {
    state = { kind: 'not_found', code };
  } else if (!env.BACKUPS) {
    state = { kind: 'error', code };
  } else {
    try {
      const receipt = await findReceipt(env, code);
      if (receipt && !receipt.phone) receipt.phone = (await env.BACKUPS.get(CONTACT_KEY, 'text')) || undefined;
      state = receipt ? { kind: 'receipt', receipt } : { kind: 'not_found', code };
    } catch {
      state = { kind: 'error', code };
    }
  }
  const { html, status } = renderReceiptPage(state);
  return new Response(html, { status, headers: RECEIPT_PAGE_HEADERS });
}

/** Lo que se puede abrir en el dominio de recibos: la página, sus recursos y la verificación. */
function allowedOnReceiptsHost(path: string): boolean {
  return (
    path.startsWith('/verificar/') ||
    path.startsWith('/recibo/') ||
    path.startsWith('/api/verify/') ||
    path === '/favicon.ico' ||
    path === '/robots.txt'
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === RECEIPTS_HOST && !allowedOnReceiptsHost(url.pathname)) {
      if (url.pathname === '/') return Response.redirect(BRAND_SITE, 302);
      const { html } = renderReceiptPage({ kind: 'not_found', code: '' });
      return new Response(html, { status: 404, headers: RECEIPT_PAGE_HEADERS });
    }

    const page = url.pathname.match(/^\/verificar\/([^/]+)\/?$/);
    if (page && (request.method === 'GET' || request.method === 'HEAD')) return receiptPage(env, page[1]);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: 'server_error', detail: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
