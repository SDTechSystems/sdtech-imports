import { describe, it, expect, beforeEach } from 'vitest';
import { db, type Product } from '@/lib/db';
import {
  applyInventoryRows,
  buildInventoryRows,
  mapColumns,
  parseInventoryTable,
  parseLocation,
  splitStock,
} from '@/lib/inventory-csv';
import { parseCsv } from '@/lib/product-import';

const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key);

const product = (id: number, sku: string, stock: number, stockHome = 0, extra: Partial<Product> = {}): Product => ({
  id, name: `Producto ${sku}`, sku, categoryId: 1, price: 5000, hpp: 2000, stock, stockHome, unit: 'und',
  createdAt: new Date(), updatedAt: new Date(), isDeleted: 0, deletedAt: null, ...extra,
});

const products = [
  product(1, 'AGUA', 10, 4),
  product(2, 'COLA', 0),
  product(3, 'SERV', 0, 0, { trackStock: false }),
  product(4, 'OLD', 5, 0, { isDeleted: 1 }),
];
const ctx = { products, t };

describe('splitStock', () => {
  it('splits total stock into office and home', () => {
    expect(splitStock({ stock: 10, stockHome: 4 })).toEqual({ office: 6, home: 4 });
    expect(splitStock({ stock: 3, stockHome: 9 })).toEqual({ office: 0, home: 3 });
    expect(splitStock({ stock: -2, stockHome: 0 })).toEqual({ office: -2, home: 0 });
  });
});

describe('mapColumns', () => {
  it('finds columns by header name in Spanish and English', () => {
    expect(mapColumns(['SKU', 'Producto', 'Categoría', 'Unidad', 'Oficina', 'Casa', 'Total', 'Costo unitario', 'Precio venta', 'Valor inventario (costo)']))
      .toEqual({ sku: 0, name: 1, office: 4, home: 5, cost: 7 });
    expect(mapColumns(['Code', 'Quantity', 'Location', 'Unit cost', 'Barcode'])).toEqual({ sku: 0, qty: 1, location: 2, cost: 3, barcode: 4 });
  });

  it('reads the location of each row', () => {
    expect(parseLocation('Casa')).toBe('home');
    expect(parseLocation('HOME')).toBe('home');
    expect(parseLocation('Oficina')).toBe('office');
    expect(parseLocation('')).toBe('office');
  });
});

describe('parseInventoryTable — entry', () => {
  it('adds office and home quantities and keeps the given cost', () => {
    const table = parseCsv('SKU;Entrada oficina;Entrada casa;Costo unitario\nagua;5;3;2.400\nCOLA;;;\n');
    const { rows, missingColumns } = parseInventoryTable(table, 'entry', ctx);
    expect(missingColumns).toEqual([]);
    const agua = rows.find((r) => r.sku === 'AGUA')!;
    expect(agua).toMatchObject({ office: 5, home: 3, newOffice: 11, newHome: 7, cost: 2400, isValid: true });
    const cola = rows.find((r) => r.sku === 'COLA')!;
    expect(cola).toMatchObject({ unchanged: true, isValid: false, errors: [] });
  });

  it('accepts one row per location and joins rows of the same product', () => {
    const table = parseCsv('SKU,Cantidad,Ubicación,Costo\nAGUA,2,Casa,1000\nAGUA,6,Oficina,3000\n');
    const [agua] = parseInventoryTable(table, 'entry', ctx).rows;
    expect(agua).toMatchObject({ rowNums: [2, 3], office: 6, home: 2, cost: 2500, isValid: true });
  });

  it('falls back to the product cost and flags unknown, deleted or unmanaged products', () => {
    const table = parseCsv('SKU;Oficina\nAGUA;1\nNOPE;1\nOLD;1\nSERV;1\nAGUA;-1\n');
    const { rows, looksLikeStockFile } = parseInventoryTable(table, 'entry', ctx);
    expect(looksLikeStockFile).toBe(false);
    expect(rows.find((r) => r.label === 'NOPE')!.errors).toEqual(['inventoryCsv.errorNotFound']);
    expect(rows.find((r) => r.label === 'OLD')!.errors).toEqual(['inventoryCsv.errorNotFound']);
    expect(rows.find((r) => r.sku === 'SERV')!.errors).toEqual(['inventoryCsv.errorUnmanaged']);
    const agua = rows.find((r) => r.sku === 'AGUA')!;
    expect(agua.isValid).toBe(false);
    expect(agua.errors[0]).toContain('inventoryCsv.errorQtyInvalid');
  });

  it('requires a cost when the product has none', () => {
    const table = parseCsv('SKU;Oficina\nCOLA;4\n');
    const noCost = { products: [product(2, 'COLA', 0, 0, { hpp: 0 })], t };
    expect(parseInventoryTable(table, 'entry', noCost).rows[0].errors).toEqual(['inventoryCsv.errorCostRequired']);
  });

  it('reports missing columns', () => {
    expect(parseInventoryTable(parseCsv('Producto;Precio\nx;1\n'), 'entry', ctx).missingColumns).toHaveLength(1);
  });
});

describe('parseInventoryTable — count', () => {
  it('replaces only the places that have a value', () => {
    const table = parseCsv('SKU;Oficina;Casa;Total\nAGUA;8;;10\n');
    const res = parseInventoryTable(table, 'count', ctx);
    expect(res.looksLikeStockFile).toBe(true);
    expect(res.rows[0]).toMatchObject({ newOffice: 8, newHome: 4, isValid: true });
  });

  it('marks rows that match the current stock as unchanged and rejects duplicates', () => {
    const same = parseInventoryTable(parseCsv('SKU;Oficina;Casa\nAGUA;6;4\n'), 'count', ctx).rows[0];
    expect(same).toMatchObject({ unchanged: true, isValid: false });
    const dup = parseInventoryTable(parseCsv('SKU;Cantidad;Ubicacion\nAGUA;1;Casa\nAGUA;2;Casa\n'), 'count', ctx).rows[0];
    expect(dup.isValid).toBe(false);
  });
});

describe('buildInventoryRows', () => {
  it('exports managed products with the office/home split', () => {
    const rows = buildInventoryRows({ products, categories: [{ id: 1, name: 'Bebidas' }], t, kind: 'stock' });
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual(['AGUA', 'Producto AGUA', 'Bebidas', 'und', 6, 4, 10, 2000, 5000, 20000]);
    const form = buildInventoryRows({ products, categories: [], t, kind: 'entryForm' });
    expect(form[1].slice(4, 7)).toEqual(['', '', 2000]);
  });

  it('round-trips: the exported stock file reads back as an unchanged count', () => {
    const rows = buildInventoryRows({ products, categories: [], t, kind: 'stock' });
    const table = rows.map((r) => r.map(String));
    const parsed = parseInventoryTable(table, 'count', ctx).rows;
    expect(parsed.every((r) => r.unchanged)).toBe(true);
  });
});

describe('applyInventoryRows', () => {
  beforeEach(async () => {
    await Promise.all([db.products.clear(), db.stockIns.clear(), db.stockOuts.clear(), db.hppHistory.clear(), db.stockOpnames.clear(), db.stockOpnameItems.clear()]);
    await db.products.bulkAdd([product(1, 'AGUA', 10, 4), product(2, 'COLA', 0)]);
  });

  it('records an entry split between office and home and updates the average cost', async () => {
    const list = await db.products.toArray();
    const { rows } = parseInventoryTable(parseCsv('SKU;Oficina;Casa;Costo\nAGUA;5;5;3000\nCOLA;2;;1500\n'), 'entry', { products: list, t });
    const changed = await applyInventoryRows({ rows, mode: 'entry', supplierId: 7, note: 'CSV', homeLabel: 'Casa' });
    expect(changed).toBe(2);
    const agua = (await db.products.get(1))!;
    expect(agua).toMatchObject({ stock: 20, stockHome: 9, hpp: 2500 });
    const cola = (await db.products.get(2))!;
    expect(cola).toMatchObject({ stock: 2, stockHome: 0, hpp: 1500 });
    const ins = await db.stockIns.toArray();
    expect(ins).toHaveLength(3);
    expect(ins.filter((s) => s.notes.includes('Casa'))).toHaveLength(1);
    expect(ins.every((s) => s.supplierId === 7)).toBe(true);
  });

  it('applies a count as a completed stock take with movements for the difference', async () => {
    const list = await db.products.toArray();
    const { rows } = parseInventoryTable(parseCsv('SKU;Oficina;Casa\nAGUA;3;2\nCOLA;4;0\n'), 'count', { products: list, t });
    expect(await applyInventoryRows({ rows, mode: 'count', note: 'Conteo', homeLabel: 'Casa' })).toBe(2);
    expect(await db.products.get(1)).toMatchObject({ stock: 5, stockHome: 2 });
    expect(await db.products.get(2)).toMatchObject({ stock: 4, stockHome: 0 });
    expect(await db.stockOpnames.count()).toBe(1);
    expect((await db.stockOpnameItems.toArray()).map((i) => i.difference).sort()).toEqual([-5, 4]);
    expect((await db.stockOuts.toArray())[0]).toMatchObject({ quantity: 5, reason: 'opname' });
    expect((await db.stockIns.toArray())[0]).toMatchObject({ quantity: 4, supplierId: 0 });
  });
});
