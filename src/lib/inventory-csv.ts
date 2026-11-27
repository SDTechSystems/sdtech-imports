/**
 * Inventario por CSV: exportar las existencias actuales y cargar un archivo
 * que suma una entrada de mercancía o corrige el conteo.
 *
 * A diferencia de la importación de productos (por posición), aquí las columnas
 * se buscan por el nombre del encabezado, así el mismo archivo exportado sirve
 * como formulario: se edita en Excel y se vuelve a subir.
 *
 * Cada fila dice a dónde va la mercancía de dos formas posibles:
 *   - columnas "Oficina" y "Casa" con la cantidad de cada lugar, o
 *   - una columna "Cantidad" con otra "Ubicación" (Oficina / Casa).
 */
import { db, isStockManaged, type Product, type StockIn } from '@/lib/db';
import { buildCsv, cleanNumber, parseCsv } from '@/lib/product-import';

export type InventoryMode = 'entry' | 'count';

/** Máximo de filas que se leen por archivo. */
export const INVENTORY_IMPORT_LIMIT = 2000;

/** Unidades en casa y en oficina de un producto. `stock` es el total de ambas. */
export function splitStock(p: Pick<Product, 'stock' | 'stockHome'>): { office: number; home: number } {
  const home = Math.max(0, Math.min(p.stockHome ?? 0, p.stock));
  return { office: round(p.stock - home), home };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Minúsculas, sin tildes ni signos: "Ubicación (casa/oficina)" → "ubicacioncasaoficina". */
export function normalizeHeader(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

type ColumnKey = 'sku' | 'barcode' | 'name' | 'office' | 'home' | 'qty' | 'location' | 'cost' | 'notes';

/** Reconoce cada encabezado. El orden importa: "código de barras" antes que "código". */
const COLUMN_RULES: [ColumnKey, (h: string) => boolean][] = [
  ['barcode', (h) => h.includes('barra') || h.includes('barcode') || h === 'ean' || h === 'upc'],
  ['sku', (h) => h === 'sku' || h.startsWith('codigo') || h === 'code' || h === 'ref' || h.startsWith('referencia')],
  ['location', (h) => h.startsWith('ubicacion') || h.startsWith('location') || h.startsWith('lugar') || h.startsWith('destino') || h.startsWith('bodega')],
  ['office', (h) => h.includes('oficina') || h.includes('office')],
  ['home', (h) => h.includes('casa') || h === 'home' || h.includes('stockhome') || h.includes('enhome') || h.startsWith('home')],
  ['cost', (h) => (h.includes('costo') || h.includes('cost') || h === 'hpp') && !h.includes('valor') && !h.includes('value')],
  ['qty', (h) => h.startsWith('cantidad') || h.startsWith('quantity') || h === 'qty' || h === 'unidades' || h === 'units'],
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

/** "casa", "home", "c", "h" → casa; todo lo demás (incluido vacío) → oficina. */
export function parseLocation(val: string): 'office' | 'home' {
  const v = normalizeHeader(val);
  return ['casa', 'home', 'c', 'h', 'hogar'].includes(v) ? 'home' : 'office';
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
  currentOffice: number;
  currentHome: number;
  /** Entrada: unidades que llegan. Conteo: existencia nueva (null = no cambia ese lugar). */
  office: number | null;
  home: number | null;
  newOffice: number;
  newHome: number;
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
  /** El archivo trae una columna "Total": parece el inventario exportado (existencias, no entradas). */
  looksLikeStockFile: boolean;
}

interface Acc {
  rowNums: number[];
  label: string;
  product?: Product;
  errors: string[];
  office: number | null;
  home: number | null;
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
  const looksLikeStockFile = table[headerIndex].some((h) => ['total', 'stocktotal', 'existenciatotal'].includes(normalizeHeader(h ?? '')));

  const missing: string[] = [];
  if (cols.sku === undefined && cols.barcode === undefined && cols.name === undefined) missing.push(t('inventoryCsv.colSku'));
  if (cols.office === undefined && cols.home === undefined && cols.qty === undefined) {
    missing.push(`${t('inventoryCsv.colOffice')} / ${t('inventoryCsv.colHome')}`);
  }
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
      acc = { rowNums: [], label, product, errors: [], office: null, home: null, costWeight: 0, costQty: 0, notes: [] };
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

    /** null = celda vacía; NaN = no es un número válido. */
    const num = (raw: string): number | null => {
      if (!raw) return null;
      const n = cleanNumber(raw);
      return n < 0 ? NaN : n;
    };

    const quantities: { loc: 'office' | 'home'; value: number | null; raw: string }[] = [];
    if (cols.office !== undefined || cols.home !== undefined) {
      if (cols.office !== undefined) quantities.push({ loc: 'office', value: num(get('office')), raw: get('office') });
      if (cols.home !== undefined) quantities.push({ loc: 'home', value: num(get('home')), raw: get('home') });
      // Una columna "Cantidad" junto a "Ubicación" también vale aunque existan Oficina/Casa vacías.
      if (cols.qty !== undefined && get('qty') && quantities.every((q) => q.value === null)) {
        quantities.length = 0;
        quantities.push({ loc: parseLocation(get('location')), value: num(get('qty')), raw: get('qty') });
      }
    } else {
      quantities.push({ loc: parseLocation(get('location')), value: num(get('qty')), raw: get('qty') });
    }

    let rowQty = 0;
    for (const q of quantities) {
      if (q.value === null) continue;
      if (Number.isNaN(q.value)) {
        acc.errors.push(t('inventoryCsv.errorQtyInvalid', { value: q.raw }));
        continue;
      }
      const current = acc[q.loc];
      if (mode === 'count') {
        if (current !== null) acc.errors.push(t('inventoryCsv.errorDuplicate', { place: t(q.loc === 'home' ? 'inventoryCsv.home' : 'inventoryCsv.office') }));
        acc[q.loc] = q.value;
      } else {
        acc[q.loc] = round((current ?? 0) + q.value);
        rowQty += q.value;
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
    const { office: currentOffice, home: currentHome } = p ? splitStock(p) : { office: 0, home: 0 };
    const errors = [...acc.errors];
    let newOffice = currentOffice;
    let newHome = currentHome;
    let cost = 0;
    let unchanged = false;

    if (p && errors.length === 0) {
      if (mode === 'count') {
        newOffice = acc.office ?? currentOffice;
        newHome = acc.home ?? currentHome;
        unchanged = newOffice === currentOffice && newHome === currentHome;
      } else {
        const qty = (acc.office ?? 0) + (acc.home ?? 0);
        newOffice = round(currentOffice + (acc.office ?? 0));
        newHome = round(currentHome + (acc.home ?? 0));
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
      currentOffice,
      currentHome,
      office: acc.office,
      home: acc.home,
      newOffice,
      newHome,
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
   * `stock`: existencias actuales con precio y valor (sirve también como formulario de conteo).
   * `entryForm`: los mismos productos con Oficina y Casa vacías para anotar lo que llega.
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
      t('inventoryCsv.colOfficeIn'), t('inventoryCsv.colHomeIn'), t('inventoryCsv.colCost'), t('inventoryCsv.colNotes')];
    return [header, ...list.map((p) => [p.sku, p.name, catName(p.categoryId), p.unit, '', '', p.hpp || '', ''])];
  }
  const header = [t('inventoryCsv.colSku'), t('inventoryCsv.colProduct'), t('inventoryCsv.colCategory'), t('inventoryCsv.colUnit'),
    t('inventoryCsv.colOffice'), t('inventoryCsv.colHome'), t('inventoryCsv.colTotal'), t('inventoryCsv.colCost'),
    t('inventoryCsv.colPrice'), t('inventoryCsv.colValue')];
  return [header, ...list.map((p) => {
    const { office, home } = splitStock(p);
    return [p.sku, p.name, catName(p.categoryId), p.unit, office, home, p.stock, p.hpp, p.price, Math.round(p.stock * p.hpp)];
  })];
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
  homeLabel: string;
  now?: Date;
}

/** Guarda en la base de datos las filas válidas. Devuelve cuántos productos cambió. */
export async function applyInventoryRows({ rows, mode, supplierId = 0, userId, note, homeLabel, now = new Date() }: ApplyOptions): Promise<number> {
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
      const { office: curOffice, home: curHome } = splitStock(product);

      if (mode === 'entry') {
        const addOffice = r.office ?? 0;
        const addHome = r.home ?? 0;
        const qty = addOffice + addHome;
        if (qty <= 0) continue;
        const parts: [number, boolean][] = [[addOffice, false], [addHome, true]];
        for (const [q, toHome] of parts) {
          if (q <= 0) continue;
          const entry: StockIn = {
            productId: product.id!,
            supplierId,
            quantity: q,
            buyPrice: r.cost,
            totalPrice: Math.round(q * r.cost),
            date: now,
            notes: [note, toHome ? homeLabel : '', r.notes].filter(Boolean).join(' · '),
            ...(toHome ? { toHome: true } : {}),
            createdBy: userId,
          };
          await db.stockIns.add(entry);
        }
        const newStock = round(product.stock + qty);
        const newHpp = newStock > 0 && product.stock > 0
          ? Math.round((product.stock * product.hpp + qty * r.cost) / newStock)
          : Math.round(r.cost);
        await db.hppHistory.add({ productId: product.id!, oldHpp: product.hpp, newHpp, source: 'stock_in', date: now });
        await db.products.update(product.id!, {
          stock: newStock,
          hpp: newHpp,
          stockHome: round(curHome + addHome),
          updatedAt: now,
          updatedBy: userId,
        });
        changed++;
      } else {
        const newOffice = r.office ?? curOffice;
        const newHome = r.home ?? curHome;
        const newStock = round(newOffice + newHome);
        const diff = round(newStock - product.stock);
        if (diff === 0 && newHome === curHome) continue;
        await db.stockOpnameItems.add({ opnameId: opnameId!, productId: product.id!, systemStock: product.stock, realStock: newStock, difference: diff });
        await db.products.update(product.id!, { stock: newStock, stockHome: newHome, updatedAt: now, updatedBy: userId });
        if (diff > 0) {
          await db.stockIns.add({
            productId: product.id!, supplierId: 0, quantity: diff, buyPrice: product.hpp,
            totalPrice: Math.round(product.hpp * diff), date: now, notes: note, createdBy: userId,
          });
        } else if (diff < 0) {
          await db.stockOuts.add({ productId: product.id!, quantity: -diff, reason: 'opname', date: now, notes: note, createdBy: userId });
        }
        changed++;
      }
    }
  });

  return changed;
}
