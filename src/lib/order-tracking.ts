import type { OrderTracking, StoreSettings, TrackingEvent, TrackingStage } from '@/lib/db';
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
