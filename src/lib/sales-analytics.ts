/**
 * Cálculos de la pantalla de análisis de ventas. Funciones puras: reciben las
 * ventas ya leídas de la base de datos y devuelven los números para los gráficos.
 */
import {
  addDays, addMonths, addWeeks, differenceInCalendarDays, endOfDay, endOfMonth, endOfYear, format,
  startOfDay, startOfMonth, startOfWeek, startOfYear, subDays, subMonths, type Locale,
} from 'date-fns';
import type { Product, Transaction, TransactionItemRecord } from '@/lib/db';

export type DatePreset = 'today' | 'yesterday' | '7d' | '30d' | 'thisMonth' | 'lastMonth' | '90d' | 'thisYear' | 'custom';
export const DATE_PRESETS: DatePreset[] = ['today', 'yesterday', '7d', '30d', 'thisMonth', 'lastMonth', '90d', 'thisYear', 'custom'];

export interface DateRange { start: Date; end: Date }

/** Rango de fechas de un atajo. `custom` usa `from`/`to` (yyyy-MM-dd). */
export function presetRange(preset: DatePreset, now = new Date(), from?: string, to?: string): DateRange {
  switch (preset) {
    case 'today': return { start: startOfDay(now), end: endOfDay(now) };
    case 'yesterday': { const d = subDays(now, 1); return { start: startOfDay(d), end: endOfDay(d) }; }
    case '7d': return { start: startOfDay(subDays(now, 6)), end: endOfDay(now) };
    case '30d': return { start: startOfDay(subDays(now, 29)), end: endOfDay(now) };
    case '90d': return { start: startOfDay(subDays(now, 89)), end: endOfDay(now) };
    case 'thisMonth': return { start: startOfMonth(now), end: endOfDay(now) };
    case 'lastMonth': { const d = subMonths(now, 1); return { start: startOfMonth(d), end: endOfMonth(d) }; }
    case 'thisYear': return { start: startOfYear(now), end: endOfDay(now) };
    case 'custom': {
      const a = from ? new Date(`${from}T00:00:00`) : startOfDay(now);
      const b = to ? new Date(`${to}T00:00:00`) : a;
      const [s, e] = a <= b ? [a, b] : [b, a];
      return { start: startOfDay(s), end: endOfDay(e) };
    }
  }
}

/** El periodo anterior del mismo largo, para comparar. */
export function previousRange({ start, end }: DateRange): DateRange {
  const days = differenceInCalendarDays(end, start) + 1;
  return { start: startOfDay(subDays(start, days)), end: endOfDay(subDays(start, 1)) };
}

/** Clave de un cliente dentro de los filtros: id, "n:<nombre>" para nombres sin ficha, o "none". */
export type CustomerKey = string;
export const NO_CUSTOMER: CustomerKey = 'none';

export function customerKeyOf(tx: Pick<Transaction, 'customerId' | 'customerName'>): CustomerKey {
  if (tx.customerId) return String(tx.customerId);
  const name = tx.customerName?.trim();
  return name ? `n:${name.toLowerCase()}` : NO_CUSTOMER;
}

export interface AnalyticsFilters {
  customer?: CustomerKey;
  productId?: number;
  categoryId?: number;
  paymentMethodId?: number;
  cashierId?: number;
}

export interface SaleLine {
  tx: Transaction;
  /** Renglones que cuentan (todos, o solo los del producto/categoría filtrados). */
  items: TransactionItemRecord[];
  amount: number;
  profit: number;
  units: number;
  customerKey: CustomerKey;
}

/**
 * Aplica rango y filtros. Con filtro de producto o categoría, los montos salen
 * de los renglones que coinciden (antes del descuento general de la venta).
 */
export function filterSales(
  transactions: Transaction[],
  items: TransactionItemRecord[],
  products: Pick<Product, 'id' | 'categoryId'>[],
  range: DateRange,
  filters: AnalyticsFilters,
): SaleLine[] {
  const itemsByTx = new Map<number, TransactionItemRecord[]>();
  for (const it of items) {
    const list = itemsByTx.get(it.transactionId);
    if (list) list.push(it); else itemsByTx.set(it.transactionId, [it]);
  }
  const categoryOf = new Map(products.map((p) => [p.id, p.categoryId]));
  const itemFilter = filters.productId !== undefined || filters.categoryId !== undefined;
  const matches = (it: TransactionItemRecord) =>
    (filters.productId === undefined || it.productId === filters.productId) &&
    (filters.categoryId === undefined || categoryOf.get(it.productId) === filters.categoryId);

  const start = range.start.getTime();
  const end = range.end.getTime();
  const lines: SaleLine[] = [];

  for (const tx of transactions) {
    if (tx.status === 'open') continue;
    const time = new Date(tx.date).getTime();
    if (time < start || time > end) continue;
    const key = customerKeyOf(tx);
    if (filters.customer !== undefined && key !== filters.customer) continue;
    if (filters.paymentMethodId !== undefined && tx.paymentMethodId !== filters.paymentMethodId) continue;
    if (filters.cashierId !== undefined && tx.createdBy !== filters.cashierId) continue;

    const all = itemsByTx.get(tx.id!) ?? [];
    const kept = itemFilter ? all.filter(matches) : all;
    if (itemFilter && kept.length === 0) continue;

    const units = kept.reduce((s, it) => s + it.quantity, 0);
    const amount = itemFilter ? kept.reduce((s, it) => s + it.subtotal, 0) : tx.total;
    const profit = itemFilter
      ? kept.reduce((s, it) => s + (it.price - it.hpp) * it.quantity - it.discountAmount, 0)
      : tx.profit;
    lines.push({ tx, items: kept, amount, profit, units, customerKey: key });
  }
  return lines.sort((a, b) => new Date(b.tx.date).getTime() - new Date(a.tx.date).getTime());
}

export interface Summary {
  sales: number;
  profit: number;
  count: number;
  avgTicket: number;
  units: number;
  /** Clientes distintos identificados (sin contar ventas sin cliente). */
  customers: number;
  /** Lo que quedó fiado al momento de vender. */
  credit: number;
  margin: number;
}

export function summarize(lines: SaleLine[]): Summary {
  const sales = lines.reduce((s, l) => s + l.amount, 0);
  const profit = lines.reduce((s, l) => s + l.profit, 0);
  const count = lines.length;
  return {
    sales,
    profit,
    count,
    avgTicket: count ? sales / count : 0,
    units: lines.reduce((s, l) => s + l.units, 0),
    customers: new Set(lines.map((l) => l.customerKey).filter((k) => k !== NO_CUSTOMER)).size,
    credit: lines.reduce((s, l) => s + (l.tx.debtAmount ?? 0), 0),
    margin: sales > 0 ? profit / sales : 0,
  };
}

/** Cambio porcentual; null si antes no había nada con qué comparar. */
export function percentChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return (current - previous) / Math.abs(previous);
}

export type Granularity = 'day' | 'week' | 'month';

export function autoGranularity({ start, end }: DateRange): Granularity {
  const days = differenceInCalendarDays(end, start) + 1;
  return days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
}

export interface SeriesPoint { key: string; label: string; sales: number; profit: number; count: number }

const bucketStart = (d: Date, g: Granularity) =>
  g === 'day' ? startOfDay(d) : g === 'week' ? startOfWeek(d, { weekStartsOn: 1 }) : startOfMonth(d);

/** Ventas por día, semana o mes, con los periodos vacíos en cero. */
export function timeSeries(lines: SaleLine[], range: DateRange, g: Granularity, locale?: Locale): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  const index = new Map<string, SeriesPoint>();
  const labelFmt = g === 'month' ? 'MMM yy' : 'dd/MM';
  const step = (d: Date) => (g === 'day' ? addDays(d, 1) : g === 'week' ? addWeeks(d, 1) : addMonths(d, 1));
  for (let d = bucketStart(range.start, g); d <= range.end && points.length < 400; d = step(d)) {
    const key = format(d, 'yyyy-MM-dd');
    const p = { key, label: format(d, labelFmt, { locale }), sales: 0, profit: 0, count: 0 };
    points.push(p);
    index.set(key, p);
  }
  for (const l of lines) {
    const p = index.get(format(bucketStart(new Date(l.tx.date), g), 'yyyy-MM-dd'));
    if (!p) continue;
    p.sales += l.amount;
    p.profit += l.profit;
    p.count += 1;
  }
  return points;
}

export interface CustomerStat {
  key: CustomerKey;
  customerId?: number;
  name: string;
  sales: number;
  profit: number;
  count: number;
  units: number;
  avgTicket: number;
  credit: number;
  firstDate: Date;
  lastDate: Date;
}

/** Compras agrupadas por cliente, de mayor a menor monto. */
export function byCustomer(lines: SaleLine[], nameOf: (key: CustomerKey, tx: Transaction) => string): CustomerStat[] {
  const map = new Map<CustomerKey, CustomerStat>();
  for (const l of lines) {
    const date = new Date(l.tx.date);
    let c = map.get(l.customerKey);
    if (!c) {
      c = {
        key: l.customerKey, customerId: l.tx.customerId, name: nameOf(l.customerKey, l.tx),
        sales: 0, profit: 0, count: 0, units: 0, avgTicket: 0, credit: 0, firstDate: date, lastDate: date,
      };
      map.set(l.customerKey, c);
    }
    c.sales += l.amount;
    c.profit += l.profit;
    c.count += 1;
    c.units += l.units;
    c.credit += l.tx.debtAmount ?? 0;
    if (date < c.firstDate) c.firstDate = date;
    if (date > c.lastDate) c.lastDate = date;
  }
  return [...map.values()]
    .map((c) => ({ ...c, avgTicket: c.count ? c.sales / c.count : 0 }))
    .sort((a, b) => b.sales - a.sales);
}

export interface ProductStat { productId: number; name: string; qty: number; revenue: number; profit: number; count: number }

/** Productos vendidos en las ventas filtradas, de más a menos unidades. */
export function byProduct(lines: SaleLine[]): ProductStat[] {
  const map = new Map<number, ProductStat>();
  for (const l of lines) {
    for (const it of l.items) {
      let p = map.get(it.productId);
      if (!p) { p = { productId: it.productId, name: it.productName, qty: 0, revenue: 0, profit: 0, count: 0 }; map.set(it.productId, p); }
      p.qty += it.quantity;
      p.revenue += it.subtotal;
      p.profit += (it.price - it.hpp) * it.quantity - it.discountAmount;
      p.count += 1;
    }
  }
  return [...map.values()].sort((a, b) => b.qty - a.qty);
}

export interface GroupStat { id: number; name: string; amount: number; count: number }

/** Ventas por categoría de producto. */
export function byCategory(
  lines: SaleLine[],
  products: Pick<Product, 'id' | 'categoryId'>[],
  categories: { id?: number; name: string }[],
  fallback: string,
): GroupStat[] {
  const catOf = new Map(products.map((p) => [p.id, p.categoryId]));
  const map = new Map<number, GroupStat>();
  for (const l of lines) {
    for (const it of l.items) {
      const id = catOf.get(it.productId) ?? 0;
      let g = map.get(id);
      if (!g) { g = { id, name: categories.find((c) => c.id === id)?.name ?? fallback, amount: 0, count: 0 }; map.set(id, g); }
      g.amount += it.subtotal;
      g.count += it.quantity;
    }
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

/** Ventas por método de pago (lo cobrado al vender; lo fiado aparece aparte). */
export function byPaymentMethod(lines: SaleLine[], methods: { id?: number; name: string }[], fallback: string): GroupStat[] {
  const map = new Map<number, GroupStat>();
  for (const l of lines) {
    const id = l.tx.paymentMethodId ?? 0;
    let g = map.get(id);
    if (!g) { g = { id, name: methods.find((m) => m.id === id)?.name ?? fallback, amount: 0, count: 0 }; map.set(id, g); }
    g.amount += l.amount;
    g.count += 1;
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

export interface BucketStat { index: number; sales: number; count: number }

/** Ventas por día de la semana, lunes (0) a domingo (6). */
export function byWeekday(lines: SaleLine[]): BucketStat[] {
  const out = Array.from({ length: 7 }, (_, index) => ({ index, sales: 0, count: 0 }));
  for (const l of lines) {
    const b = out[(new Date(l.tx.date).getDay() + 6) % 7];
    b.sales += l.amount;
    b.count += 1;
  }
  return out;
}

/** Ventas por hora del día (0–23). */
export function byHour(lines: SaleLine[]): BucketStat[] {
  const out = Array.from({ length: 24 }, (_, index) => ({ index, sales: 0, count: 0 }));
  for (const l of lines) {
    const b = out[new Date(l.tx.date).getHours()];
    b.sales += l.amount;
    b.count += 1;
  }
  return out;
}
