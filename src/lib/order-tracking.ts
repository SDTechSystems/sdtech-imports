import { db, type OrderTracking, type Product, type StoreSettings, type Transaction, type TransactionItemRecord, type TrackingEvent, type TrackingStage } from '@/lib/db';
import { getCloudKey } from '@/lib/cloud-backup';
import { generateVerifyCode, getVerifyBaseUrl } from '@/lib/receipt-verify';

/**
 * Seguimiento de pedidos pagados por adelantado.
 *
 * La tienda registra el pedido y lo va actualizando a mano (etapa, ciudad y
 * una nota). Cada pedido tiene un código aleatorio; el cliente abre
 * https://recibos.sdtechsystems.dev/seguimiento/<código> y ve el estado actual
 * con todo el historial. Igual que los recibos: nadie puede listar pedidos.
 */

/** Etapas en el orden en que normalmente pasa un pedido. `issue` es una novedad en cualquier punto. */
export const TRACKING_STAGES: TrackingStage[] = [
  'confirmed',
  'purchased',
  'origin_warehouse',
  'international_transit',
  'customs',
  'national_transit',
  'ready',
  'delivered',
  'issue',
];

/** Etapas del camino normal (sin la novedad), para la barra de progreso. */
export const PROGRESS_STAGES: TrackingStage[] = TRACKING_STAGES.filter((s) => s !== 'issue');

export function isTrackingStage(value: unknown): value is TrackingStage {
  return typeof value === 'string' && (TRACKING_STAGES as string[]).includes(value);
}

export function newTrackingCode(): string {
  return generateVerifyCode(10);
}

export function newEventId(): string {
  return crypto.randomUUID();
}

/** Eventos del más reciente al más antiguo. */
export function sortEvents(events: TrackingEvent[]): TrackingEvent[] {
  return [...events].sort((a, b) => b.date.localeCompare(a.date));
}

/** La etapa actual es la del evento más reciente. */
export function currentStage(events: TrackingEvent[]): TrackingStage {
  return sortEvents(events)[0]?.stage ?? 'confirmed';
}

/** La última ciudad informada (puede venir de un evento anterior). */
export function currentCity(events: TrackingEvent[]): string | undefined {
  return sortEvents(events).find((e) => e.city?.trim())?.city?.trim();
}

/**
 * Qué tan avanzado va el pedido (0 a 1) según la etapa más lejana alcanzada.
 * Una novedad no hace retroceder la barra.
 */
export function trackingProgress(events: TrackingEvent[]): number {
  let furthest = 0;
  for (const e of events) {
    const i = PROGRESS_STAGES.indexOf(e.stage);
    if (i > furthest) furthest = i;
  }
  return PROGRESS_STAGES.length > 1 ? furthest / (PROGRESS_STAGES.length - 1) : 0;
}

export function trackingUrl(settings: Pick<StoreSettings, 'verifyBaseUrl'> | undefined, code: string): string {
  return `${getVerifyBaseUrl(settings)}/seguimiento/${code}`;
}

export interface PublicTracking {
  code: string;
  store: string;
  phone?: string;
  title: string;
  items?: { name: string; quantity: number }[];
  prepaid: boolean;
  estimatedDate?: string; // AAAA-MM-DD
  createdAt: string; // ISO
  events: { stage: TrackingStage; city?: string; note?: string; date: string }[];
}

/** Lo que ve el cliente: sin precios, sin notas internas y sin datos del cliente. */
export function toPublicTracking(order: OrderTracking, storeName: string, phone?: string): PublicTracking {
  return {
    code: order.code,
    store: storeName,
    phone: phone?.trim() || undefined,
    title: order.title.trim(),
    items: order.items?.length ? order.items.map((i) => ({ name: i.name, quantity: i.quantity })) : undefined,
    prepaid: order.prepaid !== false,
    estimatedDate: order.estimatedDate || undefined,
    createdAt: new Date(order.createdAt).toISOString(),
    events: sortEvents(order.events).map((e) => ({
      stage: e.stage,
      city: e.city?.trim() || undefined,
      note: e.note?.trim() || undefined,
      date: e.date,
    })),
  };
}

/** Resultado de publicar: `offline` si no hay nube conectada o no hubo conexión. */
export type PublishResult = 'ok' | 'offline' | 'error';

/** Sube el estado del pedido a la nube para que el enlace del cliente lo muestre. */
export async function publishTracking(data: PublicTracking): Promise<PublishResult> {
  const key = getCloudKey();
  if (!key) return 'offline';
  try {
    const res = await fetch('/api/tracking', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(data),
    });
    return res.ok ? 'ok' : 'error';
  } catch {
    return 'offline';
  }
}

/** Quita el pedido de la nube (el enlace deja de mostrarlo). */
export async function unpublishTracking(code: string): Promise<void> {
  const key = getCloudKey();
  if (!key) return;
  try {
    await fetch(`/api/tracking/${encodeURIComponent(code)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch {
    // sin conexión
  }
}

/** Productos de la venta que se piden por encargo (los locales no llevan seguimiento). */
export function preorderItems(
  items: Pick<TransactionItemRecord, 'productId' | 'productName' | 'quantity'>[],
  products: Pick<Product, 'id' | 'preorder'>[],
): { name: string; quantity: number }[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  return items.filter((i) => byId.get(i.productId)?.preorder).map((i) => ({ name: i.productName, quantity: i.quantity }));
}

/** Título del pedido: el primer producto y cuántos más. */
export function titleForItems(items: { name: string }[]): string {
  if (!items.length) return '';
  return items.length === 1 ? items[0].name : `${items[0].name} + ${items.length - 1}`;
}

/**
 * Al cobrar una venta: si lleva productos por encargo crea su seguimiento (o
 * actualiza el que ya tenía esa venta) y lo publica. Devuelve el código, que
 * va en el recibo para que su QR lleve también al seguimiento. Una venta solo
 * con productos locales no tiene seguimiento.
 */
export async function syncSaleTracking(
  tx: Transaction & { id: number },
  items: TransactionItemRecord[],
  settings: Pick<StoreSettings, 'storeName' | 'phone'> | undefined,
): Promise<string | undefined> {
  const products = await db.products.bulkGet(items.map((i) => i.productId));
  const ordered = preorderItems(items, products.filter((p): p is Product => !!p));
  const existing = await db.orderTrackings.where('transactionId').equals(tx.id).first();
  if (!ordered.length) return undefined;

  const customer = tx.customerId ? await db.customers.get(tx.customerId) : undefined;
  const paid = tx.total - (tx.debtAmount ?? 0);
  const base = {
    items: ordered,
    customerId: tx.customerId,
    customerName: tx.customerName,
    customerPhone: customer?.phone || undefined,
    amountPaid: paid > 0 ? paid : undefined,
    prepaid: !(tx.debtAmount && tx.debtAmount > 0),
  };
  let order: OrderTracking;
  if (existing?.id) {
    await db.orderTrackings.update(existing.id, base);
    order = { ...existing, ...base };
  } else {
    order = {
      ...base,
      code: newTrackingCode(),
      title: titleForItems(ordered),
      transactionId: tx.id,
      status: 'confirmed',
      events: [{ id: newEventId(), stage: 'confirmed', date: new Date().toISOString() }],
      createdAt: new Date(),
    };
    order.id = (await db.orderTrackings.add(order)) as number;
  }
  void publishTracking(toPublicTracking(order, settings?.storeName || 'SD Tech Imports', settings?.phone));
  return order.code;
}

/** Al borrar una venta se borra también su seguimiento. */
export async function removeSaleTracking(transactionId: number): Promise<void> {
  const linked = await db.orderTrackings.where('transactionId').equals(transactionId).toArray();
  for (const o of linked) {
    await db.orderTrackings.delete(o.id!);
    await db.deletedRecords.add({ tableName: 'orderTrackings', recordId: o.id!, deletedAt: new Date(), syncedAt: null });
    void unpublishTracking(o.code);
  }
}
