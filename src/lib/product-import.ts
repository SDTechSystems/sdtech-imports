/**
 * Importación masiva de productos desde CSV o Excel.
 *
 * Las columnas se leen por posición (no por el nombre del encabezado), así que
 * sirven plantillas en español, inglés o las antiguas en indonesio:
 *   1 Nombre · 2 SKU · 3 Categoría · 4 Precio · 5 Costo · 6 Controlar stock
 *   7 Stock inicial · 8 Unidad · 9 Código de barras · 10 Descripción · 11 Por encargo
 */

/** Máximo de filas que se procesan por archivo. */
export const PRODUCT_IMPORT_LIMIT = 500;

/** Separador de la plantilla CSV: Excel en español (coma decimal) usa punto y coma. */
export const CSV_SEPARATOR = ';';

export interface ProductImportRow {
  rowNum: number;
  name: string;
  sku: string;
  categoryName: string;
  price: number;
  hpp: number;
  trackStock: boolean;
  stock: number;
  unit: string;
  barcode?: string;
  description?: string;
  preorder: boolean;
  /** La categoría no existe y se creará al guardar. */
  newCategory: boolean;
  /** La unidad no existe y se creará al guardar. */
  newUnit: boolean;
  isValid: boolean;
  errors: string[];
}

export interface ProductImportContext {
  categories: { name: string }[];
  units: { name: string }[];
  /** SKU en minúsculas → nombre del producto que ya lo usa (activo o eliminado). */
  existingSkus: Map<string, string>;
  t: (key: string) => string;
}

const norm = (s: string) => s.toLowerCase().trim();

/** Convierte "$ 15.000", "15,000", "15.000,50" o "15000" en número; -1 si no es un número. */
export function cleanNumber(val: string): number {
  if (!val) return 0;
  let clean = val.replace(/COP|US\$|\$/gi, '').replace(/\s+/g, '');
  const lastDot = clean.lastIndexOf('.');
  const lastComma = clean.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    clean = lastDot > lastComma ? clean.replace(/,/g, '') : clean.replace(/\./g, '').replace(/,/g, '.');
  } else {
    const sep = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : '';
    if (sep) {
      const parts = clean.split(sep);
      // "15.000" o "1.500.000" son miles; "2,5" o "2.75" son decimales.
      const thousands = parts.length > 2 || parts[parts.length - 1].length === 3;
      clean = thousands ? parts.join('') : parts.join('.');
    }
  }
  const parsed = Number(clean);
  return clean === '' || isNaN(parsed) ? -1 : parsed;
}

/** "Sí", "si", "yes", "1", "true" → true; "No", "false", "0" (y los antiguos "tidak") → false. */
export function parseYesNo(val: string, fallback: boolean): boolean {
  const v = norm(val).normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!v) return fallback;
  if (['si', 's', 'yes', 'y', 'true', 'verdadero', '1', 'ya', 'benar'].includes(v)) return true;
  if (['no', 'n', 'false', 'falso', '0', 'tidak', 'salah'].includes(v)) return false;
  return fallback;
}

/** Valida las filas de datos (sin el encabezado). `rows[i]` son los valores de la fila `rowNums[i]`. */
export function validateProductRows(rows: string[][], rowNums: number[], ctx: ProductImportContext): ProductImportRow[] {
  const { t } = ctx;
  const skuInFile = new Set<string>();
  return rows.map((values, i) => {
    const get = (col: number) => (values[col - 1] ?? '').trim();
    const name = get(1);
    const sku = get(2);
    const categoryName = get(3);
    const unit = get(8) || 'pcs';
    const errors: string[] = [];

    if (!name) errors.push(t('excel.errorNameRequired'));
    if (!sku) {
      errors.push(t('excel.errorSkuRequired'));
    } else {
      const key = norm(sku);
      if (skuInFile.has(key)) errors.push(t('excel.errorSkuDupExcel'));
      skuInFile.add(key);
      if (ctx.existingSkus.has(key)) errors.push(`${t('excel.errorSkuDupDb')} ("${ctx.existingSkus.get(key)}")`);
    }
    if (!categoryName) errors.push(t('excel.errorCatRequired'));

    const price = cleanNumber(get(4));
    const hpp = cleanNumber(get(5));
    const stock = cleanNumber(get(7));
    const trackStock = parseYesNo(get(6), true);
    if (!get(4) || price < 0) errors.push(t('excel.errorPriceInvalid'));
    if (hpp < 0) errors.push(t('excel.errorHppInvalid'));
    if (trackStock && stock < 0) errors.push(t('excel.errorStockInvalid'));

    return {
      rowNum: rowNums[i],
      name,
      sku,
      categoryName,
      price: Math.max(0, price),
      hpp: Math.max(0, hpp),
      trackStock,
      stock: trackStock ? Math.max(0, stock) : 0,
      unit,
      barcode: get(9) || undefined,
      description: get(10) || undefined,
      preorder: trackStock && parseYesNo(get(11), false),
      newCategory: !!categoryName && !ctx.categories.some((c) => norm(c.name) === norm(categoryName)),
      newUnit: !ctx.units.some((u) => norm(u.name) === norm(unit)),
      isValid: errors.length === 0,
      errors,
    };
  });
}

/** Detecta el separador mirando el encabezado: punto y coma, tabulador o coma. */
export function detectDelimiter(headerLine: string): string {
  const count = (ch: string) => headerLine.split(ch).length - 1;
  const candidates = [';', '\t', ','];
  return candidates.reduce((best, ch) => (count(ch) > count(best) ? ch : best), ';');
}

/**
 * Lee un CSV (RFC 4180: comillas dobles, saltos de línea dentro de comillas).
 * Acepta BOM, la línea "sep=;" que agrega Excel y separador ; , o tabulador.
 */
export function parseCsv(text: string): string[][] {
  let src = text.replace(/^\uFEFF/, '');
  let delimiter: string | undefined;
  const sepLine = src.match(/^sep=(.)\r?\n/i);
  if (sepLine) {
    delimiter = sepLine[1];
    src = src.slice(sepLine[0].length);
  }
  delimiter ??= detectDelimiter(src.split(/\r?\n/, 1)[0] ?? '');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Arma un CSV que Excel abre bien en español: BOM UTF-8, "sep=;" y campos entre comillas si hace falta. */
export function buildCsv(rows: (string | number)[][], delimiter = CSV_SEPARATOR): string {
  const cell = (v: string | number) => {
    const s = String(v ?? '');
    return /["\r\n]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + `sep=${delimiter}\r\n` + rows.map((r) => r.map(cell).join(delimiter)).join('\r\n') + '\r\n';
}

/** Quita las filas totalmente vacías y devuelve los datos (sin encabezado) con su número de fila. */
export function dataRows(table: string[][]): { rows: string[][]; rowNums: number[]; truncated: boolean } {
  const rows: string[][] = [];
  const rowNums: number[] = [];
  let truncated = false;
  table.forEach((r, i) => {
    if (i === 0 || r.every((v) => !v || !v.trim())) return;
    if (rows.length >= PRODUCT_IMPORT_LIMIT) { truncated = true; return; }
    rows.push(r);
    rowNums.push(i + 1);
  });
  return { rows, rowNums, truncated };
}
