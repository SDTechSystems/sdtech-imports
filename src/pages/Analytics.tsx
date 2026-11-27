import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  ArrowDownRight, ArrowUpRight, CalendarDays, ChevronDown, ChevronLeft, Clock, Download, Filter, Package, Receipt,
  Search, ShoppingBag, SlidersHorizontal, TrendingUp, UserRound, Users, Wallet, X,
} from 'lucide-react';
import { db, type Transaction } from '@/lib/db';
import { useAuth } from '@/hooks/use-auth';
import LockedPage from '@/components/LockedPage';
import SearchableSelect from '@/components/SearchableSelect';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatCurrency, formatNumber, NUMBER_LOCALE } from '@/lib/currency';
import { getDateLocale } from '@/i18n';
import { downloadOrShareFile } from '@/lib/file-utils';
import { buildCsv } from '@/lib/product-import';
import {
  DATE_PRESETS, NO_CUSTOMER, autoGranularity, byCategory, byCustomer, byHour, byPaymentMethod, byProduct, byWeekday,
  filterSales, percentChange, presetRange, previousRange, summarize, timeSeries,
  type AnalyticsFilters, type CustomerKey, type CustomerStat, type DatePreset, type Granularity, type SaleLine,
} from '@/lib/sales-analytics';

type Metric = 'sales' | 'profit' | 'count';
type CustomerSort = 'sales' | 'count' | 'recent' | 'avg';
type ProductSort = 'qty' | 'revenue' | 'profit';

const compact = new Intl.NumberFormat(NUMBER_LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
const ALL = 'all';

export default function Analytics() {
  const { can } = useAuth();
  const { t, i18n } = useTranslation('reports');
  const locale = getDateLocale(i18n.language);
  const [params] = useSearchParams();

  // === Filtros ===
  const [preset, setPreset] = useState<DatePreset>('30d');
  const today = format(new Date(), 'yyyy-MM-dd');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [customer, setCustomer] = useState<string>(params.get('cliente') ?? ALL);
  const [productId, setProductId] = useState<string>(ALL);
  const [categoryId, setCategoryId] = useState<string>(ALL);
  const [paymentId, setPaymentId] = useState<string>(ALL);
  const [cashierId, setCashierId] = useState<string>(ALL);
  const [showFilters, setShowFilters] = useState(params.has('cliente'));
  const [tab, setTab] = useState('summary');

  const range = useMemo(() => presetRange(preset, new Date(), from, to), [preset, from, to]);
  const prev = useMemo(() => previousRange(range), [range]);

  const transactions = useLiveQuery(
    () => db.transactions.where('date').between(prev.start, range.end, true, true).toArray(),
    [prev.start.getTime(), range.end.getTime()],
  );
  const items = useLiveQuery(async () => {
    if (!transactions?.length) return [];
    return db.transactionItems.where('transactionId').anyOf(transactions.map((x) => x.id!)).toArray();
  }, [transactions]);
  const products = useLiveQuery(() => db.products.toArray(), []);
  const categories = useLiveQuery(() => db.categories.where('isDeleted').equals(0).toArray(), []);
  const customers = useLiveQuery(() => db.customers.where('isDeleted').equals(0).toArray(), []);
  const methods = useLiveQuery(() => db.paymentMethods.toArray(), []);
  const users = useLiveQuery(() => db.users.toArray(), []);

  const filters: AnalyticsFilters = {
    customer: customer === ALL ? undefined : customer,
    productId: productId === ALL ? undefined : Number(productId),
    categoryId: categoryId === ALL ? undefined : Number(categoryId),
    paymentMethodId: paymentId === ALL ? undefined : Number(paymentId),
    cashierId: cashierId === ALL ? undefined : Number(cashierId),
  };
  const filterKey = JSON.stringify(filters);

  const data = useMemo(() => {
    const txs = transactions ?? [];
    const its = items ?? [];
    const prods = products ?? [];
    const lines = filterSales(txs, its, prods, range, filters);
    const prevLines = filterSales(txs, its, prods, prev, filters);
    return { lines, prevLines, summary: summarize(lines), prevSummary: summarize(prevLines) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, items, products, range, prev, filterKey]);

  if (!can('view_reports')) {
    return <LockedPage title={t('analytics.title')} permissionLabel={t('locked.permissionLabel')} />;
  }

  const customerName = (key: CustomerKey, tx?: Transaction): string => {
    if (key === NO_CUSTOMER) return t('analytics.walkIn');
    if (!key.startsWith('n:')) {
      const c = customers?.find((x) => String(x.id) === key);
      if (c) return c.name;
    }
    return tx?.customerName?.trim() || t('analytics.unknownCustomer');
  };

  // Opciones de clientes: los registrados + los nombres escritos a mano que aparecen en el periodo.
  const customerOptions = (() => {
    const opts = [
      { value: ALL, label: t('analytics.filters.allCustomers') },
      { value: NO_CUSTOMER, label: t('analytics.walkIn') },
      ...(customers ?? []).map((c) => ({ value: String(c.id), label: c.name })),
    ];
    const seen = new Set(opts.map((o) => o.value));
    for (const x of transactions ?? []) {
      if (x.customerId || !x.customerName?.trim()) continue;
      const key = `n:${x.customerName.trim().toLowerCase()}`;
      if (!seen.has(key)) { seen.add(key); opts.push({ value: key, label: x.customerName.trim() }); }
    }
    if (customer !== ALL && !seen.has(customer)) opts.push({ value: customer, label: customerName(customer) });
    return opts;
  })();

  const activeChips: { key: string; label: string; clear: () => void }[] = [
    customer !== ALL && { key: 'c', label: customerOptions.find((o) => o.value === customer)?.label ?? '', clear: () => setCustomer(ALL) },
    productId !== ALL && { key: 'p', label: products?.find((p) => String(p.id) === productId)?.name ?? '', clear: () => setProductId(ALL) },
    categoryId !== ALL && { key: 'k', label: categories?.find((c) => String(c.id) === categoryId)?.name ?? '', clear: () => setCategoryId(ALL) },
    paymentId !== ALL && { key: 'm', label: methods?.find((m) => String(m.id) === paymentId)?.name ?? '', clear: () => setPaymentId(ALL) },
    cashierId !== ALL && { key: 'u', label: users?.find((u) => String(u.id) === cashierId)?.name ?? '', clear: () => setCashierId(ALL) },
  ].filter(Boolean) as { key: string; label: string; clear: () => void }[];

  const clearAll = () => activeChips.forEach((c) => c.clear());
  const loading = transactions === undefined || items === undefined;
  const rangeLabel = `${format(range.start, 'd MMM yyyy', { locale })} – ${format(range.end, 'd MMM yyyy', { locale })}`;

  return (
    <div className="px-4 pt-6 pb-24 space-y-4">
      <div className="flex items-center gap-2">
        <Link to="/reports">
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t('analytics.back')}><ChevronLeft className="w-4 h-4" /></Button>
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl font-bold flex items-center gap-2"><TrendingUp className="w-5 h-5 text-primary" />{t('analytics.title')}</h1>
          <p className="text-[11px] text-muted-foreground">{rangeLabel}</p>
        </div>
      </div>

      {/* Barra de filtros */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-3 space-y-3">
          <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {DATE_PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setPreset(p)}
                className={cn(
                  'shrink-0 rounded-full px-3 py-1.5 text-xs font-medium border transition-colors',
                  preset === p ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {p === 'custom' && <CalendarDays className="inline w-3 h-3 mr-1 -mt-0.5" />}
                {t(`analytics.presets.${p}`)}
              </button>
            ))}
          </div>

          {preset === 'custom' && (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="an-from" className="text-[11px]">{t('analytics.filters.from')}</Label>
                <Input id="an-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-9" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="an-to" className="text-[11px]">{t('analytics.filters.to')}</Label>
                <Input id="an-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-9" />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <Button variant={showFilters ? 'secondary' : 'outline'} size="sm" className="h-8 gap-1.5" onClick={() => setShowFilters((v) => !v)}>
              <SlidersHorizontal className="w-3.5 h-3.5" /> {t('analytics.filters.more')}
              {activeChips.length > 0 && <span className="rounded-full bg-primary text-primary-foreground text-[10px] px-1.5">{activeChips.length}</span>}
              <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', showFilters && 'rotate-180')} />
            </Button>
            {activeChips.map((c) => (
              <span key={c.key} className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary text-xs pl-2.5 pr-1 py-1 max-w-[180px]">
                <span className="truncate">{c.label}</span>
                <button onClick={c.clear} className="rounded-full hover:bg-primary/20 p-0.5" aria-label={t('analytics.filters.remove')}><X className="w-3 h-3" /></button>
              </span>
            ))}
            {activeChips.length > 1 && (
              <button onClick={clearAll} className="text-xs text-muted-foreground underline">{t('analytics.filters.clear')}</button>
            )}
          </div>

          {showFilters && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
              <FilterField label={t('analytics.filters.customer')}>
                <SearchableSelect value={customer} onChange={setCustomer} options={customerOptions}
                  placeholder={t('analytics.filters.allCustomers')} searchPlaceholder={t('analytics.filters.searchCustomer')} />
              </FilterField>
              <FilterField label={t('analytics.filters.product')}>
                <SearchableSelect value={productId} onChange={setProductId}
                  placeholder={t('analytics.filters.allProducts')} searchPlaceholder={t('analytics.filters.searchProduct')}
                  options={[{ value: ALL, label: t('analytics.filters.allProducts') },
                    ...(products ?? []).filter((p) => p.isDeleted === 0).map((p) => ({ value: String(p.id), label: p.sku ? `${p.name} · ${p.sku}` : p.name }))]} />
              </FilterField>
              <FilterField label={t('analytics.filters.category')}>
                <Select value={categoryId} onValueChange={setCategoryId}>
                  <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>{t('analytics.filters.allCategories')}</SelectItem>
                    {categories?.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.icon} {c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FilterField>
              <FilterField label={t('analytics.filters.payment')}>
                <Select value={paymentId} onValueChange={setPaymentId}>
                  <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>{t('analytics.filters.allPayments')}</SelectItem>
                    {methods?.map((m) => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FilterField>
              {(users?.length ?? 0) > 0 && (
                <FilterField label={t('analytics.filters.cashier')}>
                  <Select value={cashierId} onValueChange={setCashierId}>
                    <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>{t('analytics.filters.allCashiers')}</SelectItem>
                      {users?.map((u) => <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </FilterField>
              )}
              {(filters.productId !== undefined || filters.categoryId !== undefined) && (
                <p className="sm:col-span-2 text-[11px] text-muted-foreground">{t('analytics.filters.itemNote')}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full grid grid-cols-5 h-auto">
          {(['summary', 'customers', 'products', 'times', 'sales'] as const).map((k) => (
            <TabsTrigger key={k} value={k} className="text-[11px] sm:text-sm px-1 py-1.5">{t(`analytics.tabs.${k}`)}</TabsTrigger>
          ))}
        </TabsList>

        {loading ? (
          <p className="text-center text-sm text-muted-foreground py-12">{t('analytics.loading')}</p>
        ) : (
          <>
            <TabsContent value="summary" className="space-y-4 mt-4">
              <SummaryTab data={data} range={range} lines={data.lines} categories={categories ?? []} products={products ?? []} methods={methods ?? []} />
            </TabsContent>
            <TabsContent value="customers" className="space-y-4 mt-4">
              <CustomersTab lines={data.lines} nameOf={customerName} range={range}
                onFilter={(key) => { setCustomer(key); setShowFilters(true); setTab('summary'); }} />
            </TabsContent>
            <TabsContent value="products" className="space-y-4 mt-4">
              <ProductsTab lines={data.lines} categories={categories ?? []} products={products ?? []}
                onFilter={(id) => { setProductId(String(id)); setShowFilters(true); setTab('summary'); }} />
            </TabsContent>
            <TabsContent value="times" className="space-y-4 mt-4">
              <TimesTab lines={data.lines} />
            </TabsContent>
            <TabsContent value="sales" className="space-y-4 mt-4">
              <SalesTab lines={data.lines} nameOf={customerName} methods={methods ?? []} range={range} />
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

// ───────────────────────── Gráfico de barras simple ─────────────────────────

function SimpleBars({ data, xKey, yKey, valueFormat, height = 200 }: {
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string;
  valueFormat: (n: number) => string;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
        <XAxis dataKey={xKey} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
        <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} width={40} tickFormatter={(v: number) => compact.format(v)} />
        <Tooltip
          cursor={{ fill: 'hsl(var(--muted))', opacity: 0.5 }}
          formatter={(v: number) => [valueFormat(v), '']}
          separator=""
          contentStyle={{ fontSize: 12, borderRadius: 8, background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--popover-foreground))' }}
        />
        <Bar dataKey={yKey} radius={[4, 4, 0, 0]} maxBarSize={32} fill="hsl(var(--primary))" />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Lista con barra de proporción: sirve para rankings (texto en tinta normal, barra en color). */
function RankRow({ rank, title, subtitle, value, extra, share, onClick }: {
  rank?: number; title: string; subtitle?: string; value: string; extra?: string; share: number; onClick?: () => void;
}) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp onClick={onClick} className={cn('w-full text-left py-2', onClick && 'hover:bg-muted/40 rounded-lg px-2 -mx-2 transition-colors')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {rank !== undefined && (
            <span className="w-5 h-5 shrink-0 rounded-full bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center">{rank}</span>
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{title}</p>
            {subtitle && <p className="text-[10px] text-muted-foreground truncate">{subtitle}</p>}
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs font-bold">{value}</p>
          {extra && <p className="text-[10px] text-muted-foreground">{extra}</p>}
        </div>
      </div>
      <div className="mt-1.5 h-1.5 w-full bg-muted rounded-full overflow-hidden">
        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, Math.min(100, share * 100))}%` }} />
      </div>
    </Comp>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange(v: T): void; options: { value: T; label: string }[] }) {
  return (
    <div className="inline-flex rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={cn('px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors', value === o.value ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="text-center py-10">
      <ShoppingBag className="w-10 h-10 mx-auto text-muted-foreground/30 mb-2" />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

async function downloadCsv(rows: (string | number)[][], fileName: string, okMsg: string, failMsg: string) {
  try {
    await downloadOrShareFile(new TextEncoder().encode(buildCsv(rows)).buffer as ArrayBuffer, { fileName, mimeType: 'text/csv' });
    toast.success(okMsg);
  } catch (err) {
    console.error(err);
    toast.error(failMsg);
  }
}

// ───────────────────────── Resumen ─────────────────────────

function Kpi({ icon: Icon, label, value, change, invert }: { icon: typeof TrendingUp; label: string; value: string; change?: number | null; invert?: boolean }) {
  const { t } = useTranslation('reports');
  const good = change !== null && change !== undefined && (invert ? change < 0 : change > 0);
  return (
    <Card className="border-0 shadow-sm">
      <CardContent className="p-3">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="w-3.5 h-3.5" />
          <span className="text-[10px] font-medium">{label}</span>
        </div>
        <p className="text-base font-bold mt-1 truncate">{value}</p>
        {change !== undefined && (
          <p className={cn('text-[10px] flex items-center gap-0.5', change === null ? 'text-muted-foreground' : good ? 'text-success' : change === 0 ? 'text-muted-foreground' : 'text-destructive')}>
            {change === null ? t('analytics.kpi.noPrevious') : (
              <>
                {change > 0 ? <ArrowUpRight className="w-3 h-3" /> : change < 0 ? <ArrowDownRight className="w-3 h-3" /> : null}
                {t('analytics.kpi.vsPrevious', { pct: `${change > 0 ? '+' : ''}${(change * 100).toFixed(0)}%` })}
              </>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryTab({ data, range, lines, categories, products, methods }: {
  data: { summary: ReturnType<typeof summarize>; prevSummary: ReturnType<typeof summarize> };
  range: { start: Date; end: Date };
  lines: SaleLine[];
  categories: { id?: number; name: string }[];
  products: { id?: number; categoryId: number }[];
  methods: { id?: number; name: string }[];
}) {
  const { t, i18n } = useTranslation('reports');
  const locale = getDateLocale(i18n.language);
  const [metric, setMetric] = useState<Metric>('sales');
  const [gran, setGran] = useState<Granularity | 'auto'>('auto');
  const g = gran === 'auto' ? autoGranularity(range) : gran;
  const series = useMemo(() => timeSeries(lines, range, g, locale), [lines, range, g, locale]);
  const { summary: s, prevSummary: p } = data;
  const fmtMetric = (n: number) => (metric === 'count' ? formatNumber(n) : formatCurrency(Math.round(n)));
  const payments = byPaymentMethod(lines, methods, t('fallbacks.noMethod'));
  const cats = byCategory(lines, products, categories, t('fallbacks.uncategorized'));
  const best = series.reduce<(typeof series)[number] | null>((b, x) => (!b || x[metric] > b[metric] ? x : b), null);

  if (lines.length === 0) return <EmptyState text={t('analytics.empty')} />;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Kpi icon={TrendingUp} label={t('analytics.kpi.sales')} value={formatCurrency(Math.round(s.sales))} change={percentChange(s.sales, p.sales)} />
        <Kpi icon={Wallet} label={t('analytics.kpi.profit')} value={formatCurrency(Math.round(s.profit))} change={percentChange(s.profit, p.profit)} />
        <Kpi icon={Receipt} label={t('analytics.kpi.count')} value={formatNumber(s.count)} change={percentChange(s.count, p.count)} />
        <Kpi icon={ShoppingBag} label={t('analytics.kpi.avgTicket')} value={formatCurrency(Math.round(s.avgTicket))} change={percentChange(s.avgTicket, p.avgTicket)} />
        <Kpi icon={Package} label={t('analytics.kpi.units')} value={formatNumber(s.units)} change={percentChange(s.units, p.units)} />
        <Kpi icon={Users} label={t('analytics.kpi.customers')} value={formatNumber(s.customers)} change={percentChange(s.customers, p.customers)} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground px-1">
        <span>{t('analytics.kpi.margin', { pct: (s.margin * 100).toFixed(1) })}</span>
        {s.credit > 0 && <span>{t('analytics.kpi.credit', { amount: formatCurrency(Math.round(s.credit)) })}</span>}
      </div>

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-2 space-y-2">
          <CardTitle className="text-sm">{t(`analytics.chart.${metric}`)}</CardTitle>
          <div className="flex flex-wrap gap-2 justify-between">
            <Segmented<Metric> value={metric} onChange={setMetric} options={[
              { value: 'sales', label: t('analytics.metric.sales') },
              { value: 'profit', label: t('analytics.metric.profit') },
              { value: 'count', label: t('analytics.metric.count') },
            ]} />
            <Segmented<Granularity | 'auto'> value={gran} onChange={setGran} options={[
              { value: 'auto', label: t('analytics.gran.auto') },
              { value: 'day', label: t('analytics.gran.day') },
              { value: 'week', label: t('analytics.gran.week') },
              { value: 'month', label: t('analytics.gran.month') },
            ]} />
          </div>
        </CardHeader>
        <CardContent className="pb-4">
          <SimpleBars data={series as unknown as Record<string, unknown>[]} xKey="label" yKey={metric} valueFormat={fmtMetric} />
          {best && best[metric] > 0 && (
            <p className="text-[11px] text-muted-foreground mt-2">
              {t(`analytics.chart.best_${g}`, { label: best.label, value: fmtMetric(best[metric]) })}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-1"><CardTitle className="text-sm">{t('analytics.byPayment')}</CardTitle></CardHeader>
          <CardContent>
            {payments.map((m) => (
              <RankRow key={m.id} title={m.name} subtitle={t('analytics.salesCount', { count: m.count })}
                value={formatCurrency(Math.round(m.amount))} extra={`${((m.amount / (s.sales || 1)) * 100).toFixed(0)}%`} share={m.amount / (payments[0]?.amount || 1)} />
            ))}
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-1"><CardTitle className="text-sm">{t('analytics.byCategory')}</CardTitle></CardHeader>
          <CardContent>
            {cats.slice(0, 8).map((c) => (
              <RankRow key={c.id} title={c.name} subtitle={t('analytics.unitsCount', { count: c.count })}
                value={formatCurrency(Math.round(c.amount))} share={c.amount / (cats[0]?.amount || 1)} />
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

// ───────────────────────── Clientes ─────────────────────────

function CustomersTab({ lines, nameOf, range, onFilter }: {
  lines: SaleLine[];
  nameOf: (key: CustomerKey, tx?: Transaction) => string;
  range: { start: Date; end: Date };
  onFilter: (key: CustomerKey) => void;
}) {
  const { t, i18n } = useTranslation('reports');
  const locale = getDateLocale(i18n.language);
  const [sort, setSort] = useState<CustomerSort>('sales');
  const [query, setQuery] = useState('');
  const [includeWalkIn, setIncludeWalkIn] = useState(false);
  const [detail, setDetail] = useState<CustomerStat | null>(null);

  const all = useMemo(() => byCustomer(lines, nameOf), [lines, nameOf]);
  const list = all
    .filter((c) => includeWalkIn || c.key !== NO_CUSTOMER)
    .filter((c) => !query.trim() || c.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) =>
      sort === 'count' ? b.count - a.count :
      sort === 'recent' ? b.lastDate.getTime() - a.lastDate.getTime() :
      sort === 'avg' ? b.avgTicket - a.avgTicket : b.sales - a.sales);
  const max = Math.max(1, ...list.map((c) => (sort === 'count' ? c.count : sort === 'avg' ? c.avgTicket : c.sales)));
  const identified = all.filter((c) => c.key !== NO_CUSTOMER);
  const identifiedSales = identified.reduce((s, c) => s + c.sales, 0);
  const totalSales = all.reduce((s, c) => s + c.sales, 0);
  const repeat = identified.filter((c) => c.count > 1).length;

  const exportCsv = () => downloadCsv(
    [[t('analytics.csv.customer'), t('analytics.csv.purchases'), t('analytics.csv.total'), t('analytics.csv.avgTicket'),
      t('analytics.csv.profit'), t('analytics.csv.credit'), t('analytics.csv.units'), t('analytics.csv.firstPurchase'), t('analytics.csv.lastPurchase')],
    ...list.map((c) => [c.name, c.count, Math.round(c.sales), Math.round(c.avgTicket), Math.round(c.profit), Math.round(c.credit), c.units,
      format(c.firstDate, 'yyyy-MM-dd'), format(c.lastDate, 'yyyy-MM-dd')])],
    t('analytics.csv.customersFile', { from: format(range.start, 'yyyy-MM-dd'), to: format(range.end, 'yyyy-MM-dd') }),
    t('analytics.csv.done'), t('analytics.csv.failed'),
  );

  if (lines.length === 0) return <EmptyState text={t('analytics.empty')} />;

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <Kpi icon={Users} label={t('analytics.customers.identified')} value={formatNumber(identified.length)} />
        <Kpi icon={UserRound} label={t('analytics.customers.repeat')} value={formatNumber(repeat)} />
        <Kpi icon={TrendingUp} label={t('analytics.customers.share')} value={`${totalSales ? ((identifiedSales / totalSales) * 100).toFixed(0) : 0}%`} />
      </div>

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm">{t('analytics.customers.title')}</CardTitle>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={exportCsv} disabled={list.length === 0}>
              <Download className="w-3.5 h-3.5" /> CSV
            </Button>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('analytics.customers.search')} className="h-9 pl-8 text-sm" />
          </div>
          <div className="flex flex-wrap items-center gap-2 justify-between">
            <Segmented<CustomerSort> value={sort} onChange={setSort} options={[
              { value: 'sales', label: t('analytics.customers.sortSales') },
              { value: 'count', label: t('analytics.customers.sortCount') },
              { value: 'avg', label: t('analytics.customers.sortAvg') },
              { value: 'recent', label: t('analytics.customers.sortRecent') },
            ]} />
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <input type="checkbox" checked={includeWalkIn} onChange={(e) => setIncludeWalkIn(e.target.checked)} className="accent-[hsl(var(--primary))]" />
              {t('analytics.customers.includeWalkIn')}
            </label>
          </div>
        </CardHeader>
        <CardContent>
          {list.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">{t('analytics.customers.none')}</p>
          ) : list.slice(0, 100).map((c, i) => (
            <RankRow key={c.key} rank={i + 1} title={c.name}
              subtitle={t('analytics.customers.row', { count: c.count, last: format(c.lastDate, 'd MMM', { locale }) })}
              value={sort === 'avg' ? formatCurrency(Math.round(c.avgTicket)) : sort === 'count' ? t('analytics.salesCount', { count: c.count }) : formatCurrency(Math.round(c.sales))}
              extra={sort === 'sales' || sort === 'recent' ? t('analytics.customers.avg', { amount: formatCurrency(Math.round(c.avgTicket)) }) : formatCurrency(Math.round(c.sales))}
              share={(sort === 'count' ? c.count : sort === 'avg' ? c.avgTicket : c.sales) / max}
              onClick={() => setDetail(c)} />
          ))}
          {list.length > 100 && <p className="text-[11px] text-muted-foreground text-center pt-2">{t('analytics.customers.more', { count: list.length - 100 })}</p>}
        </CardContent>
      </Card>

      <CustomerDetail stat={detail} lines={lines} range={range} onClose={() => setDetail(null)}
        onFilter={(key) => { setDetail(null); onFilter(key); }} />
    </>
  );
}

function CustomerDetail({ stat, lines, range, onClose, onFilter }: {
  stat: CustomerStat | null; lines: SaleLine[]; range: { start: Date; end: Date };
  onClose: () => void; onFilter: (key: CustomerKey) => void;
}) {
  const { t, i18n } = useTranslation('reports');
  const locale = getDateLocale(i18n.language);
  const mine = useMemo(() => (stat ? lines.filter((l) => l.customerKey === stat.key) : []), [stat, lines]);
  const g = autoGranularity(range);
  const series = useMemo(() => timeSeries(mine, range, g === 'day' && mine.length < 3 ? 'week' : g, locale), [mine, range, g, locale]);
  const top = useMemo(() => byProduct(mine).sort((a, b) => b.revenue - a.revenue).slice(0, 8), [mine]);

  return (
    <Dialog open={!!stat} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[95vw] sm:max-w-lg rounded-xl max-h-[90vh] overflow-y-auto">
        {stat && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><UserRound className="w-5 h-5 text-primary" />{stat.name}</DialogTitle>
              <DialogDescription>
                {t('analytics.detail.since', { first: format(stat.firstDate, 'd MMM yyyy', { locale }), last: format(stat.lastDate, 'd MMM yyyy', { locale }) })}
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-2">
              <Kpi icon={TrendingUp} label={t('analytics.kpi.sales')} value={formatCurrency(Math.round(stat.sales))} />
              <Kpi icon={Receipt} label={t('analytics.kpi.count')} value={formatNumber(stat.count)} />
              <Kpi icon={ShoppingBag} label={t('analytics.kpi.avgTicket')} value={formatCurrency(Math.round(stat.avgTicket))} />
              <Kpi icon={Wallet} label={t('analytics.kpi.profit')} value={formatCurrency(Math.round(stat.profit))} />
            </div>
            {stat.credit > 0 && <p className="text-[11px] text-warning">{t('analytics.kpi.credit', { amount: formatCurrency(Math.round(stat.credit)) })}</p>}

            <div>
              <p className="text-xs font-semibold mb-1">{t('analytics.detail.timeline')}</p>
              <SimpleBars data={series as unknown as Record<string, unknown>[]} xKey="label" yKey="sales" valueFormat={(n) => formatCurrency(Math.round(n))} height={140} />
            </div>

            <div>
              <p className="text-xs font-semibold mb-1">{t('analytics.detail.topProducts')}</p>
              {top.map((p) => (
                <RankRow key={p.productId} title={p.name} value={formatCurrency(Math.round(p.revenue))}
                  extra={t('analytics.unitsCount', { count: p.qty })} share={p.revenue / (top[0]?.revenue || 1)} />
              ))}
            </div>

            <div>
              <p className="text-xs font-semibold mb-1">{t('analytics.detail.purchases')}</p>
              <div className="divide-y divide-border">
                {mine.slice(0, 50).map((l) => (
                  <div key={l.tx.id} className="py-2 flex items-start justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <p className="font-medium">{format(new Date(l.tx.date), 'd MMM yyyy · HH:mm', { locale })}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{l.items.map((it) => `${formatNumber(it.quantity)}× ${it.productName}`).join(', ')}</p>
                    </div>
                    <p className="font-bold shrink-0">{formatCurrency(Math.round(l.amount))}</p>
                  </div>
                ))}
              </div>
            </div>

            <Button variant="outline" className="w-full gap-1.5" onClick={() => onFilter(stat.key)}>
              <Filter className="w-4 h-4" /> {t('analytics.detail.filterBy')}
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Productos ─────────────────────────

function ProductsTab({ lines, categories, products, onFilter }: {
  lines: SaleLine[];
  categories: { id?: number; name: string }[];
  products: { id?: number; categoryId: number }[];
  onFilter: (productId: number) => void;
}) {
  const { t } = useTranslation('reports');
  const [sort, setSort] = useState<ProductSort>('qty');
  const [showAll, setShowAll] = useState(false);
  const stats = useMemo(() => byProduct(lines), [lines]);
  const sorted = [...stats].sort((a, b) => b[sort] - a[sort]);
  const max = Math.max(1, ...sorted.map((p) => p[sort]));
  const cats = byCategory(lines, products, categories, t('fallbacks.uncategorized'));
  const shown = showAll ? sorted : sorted.slice(0, 15);
  const fmt = (n: number) => (sort === 'qty' ? t('analytics.unitsCount', { count: n }) : formatCurrency(Math.round(n)));

  if (lines.length === 0) return <EmptyState text={t('analytics.empty')} />;

  return (
    <>
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-2 space-y-2">
          <CardTitle className="text-sm">{t('analytics.products.title', { count: stats.length })}</CardTitle>
          <Segmented<ProductSort> value={sort} onChange={setSort} options={[
            { value: 'qty', label: t('analytics.products.sortQty') },
            { value: 'revenue', label: t('analytics.products.sortRevenue') },
            { value: 'profit', label: t('analytics.products.sortProfit') },
          ]} />
        </CardHeader>
        <CardContent>
          {shown.map((p, i) => (
            <RankRow key={p.productId} rank={i + 1} title={p.name}
              subtitle={t('analytics.products.row', { qty: formatNumber(p.qty), count: p.count })}
              value={fmt(p[sort])}
              extra={sort === 'qty' ? formatCurrency(Math.round(p.revenue)) : t('analytics.products.margin', { pct: p.revenue ? ((p.profit / p.revenue) * 100).toFixed(0) : 0 })}
              share={Math.max(0, p[sort]) / max}
              onClick={() => onFilter(p.productId)} />
          ))}
          {sorted.length > 15 && (
            <Button variant="ghost" size="sm" className="w-full mt-1" onClick={() => setShowAll((v) => !v)}>
              {showAll ? t('analytics.showLess') : t('analytics.showAll', { count: sorted.length })}
            </Button>
          )}
          <p className="text-[10px] text-muted-foreground mt-2">{t('analytics.products.tapHint')}</p>
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-1"><CardTitle className="text-sm">{t('analytics.byCategory')}</CardTitle></CardHeader>
        <CardContent>
          <SimpleBars data={cats.slice(0, 10).map((c) => ({ name: c.name, amount: c.amount }))} xKey="name" yKey="amount"
            valueFormat={(n) => formatCurrency(Math.round(n))} height={180} />
        </CardContent>
      </Card>
    </>
  );
}

// ───────────────────────── Horarios ─────────────────────────

function TimesTab({ lines }: { lines: SaleLine[] }) {
  const { t, i18n } = useTranslation('reports');
  const locale = getDateLocale(i18n.language);
  const [metric, setMetric] = useState<'sales' | 'count'>('sales');
  // 2024-01-01 fue lunes: sirve de base para los nombres de los días.
  const dayName = (i: number) => format(new Date(2024, 0, 1 + i), 'EEE', { locale });
  const weekdays = byWeekday(lines).map((b) => ({ ...b, label: dayName(b.index) }));
  const hoursAll = byHour(lines);
  const firstHour = hoursAll.findIndex((h) => h.count > 0);
  const lastHour = 23 - [...hoursAll].reverse().findIndex((h) => h.count > 0);
  const hours = (firstHour < 0 ? hoursAll : hoursAll.slice(firstHour, lastHour + 1)).map((b) => ({ ...b, label: `${b.index}h` }));
  const fmt = (n: number) => (metric === 'count' ? t('analytics.salesCount', { count: n }) : formatCurrency(Math.round(n)));
  const bestDay = weekdays.reduce((a, b) => (b[metric] > a[metric] ? b : a), weekdays[0]);
  const bestHour = hoursAll.reduce((a, b) => (b[metric] > a[metric] ? b : a), hoursAll[0]);

  if (lines.length === 0) return <EmptyState text={t('analytics.empty')} />;

  return (
    <>
      <div className="flex justify-end">
        <Segmented<'sales' | 'count'> value={metric} onChange={setMetric} options={[
          { value: 'sales', label: t('analytics.metric.sales') },
          { value: 'count', label: t('analytics.metric.count') },
        ]} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Kpi icon={CalendarDays} label={t('analytics.times.bestDay')} value={format(new Date(2024, 0, 1 + bestDay.index), 'EEEE', { locale })} />
        <Kpi icon={Clock} label={t('analytics.times.bestHour')} value={`${bestHour.index}:00 – ${bestHour.index + 1}:00`} />
      </div>
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-1"><CardTitle className="text-sm">{t('analytics.times.weekday')}</CardTitle></CardHeader>
        <CardContent><SimpleBars data={weekdays} xKey="label" yKey={metric} valueFormat={fmt} height={170} /></CardContent>
      </Card>
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-1"><CardTitle className="text-sm">{t('analytics.times.hour')}</CardTitle></CardHeader>
        <CardContent><SimpleBars data={hours} xKey="label" yKey={metric} valueFormat={fmt} height={170} /></CardContent>
      </Card>
    </>
  );
}

// ───────────────────────── Ventas (detalle) ─────────────────────────

function SalesTab({ lines, nameOf, methods, range }: {
  lines: SaleLine[];
  nameOf: (key: CustomerKey, tx?: Transaction) => string;
  methods: { id?: number; name: string }[];
  range: { start: Date; end: Date };
}) {
  const { t, i18n } = useTranslation('reports');
  const locale = getDateLocale(i18n.language);
  const [limit, setLimit] = useState(30);
  const [open, setOpen] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const method = (id: number) => methods.find((m) => m.id === id)?.name ?? t('fallbacks.noMethod');
  const q = query.trim().toLowerCase();
  const list = q
    ? lines.filter((l) => l.tx.receiptNumber?.toLowerCase().includes(q) || nameOf(l.customerKey, l.tx).toLowerCase().includes(q)
      || l.items.some((it) => it.productName.toLowerCase().includes(q)))
    : lines;
  const total = list.reduce((s, l) => s + l.amount, 0);

  const exportCsv = () => downloadCsv(
    [[t('analytics.csv.date'), t('analytics.csv.time'), t('analytics.csv.receipt'), t('analytics.csv.customer'), t('analytics.csv.payment'),
      t('analytics.csv.products'), t('analytics.csv.units'), t('analytics.csv.total'), t('analytics.csv.profit'), t('analytics.csv.credit')],
    ...list.map((l) => [format(new Date(l.tx.date), 'yyyy-MM-dd'), format(new Date(l.tx.date), 'HH:mm'), l.tx.receiptNumber,
      nameOf(l.customerKey, l.tx), method(l.tx.paymentMethodId), l.items.map((it) => `${it.quantity}x ${it.productName}`).join(', '),
      l.units, Math.round(l.amount), Math.round(l.profit), Math.round(l.tx.debtAmount ?? 0)])],
    t('analytics.csv.salesFile', { from: format(range.start, 'yyyy-MM-dd'), to: format(range.end, 'yyyy-MM-dd') }),
    t('analytics.csv.done'), t('analytics.csv.failed'),
  );

  if (lines.length === 0) return <EmptyState text={t('analytics.empty')} />;

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-sm">{t('analytics.sales.title', { count: list.length })}</CardTitle>
            <p className="text-[11px] text-muted-foreground">{t('analytics.sales.total', { amount: formatCurrency(Math.round(total)) })}</p>
          </div>
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={exportCsv}><Download className="w-3.5 h-3.5" /> CSV</Button>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('analytics.sales.search')} className="h-9 pl-8 text-sm" />
        </div>
      </CardHeader>
      <CardContent className="divide-y divide-border">
        {list.slice(0, limit).map((l) => (
          <div key={l.tx.id} className="py-2">
            <button className="w-full flex items-start justify-between gap-2 text-left" onClick={() => setOpen(open === l.tx.id ? null : l.tx.id!)}>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{nameOf(l.customerKey, l.tx)}</p>
                <p className="text-[10px] text-muted-foreground">
                  {format(new Date(l.tx.date), 'EEE d MMM · HH:mm', { locale })} · {l.tx.receiptNumber} · {method(l.tx.paymentMethodId)}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-bold">{formatCurrency(Math.round(l.amount))}</p>
                {(l.tx.debtAmount ?? 0) > 0 && <p className="text-[10px] text-warning">{t('analytics.sales.credit', { amount: formatCurrency(Math.round(l.tx.debtAmount!)) })}</p>}
              </div>
            </button>
            {open === l.tx.id && (
              <div className="mt-2 rounded-lg bg-muted/40 p-2 space-y-1">
                {l.items.map((it) => (
                  <div key={it.id ?? `${it.productId}-${it.quantity}`} className="flex justify-between text-xs">
                    <span className="truncate">{formatNumber(it.quantity)}× {it.productName}</span>
                    <span className="font-mono shrink-0">{formatCurrency(it.subtotal)}</span>
                  </div>
                ))}
                <div className="flex justify-between text-[11px] text-muted-foreground border-t border-border pt-1">
                  <span>{t('analytics.sales.profit')}</span>
                  <span>{formatCurrency(Math.round(l.profit))}</span>
                </div>
              </div>
            )}
          </div>
        ))}
        {list.length > limit && (
          <Button variant="ghost" size="sm" className="w-full mt-1" onClick={() => setLimit((n) => n + 50)}>
            {t('analytics.sales.more', { count: list.length - limit })}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
