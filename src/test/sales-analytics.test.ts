import { describe, it, expect } from 'vitest';
import type { Transaction, TransactionItemRecord } from '@/lib/db';
import {
  autoGranularity, byCategory, byCustomer, byHour, byPaymentMethod, byProduct, byWeekday, customerKeyOf,
  filterSales, percentChange, presetRange, previousRange, summarize, timeSeries,
} from '@/lib/sales-analytics';

const tx = (id: number, date: string, total: number, extra: Partial<Transaction> = {}): Transaction => ({
  id, date: new Date(date), total, profit: total / 2, status: 'completed', subtotal: total, discountType: null,
  discountValue: 0, discountAmount: 0, paymentMethodId: 1, paymentAmount: total, change: 0, receiptNumber: `R${id}`, ...extra,
});
const item = (transactionId: number, productId: number, quantity: number, price: number, hpp = price / 2): TransactionItemRecord => ({
  transactionId, productId, productName: `P${productId}`, quantity, price, hpp, discountType: null, discountValue: 0,
  discountAmount: 0, subtotal: quantity * price,
});

const transactions = [
  tx(1, '2026-11-02T10:15:00', 10000, { customerId: 7, customerName: 'Ana' }),
  tx(2, '2026-11-02T18:40:00', 4000, { paymentMethodId: 2, createdBy: 3 }),
  tx(3, '2026-11-05T11:00:00', 6000, { customerName: 'Luis', debtAmount: 2000 }),
  tx(4, '2026-11-05T12:00:00', 9999, { status: 'open', customerId: 7 }),
  tx(5, '2026-10-20T09:00:00', 3000, { customerId: 7 }),
];
const items = [item(1, 10, 2, 3000), item(1, 11, 1, 4000), item(2, 11, 1, 4000), item(3, 10, 2, 3000), item(5, 10, 1, 3000)];
const products = [{ id: 10, categoryId: 1 }, { id: 11, categoryId: 2 }];
const nov = { start: new Date('2026-11-01T00:00:00'), end: new Date('2026-11-30T23:59:59') };

describe('date ranges', () => {
  const now = new Date('2026-11-27T15:00:00');
  it('builds the preset ranges', () => {
    expect(presetRange('7d', now).start).toEqual(new Date('2026-11-21T00:00:00'));
    expect(presetRange('lastMonth', now)).toMatchObject({ start: new Date('2026-10-01T00:00:00') });
    expect(presetRange('lastMonth', now).end.getDate()).toBe(31);
    const custom = presetRange('custom', now, '2026-11-10', '2026-11-03');
    expect(custom.start).toEqual(new Date('2026-11-03T00:00:00'));
    expect(custom.end.getDate()).toBe(10);
  });
  it('finds the previous period of the same length', () => {
    const prev = previousRange(presetRange('7d', now));
    expect(prev.start).toEqual(new Date('2026-11-14T00:00:00'));
    expect(prev.end.getDate()).toBe(20);
  });
  it('picks a granularity for the range', () => {
    expect(autoGranularity(nov)).toBe('day');
    expect(autoGranularity(presetRange('90d', now))).toBe('week');
    expect(autoGranularity(presetRange('thisYear', now))).toBe('month');
  });
});

describe('filterSales', () => {
  it('keeps completed sales inside the range', () => {
    const lines = filterSales(transactions, items, products, nov, {});
    expect(lines.map((l) => l.tx.id)).toEqual([3, 2, 1]);
    expect(summarize(lines)).toMatchObject({ sales: 20000, count: 3, units: 6, customers: 2, credit: 2000 });
  });

  it('filters by customer, payment method and cashier', () => {
    expect(filterSales(transactions, items, products, nov, { customer: '7' }).map((l) => l.tx.id)).toEqual([1]);
    expect(filterSales(transactions, items, products, nov, { customer: 'none' }).map((l) => l.tx.id)).toEqual([2]);
    expect(filterSales(transactions, items, products, nov, { customer: customerKeyOf({ customerName: 'Luis' }) }).map((l) => l.tx.id)).toEqual([3]);
    expect(filterSales(transactions, items, products, nov, { paymentMethodId: 2 }).map((l) => l.tx.id)).toEqual([2]);
    expect(filterSales(transactions, items, products, nov, { cashierId: 3 }).map((l) => l.tx.id)).toEqual([2]);
  });

  it('counts only the matching lines when filtering by product or category', () => {
    const lines = filterSales(transactions, items, products, nov, { productId: 11 });
    expect(lines.map((l) => [l.tx.id, l.amount, l.units])).toEqual([[2, 4000, 1], [1, 4000, 1]]);
    const cat = filterSales(transactions, items, products, nov, { categoryId: 1 });
    expect(summarize(cat)).toMatchObject({ sales: 12000, units: 4, profit: 6000 });
  });
});

describe('groupings', () => {
  const lines = filterSales(transactions, items, products, nov, {});

  it('ranks customers by what they bought', () => {
    const stats = byCustomer(lines, (key, t) => t.customerName ?? key);
    expect(stats.map((c) => [c.key, c.sales, c.count])).toEqual([['7', 10000, 1], ['n:luis', 6000, 1], ['none', 4000, 1]]);
    expect(stats[1].credit).toBe(2000);
  });

  it('groups by product, category and payment method', () => {
    expect(byProduct(lines).map((p) => [p.productId, p.qty, p.revenue])).toEqual([[10, 4, 12000], [11, 2, 8000]]);
    expect(byCategory(lines, products, [{ id: 1, name: 'Bebidas' }], '-').map((c) => [c.name, c.amount])).toEqual([['Bebidas', 12000], ['-', 8000]]);
    expect(byPaymentMethod(lines, [{ id: 1, name: 'Efectivo' }], '?').map((m) => [m.name, m.count])).toEqual([['Efectivo', 2], ['?', 1]]);
  });

  it('builds the time series with empty days', () => {
    const series = timeSeries(lines, { start: new Date('2026-11-01T00:00:00'), end: new Date('2026-11-07T23:59:59') }, 'day');
    expect(series).toHaveLength(7);
    expect(series.map((p) => p.sales)).toEqual([0, 14000, 0, 0, 6000, 0, 0]);
    expect(timeSeries(lines, nov, 'week')[0].key).toBe('2026-10-26');
  });

  it('groups by weekday (Monday first) and hour', () => {
    const wd = byWeekday(lines);
    expect(wd[0]).toMatchObject({ sales: 14000, count: 2 }); // 2 nov 2026 es lunes
    expect(wd[3]).toMatchObject({ sales: 6000, count: 1 });
    const hours = byHour(lines);
    expect(hours[10].sales).toBe(10000);
    expect(hours[18].count).toBe(1);
  });

  it('computes percent changes', () => {
    expect(percentChange(150, 100)).toBeCloseTo(0.5);
    expect(percentChange(10, 0)).toBeNull();
  });
});
