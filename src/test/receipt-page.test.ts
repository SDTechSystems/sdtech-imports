import { describe, it, expect } from 'vitest';
import { renderReceiptPage, whatsappNumber, formatReceiptDate, esc } from '../../worker/receipt-page';

const receipt = {
  code: 'ZNXMHKTEVN',
  receiptNumber: 'TX1795457669870',
  date: '2026-11-23T18:14:00.000Z',
  store: 'SDTech Imports',
  phone: '3058147293',
  total: 66000,
  items: [{ name: 'Rollo NIIMBOT B1 50x30 mm blanco', quantity: 2, subtotal: 66000 }],
  status: 'valid' as const,
};

describe('página del recibo', () => {
  it('muestra la compra con total en pesos, fecha de Colombia y botón de WhatsApp', () => {
    const { html, status } = renderReceiptPage({ kind: 'receipt', receipt });
    expect(status).toBe(200);
    expect(html).toContain('Gracias por tu');
    expect(html).toContain('Rollo NIIMBOT B1 50x30 mm blanco');
    expect(html).toMatch(/\$\s?66\.000/);
    expect(html).toContain('2 unidades');
    expect(html).toContain('https://wa.me/573058147293?text=');
    expect(html).toContain('1:14');
    expect(html).not.toMatch(/auténtic/i);
  });

  it('marca el recibo anulado', () => {
    const { html } = renderReceiptPage({ kind: 'receipt', receipt: { ...receipt, status: 'void' } });
    expect(html).toContain('fue anulado');
    expect(html).toContain('Anulado por la tienda');
  });

  it('escapa los textos que vienen de la tienda', () => {
    const { html } = renderReceiptPage({
      kind: 'receipt',
      receipt: { ...receipt, items: [{ name: '<script>alert(1)</script>', quantity: 1, subtotal: 1 }] },
    });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
    expect(esc(`"'&`)).toBe('&quot;&#39;&amp;');
  });

  it('responde 404 cuando el recibo no existe y 503 si falla', () => {
    expect(renderReceiptPage({ kind: 'not_found', code: 'ABC' }).status).toBe(404);
    expect(renderReceiptPage({ kind: 'error', code: 'ABC' }).status).toBe(503);
  });

  it('omite WhatsApp sin un teléfono válido', () => {
    const { html } = renderReceiptPage({ kind: 'receipt', receipt: { ...receipt, phone: '123' } });
    expect(html).not.toContain('wa.me');
  });
});

describe('ayudas', () => {
  it('arma el número internacional de WhatsApp', () => {
    expect(whatsappNumber('305 814 7293')).toBe('573058147293');
    expect(whatsappNumber('+57 305 814 7293')).toBe('573058147293');
    expect(whatsappNumber('')).toBeNull();
  });

  it('formatea la fecha en hora de Colombia', () => {
    expect(formatReceiptDate('2026-11-23T18:14:00.000Z')).toMatch(/23 de? nov\.? de? ?2026/);
    expect(formatReceiptDate('nada')).toBe('');
  });
});
