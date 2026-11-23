import { describe, it, expect } from 'vitest';
import type { OrderTracking, TrackingEvent } from '@/lib/db';
import { currentStage, currentCity, trackingProgress, toPublicTracking, trackingUrl } from '@/lib/order-tracking';
import { renderTrackingPage, cleanTracking, TRACKING_PAGE_HEADERS, formatDay } from '../../worker/tracking-page';

const ev = (stage: TrackingEvent['stage'], date: string, city?: string, note?: string): TrackingEvent => ({ id: date, stage, date, city, note });

const order: OrderTracking = {
  id: 1,
  code: 'ZNXMHKTEVN',
  title: 'iPhone 15 Pro 256 GB',
  customerName: 'Laura Gómez',
  customerPhone: '3001234567',
  amountPaid: 4500000,
  internalNotes: 'Guía 1Z999 · casillero Miami',
  estimatedDate: '2026-12-12',
  status: 'customs',
  events: [
    ev('confirmed', '2026-11-20T15:00:00.000Z', 'Medellín'),
    ev('international_transit', '2026-11-22T15:00:00.000Z', 'Miami', 'Salió del casillero'),
    ev('customs', '2026-11-23T15:00:00.000Z', 'Bogotá'),
  ],
  createdAt: new Date('2026-11-20T15:00:00.000Z'),
};

describe('seguimiento de pedidos: lógica', () => {
  it('toma la etapa y la ciudad del evento más reciente', () => {
    expect(currentStage(order.events)).toBe('customs');
    expect(currentCity(order.events)).toBe('Bogotá');
    expect(currentCity([...order.events, ev('issue', '2026-11-24T00:00:00.000Z')])).toBe('Bogotá');
  });

  it('una novedad no hace retroceder el avance', () => {
    const before = trackingProgress(order.events);
    expect(before).toBeGreaterThan(0);
    expect(trackingProgress([...order.events, ev('issue', '2026-11-24T00:00:00.000Z')])).toBe(before);
    expect(trackingProgress([ev('delivered', '2026-11-25T00:00:00.000Z')])).toBe(1);
  });

  it('no publica el valor pagado, las notas internas ni los datos del cliente', () => {
    const pub = toPublicTracking(order, 'SD Tech Imports', '3058147293');
    const text = JSON.stringify(pub);
    expect(text).not.toContain('4500000');
    expect(text).not.toContain('1Z999');
    expect(text).not.toContain('Laura');
    expect(text).not.toContain('3001234567');
    expect(pub.events[0].stage).toBe('customs');
    expect(pub.prepaid).toBe(true);
  });

  it('arma el enlace en el dominio de los recibos', () => {
    expect(trackingUrl(undefined, 'ZNXMHKTEVN')).toBe('https://recibos.sdtechsystems.dev/seguimiento/ZNXMHKTEVN');
  });
});

describe('seguimiento de pedidos: Worker', () => {
  const pub = toPublicTracking(order, 'SD Tech Imports', '3058147293');

  it('rechaza códigos y etapas inválidas y recorta textos', () => {
    expect(cleanTracking({ ...pub, code: 'abc' })).toBeNull();
    const clean = cleanTracking({ ...pub, title: 'x'.repeat(500), events: [...pub.events, { stage: 'hacked', date: '2026-11-23' }] })!;
    expect(clean.title.length).toBe(160);
    expect(clean.events).toHaveLength(3);
    expect(cleanTracking({ ...pub, estimatedDate: 'mañana' })!.estimatedDate).toBeUndefined();
  });

  it('muestra la etapa actual, la ciudad, la fecha estimada y el historial', () => {
    const { html, status } = renderTrackingPage({ kind: 'tracking', tracking: cleanTracking(pub)! });
    expect(status).toBe(200);
    expect(html).toContain('en aduanas.');
    expect(html).toContain('Bogotá');
    expect(html).toContain('Salió del casillero');
    expect(html).toContain('Pagado por adelantado');
    expect(html).toContain(formatDay('2026-12-12'));
    expect(html).toContain('https://wa.me/573058147293?text=');
    expect(html).toContain('class="now">En aduanas');
  });

  it('escapa los textos de la tienda', () => {
    const { html } = renderTrackingPage({ kind: 'tracking', tracking: { ...cleanTracking(pub)!, title: '<script>alert(1)</script>' } });
    expect(html).not.toContain('<script>alert(1)');
  });

  it('muestra el buscador cuando no encuentra el código', () => {
    const { html, status } = renderTrackingPage({ kind: 'lookup', code: 'ZZZZZZZZ', notFound: true });
    expect(status).toBe(404);
    expect(html).toContain('No encontramos un pedido');
    expect(TRACKING_PAGE_HEADERS['content-security-policy']).toContain("form-action 'self'");
  });

  it('escribe la fecha estimada sin correrse de día', () => {
    expect(formatDay('2026-12-12')).toMatch(/12/);
  });
});

describe('recibo con productos por encargo', async () => {
  const { preorderItems, titleForItems } = await import('@/lib/order-tracking');
  const { renderReceiptPage } = await import('../../worker/receipt-page');

  const items = [
    { productId: 1, productName: 'Cable USB-C (local)', quantity: 2 },
    { productId: 2, productName: 'iPhone 15 Pro', quantity: 1 },
  ];
  const products = [{ id: 1 }, { id: 2, preorder: true }];

  it('solo los productos por encargo entran al seguimiento', () => {
    expect(preorderItems(items, products)).toEqual([{ name: 'iPhone 15 Pro', quantity: 1 }]);
    expect(preorderItems(items, [{ id: 1 }, { id: 2 }])).toEqual([]);
    expect(titleForItems([{ name: 'A' }, { name: 'B' }, { name: 'C' }])).toBe('A + 2');
  });

  const receipt = {
    code: 'ZNXMHKTEVN', receiptNumber: 'TX1', date: '2026-11-23T18:14:00.000Z', store: 'SD Tech Imports',
    total: 100, items: [{ name: 'iPhone 15 Pro', quantity: 1, subtotal: 100 }], status: 'valid' as const,
  };

  it('la página del recibo muestra el estado y enlaza el seguimiento', () => {
    const { html } = renderReceiptPage({ kind: 'receipt', receipt, tracking: { code: 'Y348QWNNTQ', label: 'En aduanas', city: 'Bogotá' } });
    expect(html).toContain('Tu pedido por encargo');
    expect(html).toContain('En aduanas');
    expect(html).toContain('href="/seguimiento/Y348QWNNTQ"');
  });

  it('sin productos por encargo o con el recibo anulado no hay seguimiento', () => {
    expect(renderReceiptPage({ kind: 'receipt', receipt }).html).not.toContain('/seguimiento/');
    const voided = renderReceiptPage({ kind: 'receipt', receipt: { ...receipt, status: 'void' }, tracking: { code: 'Y348QWNNTQ', label: 'En aduanas' } });
    expect(voided.html).not.toContain('/seguimiento/');
  });
});
