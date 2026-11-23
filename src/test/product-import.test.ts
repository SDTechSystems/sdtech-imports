import { describe, it, expect } from 'vitest';
import {
  buildCsv,
  cleanNumber,
  dataRows,
  detectDelimiter,
  parseCsv,
  parseYesNo,
  validateProductRows,
  PRODUCT_IMPORT_LIMIT,
} from '@/lib/product-import';

const ctx = {
  categories: [{ name: 'Etiquetas' }],
  units: [{ name: 'pcs' }, { name: 'rollo' }],
  existingSkus: new Map([['usado-1', 'Producto viejo']]),
  t: (k: string) => k,
};

describe('CSV', () => {
  it('lee lo que escribe, con comillas, separador y saltos de línea dentro de un campo', () => {
    const table = [
      ['Nombre', 'SKU', 'Descripción'],
      ['Rollo "blanco"', 'R-1', 'Línea 1\nLínea 2; con punto y coma'],
    ];
    expect(parseCsv(buildCsv(table))).toEqual(table);
  });

  it('acepta comas o tabuladores y archivos guardados sin "sep="', () => {
    expect(parseCsv('a,b,c\r\n1,"2,5",3')).toEqual([['a', 'b', 'c'], ['1', '2,5', '3']]);
    expect(parseCsv('a\tb\n1\t2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(detectDelimiter('Nombre;SKU;Categoría')).toBe(';');
  });

  it('ignora el BOM y la línea sep= que agrega Excel', () => {
    expect(parseCsv('\uFEFFsep=;\r\nNombre;SKU\r\nCable;C-1\r\n')).toEqual([['Nombre', 'SKU'], ['Cable', 'C-1']]);
  });

  it('salta el encabezado y las filas vacías, guardando el número de fila', () => {
    const { rows, rowNums } = dataRows([['h'], ['a'], ['', ' '], ['b']]);
    expect(rows).toEqual([['a'], ['b']]);
    expect(rowNums).toEqual([2, 4]);
  });

  it('corta en el límite de filas', () => {
    const table = [['h'], ...Array.from({ length: PRODUCT_IMPORT_LIMIT + 3 }, (_, i) => [`p${i}`])];
    const { rows, truncated } = dataRows(table);
    expect(rows).toHaveLength(PRODUCT_IMPORT_LIMIT);
    expect(truncated).toBe(true);
  });
});

describe('números y sí/no', () => {
  it('entiende pesos con puntos de miles y decimales con coma', () => {
    expect(cleanNumber('$ 35.000')).toBe(35000);
    expect(cleanNumber('1.500.000')).toBe(1500000);
    expect(cleanNumber('35000')).toBe(35000);
    expect(cleanNumber('15.000,50')).toBe(15000.5);
    expect(cleanNumber('2,5')).toBe(2.5);
    expect(cleanNumber('US$ 20.99')).toBe(20.99);
    expect(cleanNumber('abc')).toBe(-1);
    expect(cleanNumber('')).toBe(0);
  });

  it('entiende Sí/No con o sin tilde', () => {
    expect(parseYesNo('Sí', false)).toBe(true);
    expect(parseYesNo('si', false)).toBe(true);
    expect(parseYesNo('NO', true)).toBe(false);
    expect(parseYesNo('', true)).toBe(true);
  });
});

describe('validación de filas', () => {
  const row = (over: Partial<Record<number, string>> = {}) => {
    const base = ['Rollo 50x30', 'R-50', 'Etiquetas', '33000', '18473', 'Sí', '9', 'rollo', '', 'Para B1', 'No'];
    Object.entries(over).forEach(([k, v]) => { base[Number(k) - 1] = v!; });
    return base;
  };

  it('acepta una fila completa', () => {
    const [r] = validateProductRows([row()], [2], ctx);
    expect(r).toMatchObject({ isValid: true, price: 33000, hpp: 18473, stock: 9, unit: 'rollo', newCategory: false, newUnit: false, preorder: false });
  });

  it('marca categorías y unidades nuevas sin rechazar la fila', () => {
    const [r] = validateProductRows([row({ 3: 'Cargadores', 8: 'caja' })], [2], ctx);
    expect(r.isValid).toBe(true);
    expect(r.newCategory).toBe(true);
    expect(r.newUnit).toBe(true);
  });

  it('usa pcs si no se escribe la unidad', () => {
    const [r] = validateProductRows([row({ 8: '' })], [2], ctx);
    expect(r.unit).toBe('pcs');
    expect(r.newUnit).toBe(false);
  });

  it('lee la columna "por encargo"', () => {
    expect(validateProductRows([row({ 11: 'Sí' })], [2], ctx)[0].preorder).toBe(true);
    expect(validateProductRows([row({ 6: 'No', 11: 'Sí' })], [2], ctx)[0].preorder).toBe(false);
  });

  it('rechaza SKU repetidos en el archivo o ya usados', () => {
    const rows = validateProductRows([row(), row(), row({ 2: 'USADO-1' })], [2, 3, 4], ctx);
    expect(rows.map((r) => r.isValid)).toEqual([true, false, false]);
    expect(rows[1].errors).toContain('excel.errorSkuDupExcel');
    expect(rows[2].errors[0]).toContain('Producto viejo');
  });

  it('exige nombre, SKU, categoría y precio', () => {
    const [r] = validateProductRows([row({ 1: '', 2: '', 3: '', 4: '' })], [2], ctx);
    expect(r.errors).toEqual(['excel.errorNameRequired', 'excel.errorSkuRequired', 'excel.errorCatRequired', 'excel.errorPriceInvalid']);
  });
});
