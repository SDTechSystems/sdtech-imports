import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '@/lib/db';
import { landedCost, weightedAverageCost, receiveStockIn, inTransitByProduct, splitOrderCost } from '@/lib/imports';
import { generateVerifyCode, isValidVerifyCode, getVerifyBaseUrl, verifyUrl } from '@/lib/receipt-verify';
import { escposQr } from '@/lib/printer';

describe('landedCost', () => {
  it('convierte dólares a pesos y reparte el envío por unidad', () => {
    const c = landedCost({ quantity: 4, usdUnitPrice: 24.99, exchangeRate: 4100, shippingCost: 60000 });
    expect(c.productCop).toBe(Math.round(4 * 24.99 * 4100)); // 409.836
    expect(c.shippingCop).toBe(60000);
    expect(c.totalCop).toBe(469836);
    expect(c.unitCop).toBe(117459);
  });

  it('sin cantidad no divide por cero', () => {
    expect(landedCost({ quantity: 0, usdUnitPrice: 10, exchangeRate: 4000 }).unitCop).toBe(0);
  });
});

describe('weightedAverageCost', () => {
  it('promedia el costo con el inventario existente', () => {
    expect(weightedAverageCost(2, 100000, 2, 120000)).toBe(110000);
  });
  it('si no hay inventario usa el costo nuevo', () => {
    expect(weightedAverageCost(0, 0, 3, 50000)).toBe(50000);
    expect(weightedAverageCost(-1, 90000, 3, 50000)).toBe(50000);
  });
});

describe('receiveStockIn', () => {
  beforeEach(async () => {
    await db.stockIns.clear();
    await db.products.clear();
    await db.hppHistory.clear();
  });

  it('solo suma al inventario cuando la compra se marca como recibida', async () => {
    const now = new Date();
    const productId = (await db.products.add({
      name: 'Etiquetadora NIIMBOT', sku: 'NIIM-B1', categoryId: 1, price: 250000, hpp: 100000,
      stock: 2, unit: 'pcs', createdAt: now, updatedAt: now, isDeleted: 0, deletedAt: null,
    })) as number;
    const siId = (await db.stockIns.add({
      productId, supplierId: 0, quantity: 2, buyPrice: 120000, totalPrice: 240000, date: now, notes: '',
      status: 'in_transit', origin: 'US', usdUnitPrice: 27, exchangeRate: 4000, shippingCost: 24000,
    })) as number;

    expect((await db.products.get(productId))!.stock).toBe(2);
    expect((await inTransitByProduct()).get(productId)).toBe(2);

    expect(await receiveStockIn(siId)).toBe(true);
    const p = (await db.products.get(productId))!;
    expect(p.stock).toBe(4);
    expect(p.hpp).toBe(110000);
    expect((await db.stockIns.get(siId))!.status).toBe('received');
    expect((await inTransitByProduct()).size).toBe(0);

    // Marcarla dos veces no duplica el inventario.
    expect(await receiveStockIn(siId)).toBe(false);
    expect((await db.products.get(productId))!.stock).toBe(4);
  });
});

describe('verificación de recibos', () => {
  it('genera códigos válidos y distintos', () => {
    const a = generateVerifyCode();
    const b = generateVerifyCode();
    expect(a).toHaveLength(10);
    expect(isValidVerifyCode(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(isValidVerifyCode('abc')).toBe(false);
    expect(isValidVerifyCode('O0I1L00000')).toBe(false);
  });

  it('arma la dirección del QR con la dirección configurada', () => {
    expect(getVerifyBaseUrl({ verifyBaseUrl: 'https://sdtech.example.com/' })).toBe('https://sdtech.example.com');
    expect(verifyUrl('https://sdtech.example.com', 'ABCDEFGH23')).toBe('https://sdtech.example.com/verificar/ABCDEFGH23');
  });

  it('el QR para impresora lleva la longitud correcta', () => {
    const url = 'https://sdtech.example.com/verificar/ABCDEFGH23';
    const cmd = escposQr(url);
    expect(cmd).toContain(url);
    const store = cmd.indexOf('\x31\x50\x30');
    expect(cmd.charCodeAt(store - 2)).toBe(url.length + 3);
  });
});

describe('splitOrderCost', () => {
  it('reparte el envío según el valor y suma exacto', () => {
    const lines = [
      { quantity: 1, unitPrice: 200 }, // tableta
      { quantity: 2, unitPrice: 5 }, // cables
    ];
    const r = splitOrderCost(lines, 4000, 100000);
    expect(r[0].productCop).toBe(800000);
    expect(r[1].productCop).toBe(40000);
    expect(r[0].shippingCop + r[1].shippingCop).toBe(100000);
    expect(r[0].shippingCop).toBeGreaterThan(r[1].shippingCop * 10);
    expect(r[1].unitCop).toBe(Math.round(r[1].totalCop / 2));
  });

  it('con una sola línea equivale a landedCost', () => {
    const [one] = splitOrderCost([{ quantity: 4, unitPrice: 24.99 }], 4100, 60000);
    expect(one).toEqual(landedCost({ quantity: 4, usdUnitPrice: 24.99, exchangeRate: 4100, shippingCost: 60000 }));
  });
});
