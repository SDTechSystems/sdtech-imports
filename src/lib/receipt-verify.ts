import type { StoreSettings, Transaction, TransactionItemRecord } from '@/lib/db';
import { getCloudKey } from '@/lib/cloud-backup';

/**
 * Verificación de recibos por QR.
 *
 * Cada venta recibe un código aleatorio difícil de adivinar. El QR del recibo
 * abre https://recibos.sdtechsystems.dev/verificar/<código>, una página que
 * arma el Worker (worker/receipt-page.ts) con los datos básicos de la venta.
 * El cliente ve su compra en línea, pero nadie puede listar tus ventas.
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

/** Dirección pública de los recibos (el mismo Worker, en el dominio de la marca). */
export const DEFAULT_VERIFY_BASE_URL = 'https://recibos.sdtechsystems.dev';

/** Dirección que lleva el QR: la configurada en Ajustes → Recibo o la de la marca. */
export function getVerifyBaseUrl(settings?: Pick<StoreSettings, 'verifyBaseUrl'>): string {
  const configured = settings?.verifyBaseUrl?.trim().replace(/\/+$/, '');
  return configured || DEFAULT_VERIFY_BASE_URL;
}

export function verifyUrl(baseUrl: string, code: string): string {
  return `${baseUrl}/verificar/${code}`;
}

export interface PublicReceipt {
  code: string;
  receiptNumber: string;
  date: string;
  store: string;
  phone?: string;
  total: number;
  shippingFee?: number;
  items: { name: string; quantity: number; subtotal: number }[];
  status?: 'valid' | 'void';
  trackingCode?: string; // pedido por encargo: la página del recibo enlaza su seguimiento
}

export function toPublicReceipt(
  tx: Transaction,
  items: TransactionItemRecord[],
  storeName: string,
  phone?: string,
  trackingCode?: string,
): PublicReceipt | null {
  if (!tx.verifyCode) return null;
  return {
    code: tx.verifyCode,
    receiptNumber: tx.receiptNumber,
    date: new Date(tx.date).toISOString(),
    store: storeName,
    phone: phone?.trim() || undefined,
    total: tx.total,
    shippingFee: tx.shippingFee || undefined,
    items: items.map((i) => ({ name: i.productName, quantity: i.quantity, subtotal: i.subtotal })),
    status: 'valid',
    trackingCode,
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
