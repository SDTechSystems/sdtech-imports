import { db, type Customer, type CustomerCreditMovement, type Debt, type PaymentMethod } from '@/lib/db';

/**
 * Cuenta por cliente: une todas sus deudas (una por venta fiada) y su saldo a favor.
 *
 * - Un abono se reparte entre sus deudas, de la más antigua a la más reciente.
 * - Si el abono es mayor que lo que debe, el excedente queda como saldo a favor.
 * - El saldo a favor (lo que el negocio le debe al cliente) se puede usar para pagar deudas.
 */

export const CREDIT_METHOD_CATEGORY = 'credit';

export interface Allocation {
  debtId: number;
  amount: number;
  remainingAfter: number;
}

/** Reparte `amount` entre las deudas pendientes, de la más antigua a la más reciente. */
export function allocatePayment(debts: Debt[], amount: number): { allocations: Allocation[]; leftover: number } {
  const pending = debts
    .filter((d) => d.id != null && d.status !== 'paid' && d.remainingAmount > 0)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  let left = Math.max(0, Math.round(amount));
  const allocations: Allocation[] = [];
  for (const d of pending) {
    if (left <= 0) break;
    const pay = Math.min(left, d.remainingAmount);
    allocations.push({ debtId: d.id!, amount: pay, remainingAfter: d.remainingAmount - pay });
    left -= pay;
  }
  return { allocations, leftover: left };
}

export function creditBalance(customer: Pick<Customer, 'creditMovements'> | undefined | null): number {
  return (customer?.creditMovements ?? []).reduce((sum, m) => sum + m.amount, 0);
}

export function customerKey(debt: Pick<Debt, 'customerId' | 'customerName'>): string {
  return debt.customerId ? `id:${debt.customerId}` : `name:${debt.customerName.trim().toLowerCase()}`;
}

/** Método de pago "Saldo a favor"; lo crea si no existe. */
export async function ensureCreditPaymentMethod(): Promise<number> {
  const existing = (await db.paymentMethods.toArray()).find((m: PaymentMethod) => m.category === CREDIT_METHOD_CATEGORY);
  if (existing?.id) return existing.id;
  return (await db.paymentMethods.add({
    name: 'Saldo a favor',
    category: CREDIT_METHOD_CATEGORY,
    isDefault: false,
    createdAt: new Date(),
  })) as number;
}

async function applyAllocations(allocations: Allocation[], paymentMethodId: number, notes: string | undefined, userId?: number) {
  const now = new Date();
  for (const a of allocations) {
    await db.debtPayments.add({ debtId: a.debtId, amount: a.amount, paymentMethodId, date: now, notes, createdBy: userId });
    await db.debts.update(a.debtId, {
      remainingAmount: a.remainingAfter,
      status: a.remainingAfter === 0 ? 'paid' : 'partial',
      settledAt: a.remainingAfter === 0 ? now : null,
    });
  }
}

function movement(amount: number, note: string): CustomerCreditMovement {
  return { id: crypto.randomUUID(), date: new Date().toISOString(), amount, note };
}

/**
 * Registra un abono del cliente. Lo que sobre después de pagar todas sus deudas
 * queda como saldo a favor (si hay un cliente registrado).
 */
export async function recordCustomerPayment(opts: {
  debts: Debt[];
  customerId?: number;
  amount: number;
  paymentMethodId: number;
  notes?: string;
  userId?: number;
}): Promise<{ applied: number; toCredit: number }> {
  const { allocations, leftover } = allocatePayment(opts.debts, opts.amount);
  let toCredit = 0;
  await db.transaction('rw', db.debts, db.debtPayments, db.customers, async () => {
    await applyAllocations(allocations, opts.paymentMethodId, opts.notes, opts.userId);
    if (leftover > 0 && opts.customerId) {
      const customer = await db.customers.get(opts.customerId);
      if (customer) {
        toCredit = leftover;
        await db.customers.update(opts.customerId, {
          creditMovements: [...(customer.creditMovements ?? []), movement(leftover, opts.notes || 'Excedente de abono')],
          updatedAt: new Date(),
        });
      }
    }
  });
  return { applied: opts.amount - leftover, toCredit };
}

/** Suma (o resta, con monto negativo) saldo a favor del cliente. */
export async function addCustomerCredit(customerId: number, amount: number, note: string) {
  await db.transaction('rw', db.customers, async () => {
    const customer = await db.customers.get(customerId);
    if (!customer) throw new Error('Cliente no encontrado');
    if (amount < 0 && creditBalance(customer) + amount < 0) throw new Error('Saldo insuficiente');
    await db.customers.update(customerId, {
      creditMovements: [...(customer.creditMovements ?? []), movement(Math.round(amount), note)],
      updatedAt: new Date(),
    });
  });
}

/** Usa el saldo a favor del cliente para pagar sus deudas. Devuelve lo aplicado. */
export async function applyCreditToDebts(customerId: number, debts: Debt[], userId?: number): Promise<number> {
  const methodId = await ensureCreditPaymentMethod();
  let applied = 0;
  await db.transaction('rw', db.debts, db.debtPayments, db.customers, async () => {
    const customer = await db.customers.get(customerId);
    const balance = creditBalance(customer);
    if (!customer || balance <= 0) return;
    const { allocations, leftover } = allocatePayment(debts, balance);
    applied = balance - leftover;
    if (applied <= 0) return;
    await applyAllocations(allocations, methodId, 'Pagado con saldo a favor', userId);
    await db.customers.update(customerId, {
      creditMovements: [...(customer.creditMovements ?? []), movement(-applied, 'Usado para pagar deudas')],
      updatedAt: new Date(),
    });
  });
  return applied;
}

/** Número de WhatsApp en formato internacional (Colombia por defecto). */
/**
 * Normaliza un usuario de WhatsApp escrito como "@usuario", "usuario" o el
 * enlace que comparte WhatsApp ("wa.me/usuario", "https://wa.me/usuario").
 * Devuelve el usuario sin @ y en minúsculas, '' si viene vacío, o null si
 * no es un usuario válido (letras, números, punto y guion bajo, 3 a 35
 * caracteres, con al menos una letra para no confundirlo con un número).
 */
export function normalizeWhatsappUser(input: string | undefined | null): string | null {
  let s = (input ?? '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '').replace(/^(www\.)?(wa\.me|api\.whatsapp\.com)\//i, '');
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._]{3,35}$/.test(s) || !/[a-z]/.test(s)) return null;
  return s;
}

/** Enlace que abre el chat de WhatsApp de un usuario (@). */
export function whatsappUserUrl(user: string, text?: string): string {
  return `https://wa.me/${encodeURIComponent(user)}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export function whatsappNumber(phone: string | undefined | null): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10 && digits.startsWith('3')) return `57${digits}`;
  if (digits.length >= 11) return digits;
  return null;
}

/** Nombre para mostrar: el nombre, o el teléfono, o "Cliente sin nombre" (ningún dato es obligatorio). */
export function customerLabel(c: { name?: string; phone?: string; whatsappUser?: string }, fallback = 'Cliente sin nombre'): string {
  return c.name?.trim() || c.phone?.trim() || (c.whatsappUser ? `@${c.whatsappUser}` : '') || fallback;
}
