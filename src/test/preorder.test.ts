import { describe, it, expect } from 'vitest';
import { canSell, pendingDelivery } from '@/lib/db';

describe('ventas por encargo', () => {
  it('limita al stock los productos normales', () => {
    expect(canSell({ stock: 2 }, 2)).toBe(true);
    expect(canSell({ stock: 2 }, 3)).toBe(false);
    expect(canSell({ stock: 0 }, 1)).toBe(false);
  });

  it('deja vender sin existencias los productos por encargo', () => {
    expect(canSell({ stock: 0, preorder: true }, 1)).toBe(true);
    expect(canSell({ stock: -2, preorder: true }, 5)).toBe(true);
  });

  it('deja vender siempre los productos sin control de stock', () => {
    expect(canSell({ stock: 0, trackStock: false }, 10)).toBe(true);
  });

  it('cuenta como por entregar el stock negativo', () => {
    expect(pendingDelivery({ stock: -3 })).toBe(3);
    expect(pendingDelivery({ stock: 4 })).toBe(0);
    expect(pendingDelivery({ stock: -3, trackStock: false })).toBe(0);
  });
});
