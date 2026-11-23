import type { StoreSettings, Transaction, TransactionItemRecord } from '@/lib/db';
import { getCloudKey } from '@/lib/cloud-backup';

/**
 * Verificación de recibos por QR.
 *
 * Cada venta recibe un código aleatorio difícil de adivinar. El QR del recibo
 * abre https://<tu-app>/verificar/<código>; esa página pregunta al Worker
 * (GET /api/verify/<código>), que responde con los datos básicos de la venta
 * si el recibo existe. Así cualquiera puede comprobar que el recibo salió de
 * tu sistema, pero nadie puede listar tus ventas.
 */

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // sin 0/O, 1/I/L

export function generateVerifyCode(length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function isValidVerifyCode(code: string): boolean {
  return /^[2-9A-HJ-NP-Z]{8,16}$/.test(code);
}

/** Dirección pública para el QR. En la app instalada (Android) hay que configurarla. */
export function getVerifyBaseUrl(settings?: Pick<StoreSettings, 'verifyBaseUrl'>): string {
  const configured = settings?.verifyBaseUrl?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (typeof window !== 'undefined' && window.location.protocol === 'https:' && !/localhost/.test(window.location.hostname)) {
    return window.location.origin;
  }
  return '';
}

export function verifyUrl(baseUrl: string, code: string): string {
  return `${baseUrl}/verificar/${code}`;
}

export interface PublicReceipt {
  code: string;
  receiptNumber: string;
  date: string;
  store: string;
  total: number;
  shippingFee?: number;
  items: { name: string; quantity: number; subtotal: number }[];
  status?: 'valid' | 'void';
}

export function toPublicReceipt(
  tx: Transaction,
  items: TransactionItemRecord[],
  storeName: string,
): PublicReceipt | null {
  if (!tx.verifyCode) return null;
  return {
    code: tx.verifyCode,
    receiptNumber: tx.receiptNumber,
    date: new Date(tx.date).toISOString(),
    store: storeName,
    total: tx.total,
    shippingFee: tx.shippingFee || undefined,
    items: items.map((i) => ({ name: i.productName, quantity: i.quantity, subtotal: i.subtotal })),
    status: 'valid',
  };
}

/**
 * Registra el recibo en la nube para que el QR funcione de inmediato.
 * Si no hay conexión o la nube no está conectada no pasa nada: el Worker
 * también busca el código en la última copia de seguridad.
 */
export async function registerReceipt(receipt: PublicReceipt | null): Promise<void> {
  const key = getCloudKey();
  if (!receipt || !key) return;
  try {
    await fetch('/api/receipts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(receipt),
    });
  } catch {
    // sin conexión: queda cubierto por la copia en la nube
  }
}

/** Marca el recibo como anulado (por ejemplo al borrar la venta). */
export async function voidReceipt(code?: string): Promise<void> {
  const key = getCloudKey();
  if (!code || !key) return;
  try {
    await fetch(`/api/receipts/${encodeURIComponent(code)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch {
    // sin conexión
  }
}

export type VerifyResult =
  | { status: 'valid'; receipt: PublicReceipt }
  | { status: 'void'; receipt: PublicReceipt }
  | { status: 'not_found' }
  | { status: 'error' };

export async function verifyReceiptOnline(code: string): Promise<VerifyResult> {
  try {
    const res = await fetch(`/api/verify/${encodeURIComponent(code)}`, { cache: 'no-store' });
    if (res.status === 404) return { status: 'not_found' };
    if (!res.ok) return { status: 'error' };
    const body = await res.json();
    if (body?.receipt) return { status: body.receipt.status === 'void' ? 'void' : 'valid', receipt: body.receipt };
    return { status: 'not_found' };
  } catch {
    return { status: 'error' };
  }
}
