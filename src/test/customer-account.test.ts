import { describe, it, expect, beforeEach } from 'vitest';
import { db, type Debt } from '@/lib/db';
import {
  allocatePayment, creditBalance, whatsappNumber, normalizeWhatsappUser, whatsappUserUrl, recordCustomerPayment, addCustomerCredit, applyCreditToDebts,
} from '@/lib/customer-account';

const debt = (id: number, date: string, remaining: number, status: Debt['status'] = 'unpaid'): Debt => ({
  id, transactionId: id, customerId: 1, customerName: 'Ana', originalAmount: remaining, remainingAmount: remaining,
  status, createdAt: new Date(date), settledAt: null,
});

describe('allocatePayment', () => {
  it('pays the oldest debts first and reports what is left', () => {
    const r = allocatePayment([debt(2, '2026-11-10', 5000), debt(1, '2026-11-01', 3000), debt(3, '2026-11-12', 4000, 'paid')], 6000);
    expect(r.allocations).toEqual([
      { debtId: 1, amount: 3000, remainingAfter: 0 },
      { debtId: 2, amount: 3000, remainingAfter: 2000 },
    ]);
    expect(r.leftover).toBe(0);
    expect(allocatePayment([debt(1, '2026-11-01', 3000)], 5000).leftover).toBe(2000);
  });
});

describe('helpers', () => {
  it('sums credit movements and formats WhatsApp numbers', () => {
    expect(creditBalance({ creditMovements: [{ id: 'a', date: '', amount: 2500 }, { id: 'b', date: '', amount: -1000 }] })).toBe(1500);
    expect(creditBalance(undefined)).toBe(0);
    expect(whatsappNumber('300 123 4567')).toBe('573001234567');
    expect(whatsappNumber('+57 300-123-4567')).toBe('573001234567');
    expect(whatsappNumber('12345')).toBeNull();
  });
});

describe('customer account in the database', () => {
  beforeEach(async () => {
    await db.customers.clear(); await db.debts.clear(); await db.debtPayments.clear(); await db.paymentMethods.clear();
    await db.customers.add({ id: 1, name: 'Ana', phone: '', email: '', address: '', notes: '', createdAt: new Date(), isDeleted: 0, deletedAt: null });
    await db.debts.bulkAdd([debt(1, '2026-11-01', 3000), debt(2, '2026-11-10', 5000)]);
  });

  it('spreads a payment across debts and keeps the excess as credit', async () => {
    const r = await recordCustomerPayment({ debts: await db.debts.toArray(), customerId: 1, amount: 10000, paymentMethodId: 1 });
    expect(r).toEqual({ applied: 8000, toCredit: 2000 });
    expect((await db.debts.toArray()).every((d) => d.status === 'paid')).toBe(true);
    expect(creditBalance(await db.customers.get(1))).toBe(2000);
    expect(await db.debtPayments.count()).toBe(2);
  });

  it('uses credit to pay debts', async () => {
    await addCustomerCredit(1, 4000, 'Le debo cambio');
    const applied = await applyCreditToDebts(1, await db.debts.toArray());
    expect(applied).toBe(4000);
    const [first, second] = await db.debts.orderBy('id').toArray();
    expect(first.status).toBe('paid');
    expect(second.remainingAmount).toBe(4000);
    expect(creditBalance(await db.customers.get(1))).toBe(0);
    await expect(addCustomerCredit(1, -1, 'x')).rejects.toThrow();
  });
});

describe('buildStatementText', () => {
  it('lists pending purchases, partial payments, total and credit', async () => {
    const { buildStatementText } = await import('@/lib/customer-statement');
    const text = buildStatementText(
      {
        storeName: 'SD Tech Imports', customerName: 'Juan Becerra', credit: 2000,
        lines: [
          { date: new Date(2026, 10, 13), items: [{ name: 'Amper Ultra', quantity: 1, subtotal: 5000 }], original: 5000, paid: 0, remaining: 5000 },
          { date: new Date(2026, 10, 16), items: [{ name: 'H2O', quantity: 2, subtotal: 6000 }], original: 6000, paid: 1000, remaining: 5000 },
        ],
      },
      { title: 'Estado de cuenta', greeting: 'Hola Juan', total: 'Total pendiente', credit: 'Saldo a favor', net: 'Total a pagar', paid: 'abonado', missing: 'falta', thanks: 'Gracias' },
    );
    expect(text).toContain('*SD Tech Imports* — Estado de cuenta');
    expect(text).toContain('1 Amper Ultra');
    expect(text).toMatch(/2 H2O — \$\s?6\.000 \(abonado \$\s?1\.000, falta \$\s?5\.000\)/);
    expect(text).toMatch(/\*Total pendiente: \$\s?10\.000\*/);
    expect(text).toMatch(/\*Total a pagar: \$\s?8\.000\*/);
  });
});

describe('normalizeWhatsappUser', () => {
  it('acepta @usuario, usuario y enlaces wa.me', () => {
    expect(normalizeWhatsappUser('@JulietaLarar')).toBe('julietalarar');
    expect(normalizeWhatsappUser(' julieta.lara_r ')).toBe('julieta.lara_r');
    expect(normalizeWhatsappUser('https://wa.me/julietalarar')).toBe('julietalarar');
    expect(normalizeWhatsappUser('wa.me/julietalarar?text=hola')).toBe('julietalarar');
  });
  it('vacío devuelve cadena vacía y lo inválido null', () => {
    expect(normalizeWhatsappUser('')).toBe('');
    expect(normalizeWhatsappUser('   ')).toBe('');
    expect(normalizeWhatsappUser('3001234567')).toBeNull();
    expect(normalizeWhatsappUser('ab')).toBeNull();
    expect(normalizeWhatsappUser('juli eta')).toBeNull();
    expect(normalizeWhatsappUser('julieta-lara')).toBeNull();
  });
  it('arma el enlace con texto opcional', () => {
    expect(whatsappUserUrl('julietalarar')).toBe('https://wa.me/julietalarar');
    expect(whatsappUserUrl('julietalarar', 'Hola Juli')).toBe('https://wa.me/julietalarar?text=Hola%20Juli');
  });
});
