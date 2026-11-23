/**
 * Página pública del recibo (la que abre el QR), renderizada por el Worker.
 *
 * No carga la app de caja: es HTML con estilos propios, con la identidad de
 * SD Tech Systems (fondo tinta, acentos cian, tipografía DejaVu) y el recibo
 * como un tiquete claro con el logo de la tienda. Las fuentes y logos están
 * en public/recibo/.
 */

export interface ReceiptPageData {
  code: string;
  receiptNumber: string;
  date: string;
  store: string;
  phone?: string;
  total: number;
  shippingFee?: number;
  items: { name: string; quantity: number; subtotal: number }[];
  status?: 'valid' | 'void';
}

export type ReceiptPageState =
  | { kind: 'receipt'; receipt: ReceiptPageData }
  | { kind: 'not_found'; code: string }
  | { kind: 'error'; code: string };

export const BRAND_SITE = 'https://sdtechsystems.dev';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const money = (n: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

export function formatReceiptDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

/** Número de WhatsApp en formato internacional; los celulares colombianos de 10 dígitos llevan 57. */
export function whatsappNumber(phone?: string): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('3')) return `57${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

const CSS = `
@font-face{font-family:"SD Sans";src:url(/recibo/sd-sans.woff2) format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:"SD Sans";src:url(/recibo/sd-sans-bold.woff2) format("woff2");font-weight:700;font-display:swap}
@font-face{font-family:"SD Mono";src:url(/recibo/sd-mono.woff2) format("woff2");font-weight:400;font-display:swap}
:root{--navy:#061C45;--cyan:#00BDE8;--ink:#07111F;--blue:#2563EB;--white:#F4F8FC;--muted:#A7B9CD;--line:#2c405b;--danger:#FF6B6B;
--paper:#FFFFFF;--paper-ink:#0B1A33;--paper-muted:#5B6B82;--paper-line:#DCE4EE;color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--ink);color:var(--white);font-family:"SD Sans",system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5;
background-image:radial-gradient(1200px 500px at 85% -10%,rgba(0,189,232,.10),transparent 60%),radial-gradient(900px 500px at -10% 110%,rgba(37,99,235,.10),transparent 60%)}
a{color:inherit}
.wrap{width:100%;max-width:600px;margin:0 auto;padding:0 20px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:22px 0}
.top img{height:30px;width:auto;display:block}
.mono{font-family:"SD Mono",ui-monospace,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.eyebrow{display:flex;align-items:center;gap:10px;margin:18px 0 14px;font-weight:700;color:var(--white)}
.eyebrow .p{color:var(--cyan)}
h1{font-weight:700;font-size:clamp(34px,9vw,52px);line-height:1.02;letter-spacing:-.025em;margin:0}
h1 .c{color:var(--cyan)}
.lead{color:var(--muted);font-size:16px;margin:14px 0 0}
.pill{display:inline-flex;align-items:center;gap:8px;margin-top:20px;padding:7px 14px;border-radius:999px;border:1px solid var(--line);background:rgba(6,28,69,.7);font-size:13px}
.pill i{width:8px;height:8px;border-radius:50%;background:var(--cyan);box-shadow:0 0 0 4px rgba(0,189,232,.18)}
.pill.void i{background:var(--danger);box-shadow:0 0 0 4px rgba(255,107,107,.18)}
.ticket{position:relative;margin:28px 0 0;background:var(--paper);color:var(--paper-ink);border-radius:18px;padding:28px 24px 22px;box-shadow:0 30px 60px -20px rgba(0,0,0,.55)}
.ticket.void{opacity:.9}
.ticket .logo{display:block;width:180px;max-width:62%;height:auto;margin:0 auto 6px}
.ticket .store{text-align:center;font-weight:700;font-size:18px;margin:0}
.ticket .sub{text-align:center;color:var(--paper-muted);font-size:13px;margin:2px 0 0}
.cut{border:0;border-top:2px dashed var(--paper-line);margin:20px -24px}
.meta{margin:0;display:grid;gap:8px}
.meta div{display:flex;justify-content:space-between;align-items:baseline;gap:16px}
.meta dt{font-family:"SD Mono",ui-monospace,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--paper-muted)}
.meta dd{margin:0;font-weight:700;font-size:14px;text-align:right;overflow-wrap:anywhere}
.items{list-style:none;margin:0;padding:0}
.items li{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--paper-line);font-size:15px}
.items li:last-child{border-bottom:0}
.items .n{min-width:0}
.items .q{display:block;color:var(--paper-muted);font-size:13px}
.items .v{white-space:nowrap;font-weight:700}
.row{display:flex;justify-content:space-between;gap:16px;font-size:15px;color:var(--paper-muted);padding:4px 0}
.total{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-top:10px;padding-top:14px;border-top:2px solid var(--paper-ink)}
.total span{font-weight:700;font-size:16px}
.total strong{font-size:26px;letter-spacing:-.01em}
.stamp{margin:18px 0 0;padding:10px 12px;border-radius:12px;background:#FFF1F1;color:#B42323;font-size:14px;text-align:center}
.code{margin:18px 0 0;text-align:center;font-family:"SD Mono",ui-monospace,monospace;font-size:12px;letter-spacing:.18em;color:var(--paper-muted)}
.actions{display:grid;gap:10px;margin:22px 0 0}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;min-height:52px;padding:0 20px;border-radius:14px;font-weight:700;font-size:16px;text-decoration:none;border:1px solid var(--line);background:var(--navy);color:var(--white)}
.btn.primary{background:var(--cyan);border-color:var(--cyan);color:var(--ink)}
.btn:focus-visible{outline:3px solid var(--blue);outline-offset:3px}
.btn svg{width:20px;height:20px;flex:none}
.note{color:var(--muted);font-size:13px;text-align:center;margin:14px 0 0}
.panel{margin:28px 0 0;padding:22px;border:1px solid var(--line);border-radius:18px;background:rgba(6,28,69,.55)}
.panel p{margin:0;color:var(--muted)}
footer{margin:44px 0 0;border-top:1px solid var(--line);padding:22px 0 34px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
footer img{height:22px;width:auto;display:block;opacity:.9}
footer p{margin:0;font-size:12px;color:var(--muted)}
footer a{text-decoration:none}
footer a:hover{color:var(--white)}
@media print{body{background:#fff;color:#000}.top,.actions,.note,footer,.pill{display:none}.ticket{box-shadow:none;border:1px solid #ccc}}
`;

const WA_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.04 2a9.9 9.9 0 0 0-8.5 14.98L2 22l5.17-1.5A9.93 9.93 0 1 0 12.04 2Zm0 18.1a8.2 8.2 0 0 1-4.2-1.15l-.3-.18-3.07.89.9-2.99-.2-.31a8.2 8.2 0 1 1 6.87 3.74Zm4.5-6.14c-.25-.12-1.46-.72-1.69-.8-.23-.08-.39-.12-.56.12-.16.25-.64.8-.79.97-.14.16-.29.18-.54.06a6.7 6.7 0 0 1-3.32-2.9c-.25-.43.25-.4.71-1.33.08-.16.04-.3-.02-.43l-.76-1.83c-.2-.48-.4-.41-.56-.42h-.47a.9.9 0 0 0-.66.31 2.77 2.77 0 0 0-.86 2.06 4.82 4.82 0 0 0 1 2.56 11 11 0 0 0 4.22 3.73c1.57.68 2.19.74 2.98.62.48-.07 1.46-.6 1.67-1.18.2-.58.2-1.08.14-1.18-.06-.11-.22-.17-.47-.29Z"/></svg>';

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#07111F">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.ico">
<link rel="preload" href="/recibo/sd-sans-bold.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top">
<a href="${BRAND_SITE}" aria-label="SD Tech Systems"><img src="/recibo/sdtech-systems.png" alt="SD Tech Systems" width="105" height="30"></a>
<span class="mono">Recibo en línea</span>
</header>
<main>
${body}
</main>
<footer>
<a href="${BRAND_SITE}" aria-label="SD Tech Systems"><img src="/recibo/sdtech-systems.png" alt="SD Tech Systems" width="77" height="22"></a>
<p>Desarrollado por <a href="${BRAND_SITE}">SD Tech Systems</a> · Parte de SD Tech</p>
</footer>
</div>
</body>
</html>`;
}

function receiptBody(r: ReceiptPageData): string {
  const voided = r.status === 'void';
  const date = formatReceiptDate(r.date);
  const wa = whatsappNumber(r.phone);
  const items = r.items
    .map(
      (it) => `<li><span class="n">${esc(it.name)}<span class="q">${esc(it.quantity)} ${it.quantity === 1 ? 'unidad' : 'unidades'}</span></span><span class="v">${money(it.subtotal)}</span></li>`,
    )
    .join('');
  const waText = encodeURIComponent(`Hola, tengo una pregunta sobre mi compra (recibo ${r.receiptNumber}).`);
  return `
<p class="eyebrow mono"><span class="p">&gt;_</span> ${esc(r.store)} / Recibo digital</p>
<h1>${voided ? 'Este recibo<br><span class="c">fue anulado.</span>' : `Gracias por tu<br><span class="c">compra.</span>`}</h1>
<p class="lead">${voided ? `La tienda anuló esta venta. Si tienes dudas, escríbele a ${esc(r.store)}.` : `Esta es la copia digital de tu recibo de ${esc(r.store)}.`}</p>
<span class="pill${voided ? ' void' : ''}"><i></i>${voided ? 'Recibo anulado' : 'Compra registrada'}</span>
<article class="ticket${voided ? ' void' : ''}" aria-label="Recibo">
<img class="logo" src="/recibo/sdtech-imports.png" alt="${esc(r.store)}" width="180" height="68">
<p class="store">${esc(r.store)}</p>
${r.phone ? `<p class="sub">${esc(r.phone)}</p>` : ''}
<hr class="cut">
<dl class="meta">
<div><dt>Recibo</dt><dd>${esc(r.receiptNumber)}</dd></div>
<div><dt>Fecha</dt><dd>${esc(date || '—')}</dd></div>
</dl>
<hr class="cut">
<ul class="items">${items}</ul>
${r.shippingFee ? `<div class="row"><span>Envío</span><span>${money(r.shippingFee)}</span></div>` : ''}
<div class="total"><span>Total</span><strong>${money(r.total)}</strong></div>
${voided ? '<p class="stamp">Anulado por la tienda</p>' : ''}
<p class="code">CÓDIGO ${esc(r.code)}</p>
</article>
<div class="actions">
${wa ? `<a class="btn primary" href="https://wa.me/${wa}?text=${waText}" rel="noopener">${WA_ICON}Escribir a la tienda</a>` : ''}
</div>
<p class="note">Guarda este enlace: siempre muestra el estado actual de tu recibo.</p>`;
}

function messageBody(title: string, accent: string, text: string, code: string): string {
  return `
<p class="eyebrow mono"><span class="p">&gt;_</span> Recibo digital</p>
<h1>${esc(title)}<br><span class="c">${esc(accent)}</span></h1>
<div class="panel"><p>${text}</p></div>
${code ? `<p class="note mono">Código ${esc(code)}</p>` : ''}`;
}

export function renderReceiptPage(state: ReceiptPageState): { html: string; status: number } {
  if (state.kind === 'receipt') {
    const r = state.receipt;
    return { html: shell(`Recibo ${r.receiptNumber} · ${r.store}`, receiptBody(r)), status: 200 };
  }
  if (state.kind === 'not_found') {
    return {
      html: shell(
        'Recibo no encontrado',
        messageBody(
          'No encontramos',
          'este recibo.',
          'Revisa que el enlace o el código estén completos. Si acabas de comprar, espera unos minutos y vuelve a intentarlo, o pídele a la tienda una copia de tu recibo.',
          state.code,
        ),
      ),
      status: 404,
    };
  }
  return {
    html: shell(
      'No se pudo cargar el recibo',
      messageBody('Algo salió mal.', 'Inténtalo de nuevo.', 'No pudimos cargar el recibo en este momento. Actualiza la página en unos segundos.', state.code),
    ),
    status: 503,
  };
}

export const RECEIPT_PAGE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
