/**
 * Página pública de seguimiento de pedidos (/seguimiento/<código>).
 *
 * Usa la misma identidad que la página del recibo. Muestra la etapa actual,
 * el avance del pedido, la fecha estimada y el historial de actualizaciones
 * que la tienda escribe a mano.
 */

import { esc, shell, whatsappNumber, WA_ICON, RECEIPT_PAGE_HEADERS } from './receipt-page';

export type TrackingStage =
  | 'confirmed'
  | 'purchased'
  | 'origin_warehouse'
  | 'international_transit'
  | 'customs'
  | 'national_transit'
  | 'ready'
  | 'delivered'
  | 'issue';

export interface TrackingPageData {
  code: string;
  store: string;
  phone?: string;
  title: string;
  items?: { name: string; quantity: number }[];
  prepaid: boolean;
  estimatedDate?: string;
  createdAt: string;
  events: { stage: TrackingStage; city?: string; note?: string; date: string }[];
}

export type TrackingPageState =
  | { kind: 'tracking'; tracking: TrackingPageData }
  | { kind: 'lookup'; code?: string; notFound?: boolean }
  | { kind: 'error'; code: string };

export const STAGES: TrackingStage[] = [
  'confirmed',
  'purchased',
  'origin_warehouse',
  'international_transit',
  'customs',
  'national_transit',
  'ready',
  'delivered',
  'issue',
];

const PROGRESS: TrackingStage[] = STAGES.filter((s) => s !== 'issue');

export const STAGE_LABEL: Record<TrackingStage, string> = {
  confirmed: 'Pedido confirmado',
  purchased: 'Comprado al proveedor',
  origin_warehouse: 'En bodega de origen',
  international_transit: 'En tránsito internacional',
  customs: 'En aduanas',
  national_transit: 'En tránsito nacional',
  ready: 'Listo para entrega',
  delivered: 'Entregado',
  issue: 'Novedad',
};

const HEADLINE: Record<TrackingStage, [string, string]> = {
  confirmed: ['Recibimos tu', 'pedido.'],
  purchased: ['Tu pedido ya', 'fue comprado.'],
  origin_warehouse: ['Tu pedido está', 'en bodega de origen.'],
  international_transit: ['Tu pedido va', 'camino a Colombia.'],
  customs: ['Tu pedido está', 'en aduanas.'],
  national_transit: ['Tu pedido va', 'en camino.'],
  ready: ['Tu pedido está', 'listo para entrega.'],
  delivered: ['Tu pedido fue', 'entregado.'],
  issue: ['Tu pedido tiene', 'una novedad.'],
};

export function isStage(v: unknown): v is TrackingStage {
  return typeof v === 'string' && (STAGES as string[]).includes(v);
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

/** AAAA-MM-DD → "12 de diciembre de 2026" (sin cambiar de día por la zona horaria). */
export function formatDay(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

export const TRACKING_CODE_RE = /^[2-9A-HJ-NP-Z]{8,16}$/;

/** Valida y recorta lo que la app envía antes de guardarlo. */
export function cleanTracking(raw: unknown): TrackingPageData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.code !== 'string' || !TRACKING_CODE_RE.test(r.code)) return null;
  if (!Array.isArray(r.events)) return null;
  const text = (v: unknown, max: number) => String(v ?? '').slice(0, max).trim();
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const events = r.events
    .slice(0, 200)
    .map((e) => (e ?? {}) as Record<string, unknown>)
    .filter((e) => isStage(e.stage) && !isNaN(new Date(String(e.date)).getTime()))
    .map((e) => ({
      stage: e.stage as TrackingPageData['events'][number]['stage'],
      city: text(e.city, 80) || undefined,
      note: text(e.note, 600) || undefined,
      date: new Date(String(e.date)).toISOString(),
    }));
  const estimated = text(r.estimatedDate, 10);
  return {
    code: r.code,
    store: text(r.store, 80) || 'SD Tech Imports',
    phone: r.phone ? text(r.phone, 30) : undefined,
    title: text(r.title, 160),
    items: Array.isArray(r.items)
      ? r.items.slice(0, 50).map((i) => {
          const it = (i ?? {}) as Record<string, unknown>;
          return { name: text(it.name, 120), quantity: num(it.quantity) };
        })
      : undefined,
    prepaid: r.prepaid !== false,
    estimatedDate: /^\d{4}-\d{2}-\d{2}$/.test(estimated) ? estimated : undefined,
    createdAt: text(r.createdAt, 40),
    events,
  };
}

const EXTRA_CSS = `
.steps{list-style:none;margin:0;padding:0;display:grid;gap:0}
.steps li{position:relative;display:flex;align-items:center;gap:12px;padding:7px 0;font-size:14px;color:var(--paper-muted)}
.steps li::before{content:"";flex:none;width:12px;height:12px;border-radius:50%;border:2px solid var(--paper-line);background:var(--paper)}
.steps li:not(:last-child)::after{content:"";position:absolute;left:5px;top:26px;width:2px;height:calc(100% - 18px);background:var(--paper-line)}
.steps li.done{color:var(--paper-ink)}
.steps li.done::before{background:var(--navy);border-color:var(--navy)}
.steps li.done:not(:last-child)::after{background:var(--navy)}
.steps li.now{color:var(--paper-ink);font-weight:700}
.steps li.now::before{background:var(--cyan);border-color:var(--cyan);box-shadow:0 0 0 4px rgba(0,189,232,.22)}
.h2{font-family:"SD Mono",ui-monospace,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--paper-muted);margin:0 0 10px}
.title{font-weight:700;font-size:20px;line-height:1.25;margin:0;overflow-wrap:anywhere}
.events{list-style:none;margin:0;padding:0}
.events li{padding:12px 0;border-bottom:1px solid var(--paper-line)}
.events li:last-child{border-bottom:0}
.events .top-line{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.events b{font-size:15px}
.events time{white-space:nowrap;color:var(--paper-muted);font-size:13px}
.events .city{display:block;color:var(--paper-muted);font-size:13px}
.events p{margin:4px 0 0;font-size:14px;white-space:pre-line;overflow-wrap:anywhere}
.events li.issue b{color:#B42323}
.pill.issue i{background:var(--danger);box-shadow:0 0 0 4px rgba(255,107,107,.18)}
.lookup{display:grid;gap:10px;margin:22px 0 0}
.lookup label{font-weight:700}
.lookup input{min-height:52px;border-radius:14px;border:1px solid var(--line);background:rgba(6,28,69,.7);color:var(--white);padding:0 16px;font:inherit;font-size:18px;letter-spacing:.12em;text-transform:uppercase}
.lookup input:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
.lookup button{cursor:pointer;font:inherit}
.error{color:var(--danger);margin:0}
`;

const LABEL = 'Seguimiento de pedido';

function trackingBody(t: TrackingPageData): string {
  const events = [...t.events].sort((a, b) => b.date.localeCompare(a.date));
  const latest = events[0];
  const stage: TrackingStage = latest?.stage ?? 'confirmed';
  const [h1a, h1b] = HEADLINE[stage];
  const city = events.find((e) => e.city)?.city;
  const updated = latest ? formatDateTime(latest.date) : '';

  let furthest = 0;
  for (const e of events) furthest = Math.max(furthest, PROGRESS.indexOf(e.stage));
  const delivered = stage === 'delivered';
  const steps = PROGRESS.map((s, i) => {
    const cls = i < furthest || delivered ? 'done' : i === furthest ? 'now' : '';
    return `<li${cls ? ` class="${cls}"` : ''}>${esc(STAGE_LABEL[s])}</li>`;
  }).join('');

  const history = events
    .map(
      (e) => `<li${e.stage === 'issue' ? ' class="issue"' : ''}><div class="top-line"><b>${esc(STAGE_LABEL[e.stage])}</b><time datetime="${esc(e.date)}">${esc(formatDateTime(e.date))}</time></div>${
        e.city ? `<span class="city">${esc(e.city)}</span>` : ''
      }${e.note ? `<p>${esc(e.note)}</p>` : ''}</li>`,
    )
    .join('');

  // Un solo producto con el mismo nombre del pedido no se repite debajo del título.
  const sameAsTitle = t.items?.length === 1 && t.items[0].quantity <= 1 && t.items[0].name.trim() === t.title.trim();
  const items = t.items?.length && !sameAsTitle
    ? `<ul class="items">${t.items
        .map((i) => `<li><span class="n">${esc(i.name)}</span><span class="v">x${esc(i.quantity)}</span></li>`)
        .join('')}</ul>`
    : '';

  const wa = whatsappNumber(t.phone);
  const waText = encodeURIComponent(`Hola, quiero saber de mi pedido (código ${t.code}).`);
  const pillText = stage === 'issue' ? 'Novedad en el pedido' : delivered ? 'Pedido entregado' : t.prepaid ? 'Pagado por adelantado' : 'Pedido en curso';

  return `
<p class="eyebrow mono"><span class="p">&gt;_</span> ${esc(t.store)} / Seguimiento</p>
<h1>${esc(h1a)}<br><span class="c">${esc(h1b)}</span></h1>
<p class="lead">${updated ? `Última actualización: ${esc(updated)}${city ? ` · ${esc(city)}` : ''}.` : 'Pronto verás aquí las novedades de tu pedido.'}</p>
<span class="pill${stage === 'issue' ? ' issue' : ''}"><i></i>${esc(pillText)}</span>
<article class="ticket" aria-label="Pedido">
<p class="h2">Tu pedido</p>
<p class="title">${esc(t.title)}</p>
${items}
<hr class="cut">
<dl class="meta">
${t.prepaid ? '<div><dt>Pago</dt><dd>Pagado por adelantado</dd></div>' : ''}
${t.estimatedDate && !delivered ? `<div><dt>Entrega estimada</dt><dd>${esc(formatDay(t.estimatedDate))}</dd></div>` : ''}
${city ? `<div><dt>Ubicación</dt><dd>${esc(city)}</dd></div>` : ''}
</dl>
<hr class="cut">
<p class="h2">Avance</p>
<ol class="steps">${steps}</ol>
${history ? `<hr class="cut"><p class="h2">Historial</p><ul class="events">${history}</ul>` : ''}
<p class="code">CÓDIGO ${esc(t.code)}</p>
</article>
<div class="actions">
${wa ? `<a class="btn primary" href="https://wa.me/${wa}?text=${waText}" rel="noopener">${WA_ICON}Preguntar por mi pedido</a>` : ''}
</div>
<p class="note">Guarda este enlace: siempre muestra el estado más reciente de tu pedido.</p>`;
}

function lookupBody(code?: string, notFound?: boolean): string {
  return `
<p class="eyebrow mono"><span class="p">&gt;_</span> Seguimiento</p>
<h1>¿Dónde está<br><span class="c">mi pedido?</span></h1>
<p class="lead">Escribe el código de seguimiento que te enviamos por WhatsApp.</p>
<form class="lookup" method="get" action="/seguimiento">
<label for="codigo">Código de seguimiento</label>
<input id="codigo" name="codigo" value="${esc(code ?? '')}" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16" required>
${notFound ? '<p class="error" role="alert">No encontramos un pedido con ese código. Revísalo e inténtalo de nuevo.</p>' : ''}
<button class="btn primary" type="submit">Ver mi pedido</button>
</form>`;
}

export function renderTrackingPage(state: TrackingPageState): { html: string; status: number } {
  if (state.kind === 'tracking') {
    const t = state.tracking;
    return { html: shell(`Pedido ${t.code} · ${t.store}`, trackingBody(t), LABEL, EXTRA_CSS), status: 200 };
  }
  if (state.kind === 'lookup') {
    return {
      html: shell('Seguimiento de pedido', lookupBody(state.code, state.notFound), LABEL, EXTRA_CSS),
      status: state.notFound ? 404 : 200,
    };
  }
  return {
    html: shell(
      'No se pudo cargar el pedido',
      `<p class="eyebrow mono"><span class="p">&gt;_</span> Seguimiento</p>
<h1>Algo salió mal.<br><span class="c">Inténtalo de nuevo.</span></h1>
<div class="panel"><p>No pudimos cargar tu pedido en este momento. Actualiza la página en unos segundos.</p></div>
<p class="note mono">Código ${esc(state.code)}</p>`,
      LABEL,
      EXTRA_CSS,
    ),
    status: 503,
  };
}

/** Igual que el recibo, pero el formulario de búsqueda puede enviarse a esta misma página. */
export const TRACKING_PAGE_HEADERS: Record<string, string> = {
  ...RECEIPT_PAGE_HEADERS,
  'content-security-policy': RECEIPT_PAGE_HEADERS['content-security-policy'].replace("form-action 'none'", "form-action 'self'"),
};
