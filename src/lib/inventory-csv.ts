/**
 * Inventario por CSV: exportar las existencias actuales y cargar un archivo
 * que suma una entrada de mercancía o corrige el conteo.
 *
 * Todo el inventario está en un solo lugar, así que cada producto lleva una
 * sola cantidad. Las columnas se buscan por el nombre del encabezado: el mismo
 * archivo exportado sirve como formulario, se edita en Excel y se vuelve a subir.
 */
import { db, isStockManaged, type Product } from '@/lib/db';
import { buildCsv, cleanNumber, parseCsv } from '@/lib/product-import';

export type InventoryMode = 'entry' | 'count';

/** Máximo de filas que se leen por archivo. */
export const INVENTORY_IMPORT_LIMIT = 2000;

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Minúsculas, sin tildes ni signos: "Cantidad (unidades)" → "cantidadunidades". */
export function normalizeHeader(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

type ColumnKey = 'sku' | 'barcode' | 'name' | 'qty' | 'cost' | 'notes';

/** Reconoce cada encabezado. El orden importa: "código de barras" antes que "código". */
const COLUMN_RULES: [ColumnKey, (h: string) => boolean][] = [
  ['barcode', (h) => h.includes('barra') || h.includes('barcode') || h === 'ean' || h === 'upc'],
  ['sku', (h) => h === 'sku' || h.startsWith('codigo') || h === 'code' || h === 'ref' || h.startsWith('referencia')],
  ['cost', (h) => (h.includes('costo') || h.includes('cost') || h === 'hpp') && !h.includes('valor') && !h.includes('value')],
  ['qty', (h) =>
    h.startsWith('cantidad') || h.startsWith('quantity') || h === 'qty' || h === 'unidades' || h === 'units' ||
    h.startsWith('existencia') || h === 'stock' || h.startsWith('conteo') || h.startsWith('count') ||
    h.startsWith('entrada') || h.startsWith('incoming') || h.startsWith('llego') || h.startsWith('arrived')],
  ['notes', (h) => h.startsWith('nota') || h.startsWith('note') || h.startsWith('observ')],
  ['name', (h) => h === 'producto' || h === 'nombre' || h === 'product' || h === 'name' || h.startsWith('nombredel') || h === 'productname'],
];

export type ColumnMap = Partial<Record<ColumnKey, number>>;

/** Índice (desde 0) de cada columna reconocida. La primera coincidencia gana. */
export function mapColumns(header: string[]): ColumnMap {
  const map: ColumnMap = {};
  header.forEach((raw, i) => {
    const h = normalizeHeader(raw ?? '');
    if (!h) return;
    for (const [key, test] of COLUMN_RULES) {
      if (test(h)) {
        if (map[key] === undefined) map[key] = i;
        return;
      }
    }
  });
  return map;
}

export interface InventoryContext {
  products: Product[];
  t: (key: string, opts?: Record<string, unknown>) => string;
}

export interface InventoryPreviewRow {
  /** Filas del archivo que se juntaron en este producto (números de fila de Excel). */
  rowNums: number[];
  /** Texto con el que se buscó el producto (para mostrar si no se encontró). */
  label: string;
  productId?: number;
  productName: string;
  sku: string;
  unit: string;
  currentStock: number;
  /** Entrada: unidades que llegan. Conteo: existencia contada. null = celda vacía. */
  qty: number | null;
  newStock: number;
  /** Costo por unidad de la entrada (modo entrada). */
  cost: number;
  notes: string;
  errors: string[];
  /** La fila es válida pero no cambia nada (cantidad cero o mismo conteo). */
  unchanged: boolean;
  isValid: boolean;
}

export interface InventoryParseResult {
  rows: InventoryPreviewRow[];
  /** Faltan columnas indispensables: el archivo no se puede usar. */
  missingColumns: string[];
  truncated: boolean;
  /** El archivo trae la columna "Existencias": parece el inventario exportado, no una entrada. */
  looksLikeStockFile: boolean;
}

interface Acc {
  rowNums: number[];
  label: string;
  product?: Product;
  errors: string[];
  qty: number | null;
  /** Suma de cantidad × costo, para promediar si varias filas traen costos distintos. */
  costWeight: number;
  costQty: number;
  notes: string[];
}

/**
 * Lee la tabla (con encabezado en la primera fila no vacía) y arma la vista previa.
 * No toca la base de datos.
 */
export function parseInventoryTable(table: string[][], mode: InventoryMode, ctx: InventoryContext): InventoryParseResult {
  const { t } = ctx;
  const headerIndex = table.findIndex((r) => r.some((v) => v && v.trim()));
  if (headerIndex < 0) return { rows: [], missingColumns: [t('inventoryCsv.colSku')], truncated: false, looksLikeStockFile: false };
  const cols = mapColumns(table[headerIndex]);
  const looksLikeStockFile = table[headerIndex].some((h) => {
    const n = normalizeHeader(h ?? '');
    return n.startsWith('existencia') || n === 'stock';
  });

  const missing: string[] = [];
  if (cols.sku === undefined && cols.barcode === undefined && cols.name === undefined) missing.push(t('inventoryCsv.colSku'));
  if (cols.qty === undefined) missing.push(t(mode === 'entry' ? 'inventoryCsv.colQtyIn' : 'inventoryCsv.colStock'));
  if (missing.length) return { rows: [], missingColumns: missing, truncated: false, looksLikeStockFile };

  const active = ctx.products.filter((p) => p.isDeleted === 0);
  const bySku = new Map(active.filter((p) => p.sku).map((p) => [p.sku.toLowerCase().trim(), p]));
  const byBarcode = new Map(active.filter((p) => p.barcode).map((p) => [p.barcode!.toLowerCase().trim(), p]));
  const byName = new Map(active.map((p) => [normalizeHeader(p.name), p]));

  const groups = new Map<string, Acc>();
  let truncated = false;
  let count = 0;

  for (let i = headerIndex + 1; i < table.length; i++) {
    const values = table[i] ?? [];
    if (values.every((v) => !v || !v.trim())) continue;
    if (count >= INVENTORY_IMPORT_LIMIT) { truncated = true; break; }
    count++;
    const rowNum = i + 1;
    const get = (key: ColumnKey) => (cols[key] === undefined ? '' : (values[cols[key]!] ?? '').trim());

    const sku = get('sku');
    const barcode = get('barcode');
    const name = get('name');
    const product =
      (sku && bySku.get(sku.toLowerCase())) ||
      (barcode && (byBarcode.get(barcode.toLowerCase()) || bySku.get(barcode.toLowerCase()))) ||
      (name && byName.get(normalizeHeader(name))) ||
      undefined;
    const label = sku || barcode || name || `#${rowNum}`;
    const key = product ? `p${product.id}` : `r${rowNum}`;

    let acc = groups.get(key);
    if (!acc) {
      acc = { rowNums: [], label, product, errors: [], qty: null, costWeight: 0, costQty: 0, notes: [] };
      groups.set(key, acc);
    }
    acc.rowNums.push(rowNum);

    if (!product) {
      acc.errors.push(sku || barcode || name ? t('inventoryCsv.errorNotFound') : t('inventoryCsv.errorNoProduct'));
      continue;
    }
    if (!isStockManaged(product)) {
      if (!acc.errors.includes(t('inventoryCsv.errorUnmanaged'))) acc.errors.push(t('inventoryCsv.errorUnmanaged'));
      continue;
    }

    const raw = get('qty');
    let rowQty = 0;
    if (raw) {
      const n = cleanNumber(raw);
      if (n < 0) {
        acc.errors.push(t('inventoryCsv.errorQtyInvalid', { value: raw }));
      } else if (mode === 'count') {
        if (acc.qty !== null) acc.errors.push(t('inventoryCsv.errorDuplicate'));
        acc.qty = n;
      } else {
        acc.qty = round((acc.qty ?? 0) + n);
        rowQty = n;
      }
    }

    if (mode === 'entry') {
      const costRaw = get('cost');
      const cost = costRaw ? cleanNumber(costRaw) : -2;
      if (costRaw && cost < 0) acc.errors.push(t('inventoryCsv.errorCostInvalid', { value: costRaw }));
      if (cost > 0 && rowQty > 0) {
        acc.costWeight += cost * rowQty;
        acc.costQty += rowQty;
      }
    }
    const note = get('notes');
    if (note && !acc.notes.includes(note)) acc.notes.push(note);
  }

  const rows: InventoryPreviewRow[] = [...groups.values()].map((acc) => {
    const p = acc.product;
    const currentStock = p?.stock ?? 0;
    const errors = [...acc.errors];
    let newStock = currentStock;
    let cost = 0;
    let unchanged = false;

    if (p && errors.length === 0) {
      if (mode === 'count') {
        newStock = acc.qty ?? currentStock;
        unchanged = newStock === currentStock;
        // Stock negativo en un producto por encargo = unidades vendidas por entregar; un conteo las borraría.
        if (!unchanged && p.preorder && currentStock < 0) errors.push(t('inventoryCsv.errorPendingPreorder', { count: -currentStock }));
      } else {
        const qty = acc.qty ?? 0;
        newStock = round(currentStock + qty);
        unchanged = qty === 0;
        cost = acc.costQty > 0 ? Math.round(acc.costWeight / acc.costQty) : p.hpp;
        if (!unchanged && cost <= 0) errors.push(t('inventoryCsv.errorCostRequired'));
      }
    }

    return {
      rowNums: acc.rowNums,
      label: acc.label,
      productId: p?.id,
      productName: p?.name ?? acc.label,
      sku: p?.sku ?? '',
      unit: p?.unit ?? '',
      currentStock,
      qty: acc.qty,
      newStock,
      cost,
      notes: acc.notes.join(' · '),
      errors,
      unchanged: errors.length === 0 && unchanged,
      isValid: errors.length === 0 && !unchanged,
    };
  });

  return { rows, missingColumns: [], truncated, looksLikeStockFile };
}

/** Lee un archivo .csv/.txt o .xlsx como tabla de textos. */
export async function readTableFile(file: File): Promise<string[][]> {
  const isCsv = /\.(csv|txt)$/i.test(file.name) || file.type === 'text/csv';
  if (isCsv) return parseCsv(await file.text());

  const ExcelJSModule = await import('exceljs');
  const ExcelJS = (ExcelJSModule as unknown as { default?: typeof ExcelJSModule }).default ?? ExcelJSModule;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];
  const table: string[][] = [];
  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values: string[] = [];
    for (let col = 1; col <= Math.max(row.cellCount, 1); col++) {
      const v = row.getCell(col).value;
      let text = '';
      if (v && typeof v === 'object') {
        if ('richText' in v) text = v.richText.map((r) => r.text).join('');
        else if ('result' in v) text = String(v.result ?? '');
        else if ('text' in v) text = String(v.text ?? '');
        else if (v instanceof Date) text = v.toISOString();
      } else if (v !== undefined && v !== null) text = String(v);
      values.push(text.trim());
    }
    table[rowNumber - 1] = values;
  });
  return Array.from(table, (r) => r ?? []);
}

export interface InventoryExportOptions {
  products: Product[];
  categories: { id?: number; name: string }[];
  t: (key: string) => string;
  /**
   * `stock`: existencias actuales con costo, precio y valor (sirve también como formulario de conteo).
   * `entryForm`: los mismos productos con la cantidad vacía para anotar lo que llega.
   */
  kind: 'stock' | 'entryForm';
}

/** Productos con control de stock, ordenados por categoría y nombre. */
function inventoryProducts(products: Product[], categoryName: (id: number) => string): Product[] {
  return products
    .filter((p) => p.isDeleted === 0 && isStockManaged(p))
    .sort((a, b) => categoryName(a.categoryId).localeCompare(categoryName(b.categoryId)) || a.name.localeCompare(b.name));
}

/** Filas (con encabezado) del CSV de inventario. */
export function buildInventoryRows({ products, categories, t, kind }: InventoryExportOptions): (string | number)[][] {
  const catName = (id: number) => categories.find((c) => c.id === id)?.name ?? '';
  const list = inventoryProducts(products, catName);
  if (kind === 'entryForm') {
    const header = [t('inventoryCsv.colSku'), t('inventoryCsv.colProduct'), t('inventoryCsv.colCategory'), t('inventoryCsv.colUnit'),
      t('inventoryCsv.colQtyIn'), t('inventoryCsv.colCost'), t('inventoryCsv.colNotes')];
    return [header, ...list.map((p) => [p.sku, p.name, catName(p.categoryId), p.unit, '', p.hpp || '', ''])];
  }
  const header = [t('inventoryCsv.colSku'), t('inventoryCsv.colProduct'), t('inventoryCsv.colCategory'), t('inventoryCsv.colUnit'),
    t('inventoryCsv.colStock'), t('inventoryCsv.colCost'), t('inventoryCsv.colPrice'), t('inventoryCsv.colValue')];
  return [header, ...list.map((p) => [p.sku, p.name, catName(p.categoryId), p.unit, p.stock, p.hpp, p.price, Math.round(Math.max(0, p.stock) * p.hpp)])];
}

export function buildInventoryCsv(opts: InventoryExportOptions): string {
  return buildCsv(buildInventoryRows(opts));
}

export interface ApplyOptions {
  rows: InventoryPreviewRow[];
  mode: InventoryMode;
  supplierId?: number;
  userId?: number;
  /** Nota que queda en cada movimiento, p. ej. "Entrada por CSV (inventario.csv)". */
  note: string;
  now?: Date;
}

/** Guarda en la base de datos las filas válidas. Devuelve cuántos productos cambió. */
export async function applyInventoryRows({ rows, mode, supplierId = 0, userId, note, now = new Date() }: ApplyOptions): Promise<number> {
  const valid = rows.filter((r) => r.isValid && r.productId !== undefined);
  if (valid.length === 0) return 0;
  let changed = 0;

  await db.transaction('rw', [db.products, db.stockIns, db.stockOuts, db.hppHistory, db.stockOpnames, db.stockOpnameItems], async () => {
    let opnameId: number | undefined;
    if (mode === 'count') {
      opnameId = (await db.stockOpnames.add({ date: now, status: 'completed', notes: note, createdBy: userId })) as number;
    }

    for (const r of valid) {
      const product = await db.products.get(r.productId!);
      if (!product || product.isDeleted) continue;

      if (mode === 'entry') {
        const qty = r.qty ?? 0;
        if (qty <= 0) continue;
        await db.stockIns.add({
          productId: product.id!,
          supplierId,
          quantity: qty,
          buyPrice: r.cost,
          totalPrice: Math.round(qty * r.cost),
          date: now,
          notes: [note, r.notes].filter(Boolean).join(' · '),
          createdBy: userId,
        });
        const newStock = round(product.stock + qty);
        const newHpp = newStock > 0 && product.stock > 0
          ? Math.round((product.stock * product.hpp + qty * r.cost) / newStock)
          : Math.round(r.cost);
        await db.hppHistory.add({ productId: product.id!, oldHpp: product.hpp, newHpp, source: 'stock_in', date: now });
        await db.products.update(product.id!, { stock: newStock, hpp: newHpp, updatedAt: now, updatedBy: userId });
        changed++;
      } else {
        const newStock = r.qty ?? product.stock;
        const diff = round(newStock - product.stock);
        if (diff === 0) continue;
        await db.stockOpnameItems.add({ opnameId: opnameId!, productId: product.id!, systemStock: product.stock, realStock: newStock, difference: diff });
        await db.products.update(product.id!, { stock: newStock, updatedAt: now, updatedBy: userId });
        if (diff > 0) {
          await db.stockIns.add({
            productId: product.id!, supplierId: 0, quantity: diff, buyPrice: product.hpp,
            totalPrice: Math.round(product.hpp * diff), date: now, notes: note, createdBy: userId,
          });
        } else {
          await db.stockOuts.add({ productId: product.id!, quantity: -diff, reason: 'opname', date: now, notes: note, createdBy: userId });
        }
        changed++;
      }
    }
  });

  return changed;
}
