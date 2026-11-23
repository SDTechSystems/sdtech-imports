import { db, type ImportOrigin, type StockIn } from '@/lib/db';

/**
 * Compras de importación (Amazon en dólares, envíos desde EE. UU. y China).
 *
 * El precio se escribe en dólares; la app lo pasa a pesos con la tasa del día
 * del pago y le suma el envío. Mientras la compra está "en tránsito" no suma al
 * inventario: solo entra (y recalcula el costo promedio) cuando se marca como
 * recibida.
 */

export const ORIGINS: ImportOrigin[] = ['US', 'CN', 'CO', 'OTHER'];

export const ORIGIN_FLAG: Record<ImportOrigin, string> = {
  US: '🇺🇸',
  CN: '🇨🇳',
  CO: '🇨🇴',
  OTHER: '🌎',
};

export const formatUsd = (n: number) =>
  `US$ ${n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface LandedCostInput {
  quantity: number;
  usdUnitPrice: number;
  exchangeRate: number;
  shippingCost?: number;
}

export interface LandedCost {
  productCop: number; // dólares convertidos a pesos
  shippingCop: number;
  totalCop: number;
  unitCop: number; // costo por unidad en pesos (producto + envío repartido)
}

/** Convierte la compra a pesos y reparte el envío entre las unidades. */
export function landedCost({ quantity, usdUnitPrice, exchangeRate, shippingCost = 0 }: LandedCostInput): LandedCost {
  const qty = quantity > 0 ? quantity : 0;
  const productCop = Math.round(qty * usdUnitPrice * exchangeRate);
  const shippingCop = Math.max(0, Math.round(shippingCost));
  const totalCop = productCop + shippingCop;
  const unitCop = qty > 0 ? Math.round(totalCop / qty) : 0;
  return { productCop, shippingCop, totalCop, unitCop };
}

export interface OrderLineInput {
  quantity: number;
  unitPrice: number; // en la moneda del pedido
}

export interface OrderLineCost {
  productCop: number;
  shippingCop: number; // parte del envío que le toca a esta línea
  totalCop: number;
  unitCop: number;
}

/**
 * Reparte un pedido de varios productos: convierte cada línea a pesos y le
 * asigna una parte del envío proporcional a su valor (un cable de US$5 no
 * carga el mismo envío que una tableta de US$200). Las partes suman
 * exactamente el envío total.
 */
export function splitOrderCost(lines: OrderLineInput[], exchangeRate: number, shippingCost = 0): OrderLineCost[] {
  const shipping = Math.max(0, Math.round(shippingCost));
  const products = lines.map((l) => Math.round(Math.max(0, l.quantity) * l.unitPrice * exchangeRate));
  const totalValue = products.reduce((a, b) => a + b, 0);
  const totalQty = lines.reduce((a, l) => a + Math.max(0, l.quantity), 0);
  const shares = lines.map((l, i) => {
    if (totalValue > 0) return Math.floor((shipping * products[i]) / totalValue);
    return totalQty > 0 ? Math.floor((shipping * Math.max(0, l.quantity)) / totalQty) : 0;
  });
  // El sobrante del redondeo va a la línea de mayor valor.
  const remainder = shipping - shares.reduce((a, b) => a + b, 0);
  if (remainder !== 0 && lines.length > 0) {
    const idx = products.indexOf(Math.max(...products));
    shares[idx] += remainder;
  }
  return lines.map((l, i) => {
    const totalCop = products[i] + shares[i];
    return {
      productCop: products[i],
      shippingCop: shares[i],
      totalCop,
      unitCop: l.quantity > 0 ? Math.round(totalCop / l.quantity) : 0,
    };
  });
}

export function newOrderId(): string {
  return `PED-${Date.now().toString(36).toUpperCase()}`;
}

/** Costo promedio ponderado al sumar `qty` unidades a `unitCost` sobre el inventario actual. */
export function weightedAverageCost(oldStock: number, oldCost: number, qty: number, unitCost: number): number {
  const base = Math.max(0, oldStock);
  const total = base + qty;
  if (total <= 0) return Math.round(unitCost);
  return Math.round((base * oldCost + qty * unitCost) / total);
}

export function isInTransit(si: Pick<StockIn, 'status'>): boolean {
  return si.status === 'in_transit';
}

/**
 * Marca una compra en tránsito como recibida: suma las unidades al inventario
 * y recalcula el costo promedio del producto. No hace nada si ya estaba recibida.
 */
export async function receiveStockIn(stockInId: number, receivedAt = new Date()): Promise<boolean> {
  return db.transaction('rw', db.stockIns, db.products, db.hppHistory, async () => {
    const si = await db.stockIns.get(stockInId);
    if (!si || !isInTransit(si)) return false;
    const product = await db.products.get(si.productId);
    if (!product) throw new Error('product_not_found');

    const oldHpp = product.hpp;
    const newHpp = weightedAverageCost(product.stock, product.hpp, si.quantity, si.buyPrice);
    const newStock = Math.round((product.stock + si.quantity) * 1e6) / 1e6;

    await db.hppHistory.add({ productId: product.id!, oldHpp, newHpp, source: 'stock_in', date: receivedAt });
    await db.products.update(product.id!, {
      stock: newStock,
      hpp: newHpp,
      ...(si.toHome ? { stockHome: (product.stockHome ?? 0) + si.quantity } : {}),
      updatedAt: receivedAt,
    });
    await db.stockIns.update(stockInId, { status: 'received', receivedAt });
    return true;
  });
}

/** Marca como recibidas varias compras (por ejemplo, las de un pedido). Devuelve cuántas recibió. */
export async function receiveStockIns(ids: number[], receivedAt = new Date()): Promise<number> {
  let count = 0;
  for (const id of ids) if (await receiveStockIn(id, receivedAt)) count++;
  return count;
}

/** Unidades en camino por producto (para mostrarlas junto al inventario). */
export async function inTransitByProduct(): Promise<Map<number, number>> {
  const rows = await db.stockIns.where('status').equals('in_transit').toArray();
  const map = new Map<number, number>();
  for (const r of rows) map.set(r.productId, (map.get(r.productId) ?? 0) + r.quantity);
  return map;
}

export interface ExchangeRate {
  rate: number; // pesos por dólar
  date?: string; // fecha de vigencia (AAAA-MM-DD)
  source: string; // 'trm' (Superfinanciera) o el proveedor de respaldo
}

/**
 * Tasa del dólar de hoy. Primero pregunta a la API propia (TRM oficial,
 * ver worker/index.ts); si no responde, usa un servicio público de respaldo.
 */
export async function fetchUsdCopRate(): Promise<ExchangeRate> {
  try {
    const res = await fetch('/api/rate', { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      if (typeof body.rate === 'number' && body.rate > 0) return body as ExchangeRate;
    }
  } catch {
    // sin API propia (desarrollo local o sin conexión)
  }
  const res = await fetch('https://open.er-api.com/v6/latest/USD', { cache: 'no-store' });
  if (!res.ok) throw new Error('rate_unavailable');
  const body = await res.json();
  const rate = Number(body?.rates?.COP);
  if (!rate) throw new Error('rate_unavailable');
  return { rate: Math.round(rate * 100) / 100, source: 'open.er-api.com' };
}
