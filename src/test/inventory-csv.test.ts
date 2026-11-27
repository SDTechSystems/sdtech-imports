import { describe, it, expect, beforeEach } from 'vitest';
import { db, type Product } from '@/lib/db';
import { applyInventoryRows, buildInventoryRows, mapColumns, parseInventoryTable } from '@/lib/inventory-csv';
import { parseCsv } from '@/lib/product-import';

const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key);

const product = (id: number, sku: string, stock: number, extra: Partial<Product> = {}): Product => ({
  id, name: `Producto ${sku}`, sku, categoryId: 1, price: 5000, hpp: 2000, stock, unit: 'und',
  createdAt: new Date(), updatedAt: new Date(), isDeleted: 0, deletedAt: null, ...extra,
});

const products = [
  product(1, 'MOUSE', 10),
  product(2, 'CABLE', 0),
  product(3, 'SERV', 0, { trackStock: false }),
  product(4, 'OLD', 5, { isDeleted: 1 }),
  product(5, 'PRE', -3, { preorder: true }),
];
const ctx = { products, t };

describe('mapColumns', () => {
  it('finds columns by header name in Spanish and English', () => {
    expect(mapColumns(['SKU', 'Producto', 'Categoría', 'Unidad', 'Existencias', 'Costo unitario', 'Precio venta', 'Valor inventario (costo)']))
      .toEqual({ sku: 0, name: 1, qty: 4, cost: 5 });
    expect(mapColumns(['Code', 'Quantity received', 'Unit cost', 'Barcode'])).toEqual({ sku: 0, qty: 1, cost: 2, barcode: 3 });
  });
});

describe('parseInventoryTable — entry', () => {
  it('adds the quantity and keeps the given cost', () => {
    const { rows, missingColumns, looksLikeStockFile } = parseInventoryTable(
      parseCsv('SKU;Cantidad que llegó;Costo unitario\nmouse;5;2.400\nCABLE;;\n'), 'entry', ctx);
    expect(missingColumns).toEqual([]);
    expect(looksLikeStockFile).toBe(false);
    expect(rows.find((r) => r.sku === 'MOUSE')).toMatchObject({ qty: 5, newStock: 15, cost: 2400, isValid: true });
    expect(rows.find((r) => r.sku === 'CABLE')).toMatchObject({ unchanged: true, isValid: false, errors: [] });
  });

  it('joins rows of the same product and averages their cost', () => {
    const [row] = parseInventoryTable(parseCsv('SKU,Cantidad,Costo\nMOUSE,2,1000\nMOUSE,6,3000\n'), 'entry', ctx).rows;
    expect(row).toMatchObject({ rowNums: [2, 3], qty: 8, cost: 2500, isValid: true });
  });

  it('flags unknown, deleted or unmanaged products and bad numbers', () => {
    const { rows } = parseInventoryTable(parseCsv('SKU;Cantidad\nNOPE;1\nOLD;1\nSERV;1\nMOUSE;-1\n'), 'entry', ctx);
    expect(rows.find((r) => r.label === 'NOPE')!.errors).toEqual(['inventoryCsv.errorNotFound']);
    expect(rows.find((r) => r.label === 'OLD')!.errors).toEqual(['inventoryCsv.errorNotFound']);
    expect(rows.find((r) => r.sku === 'SERV')!.errors).toEqual(['inventoryCsv.errorUnmanaged']);
    expect(rows.find((r) => r.sku === 'MOUSE')!.errors[0]).toContain('inventoryCsv.errorQtyInvalid');
  });

  it('requires a cost when the product has none, and reports missing columns', () => {
    const noCost = { products: [product(2, 'CABLE', 0, { hpp: 0 })], t };
    expect(parseInventoryTable(parseCsv('SKU;Cantidad\nCABLE;4\n'), 'entry', noCost).rows[0].errors).toEqual(['inventoryCsv.errorCostRequired']);
    expect(parseInventoryTable(parseCsv('Producto;Precio\nx;1\n'), 'entry', ctx).missingColumns).toHaveLength(1);
  });
});

describe('parseInventoryTable — count', () => {
  it('replaces the stock and marks equal counts as unchanged', () => {
    const res = parseInventoryTable(parseCsv('SKU;Existencias\nMOUSE;8\nCABLE;0\n'), 'count', ctx);
    expect(res.looksLikeStockFile).toBe(true);
    expect(res.rows[0]).toMatchObject({ newStock: 8, isValid: true });
    expect(res.rows[1]).toMatchObject({ unchanged: true, isValid: false });
  });

  it('rejects duplicates and protects units still owed on made-to-order products', () => {
    expect(parseInventoryTable(parseCsv('SKU;Existencias\nMOUSE;1\nMOUSE;2\n'), 'count', ctx).rows[0].isValid).toBe(false);
    const pre = parseInventoryTable(parseCsv('SKU;Existencias\nPRE;0\n'), 'count', ctx).rows[0];
    expect(pre.isValid).toBe(false);
    expect(pre.errors[0]).toContain('inventoryCsv.errorPendingPreorder');
  });
});

describe('buildInventoryRows', () => {
  it('exports managed products with a single stock column', () => {
    const rows = buildInventoryRows({ products, categories: [{ id: 1, name: 'Accesorios' }], t, kind: 'stock' });
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r[0] === 'MOUSE')).toEqual(['MOUSE', 'Producto MOUSE', 'Accesorios', 'und', 10, 2000, 5000, 20000]);
    expect(rows.find((r) => r[0] === 'PRE')![7]).toBe(0);
    const form = buildInventoryRows({ products, categories: [], t, kind: 'entryForm' });
    expect(form[1].slice(4, 6)).toEqual(['', 2000]);
  });

  it('round-trips: the exported file reads back as an unchanged count', () => {
    const table = buildInventoryRows({ products, categories: [], t, kind: 'stock' }).map((r) => r.map(String));
    expect(parseInventoryTable(table, 'count', ctx).rows.every((r) => r.unchanged)).toBe(true);
  });
});

describe('applyInventoryRows', () => {
  beforeEach(async () => {
    await Promise.all([db.products.clear(), db.stockIns.clear(), db.stockOuts.clear(), db.hppHistory.clear(), db.stockOpnames.clear(), db.stockOpnameItems.clear()]);
    await db.products.bulkAdd([product(1, 'MOUSE', 10), product(2, 'CABLE', 0)]);
  });

  it('records an entry and updates the average cost', async () => {
    const list = await db.products.toArray();
    const { rows } = parseInventoryTable(parseCsv('SKU;Cantidad;Costo\nMOUSE;10;3000\nCABLE;2;1500\n'), 'entry', { products: list, t });
    expect(await applyInventoryRows({ rows, mode: 'entry', supplierId: 7, note: 'CSV' })).toBe(2);
    expect(await db.products.get(1)).toMatchObject({ stock: 20, hpp: 2500 });
    expect(await db.products.get(2)).toMatchObject({ stock: 2, hpp: 1500 });
    const ins = await db.stockIns.toArray();
    expect(ins).toHaveLength(2);
    expect(ins.every((s) => s.supplierId === 7 && s.status === undefined)).toBe(true);
  });

  it('applies a count as a completed stock take with movements for the difference', async () => {
    const list = await db.products.toArray();
    const { rows } = parseInventoryTable(parseCsv('SKU;Existencias\nMOUSE;5\nCABLE;4\n'), 'count', { products: list, t });
    expect(await applyInventoryRows({ rows, mode: 'count', note: 'Conteo' })).toBe(2);
    expect(await db.products.get(1)).toMatchObject({ stock: 5 });
    expect(await db.products.get(2)).toMatchObject({ stock: 4 });
    expect(await db.stockOpnames.count()).toBe(1);
    expect((await db.stockOuts.toArray())[0]).toMatchObject({ quantity: 5, reason: 'opname' });
    expect((await db.stockIns.toArray())[0]).toMatchObject({ quantity: 4, supplierId: 0 });
  });
});
