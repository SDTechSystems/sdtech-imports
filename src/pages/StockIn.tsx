import { useLiveQuery } from 'dexie-react-hooks';
import { db, isStockManaged, type ImportOrigin } from '@/lib/db';
import { useEffect, useState } from 'react';
import { ArrowDownToLine, Plus, ChevronLeft, Plane, PackageCheck, RefreshCw, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/use-auth';
import LockedPage from '@/components/LockedPage';
import ProductPicker from '@/components/ProductPicker';
import SearchableSelect from '@/components/SearchableSelect';
import NumberInput from '@/components/NumberInput';
import ReceiveImportDialog from '@/components/ReceiveImportDialog';
import { useTranslation } from 'react-i18next';
import { formatCurrency } from '@/lib/currency';
import { getDateLocale } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  ORIGINS,
  ORIGIN_FLAG,
  fetchUsdCopRate,
  formatUsd,
  isInTransit,
  newOrderId,
  receiveStockIns,
  splitOrderCost,
  type ExchangeRate,
} from '@/lib/imports';

type StatusFilter = 'all' | 'in_transit' | 'received';
type PayCurrency = 'USD' | 'COP';

interface OrderLine {
  key: string;
  productId: string;
  quantity: string;
  unitPrice: string; // en la moneda elegida
}

const emptyLine = (): OrderLine => ({ key: crypto.randomUUID(), productId: '', quantity: '', unitPrice: '' });

export default function StockInPage() {
  const { currentUser, can } = useAuth();
  const { t, i18n } = useTranslation('settings');
  const dateLocale = getDateLocale(i18n.language);
  const [searchParams, setSearchParams] = useSearchParams();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [lines, setLines] = useState<OrderLine[]>([emptyLine()]);
  const [supplierId, setSupplierId] = useState('');
  const [currency, setCurrency] = useState<PayCurrency>('USD');
  const [rate, setRate] = useState('');
  const [marketRate, setMarketRate] = useState<ExchangeRate | null>(null);
  const [rateLoading, setRateLoading] = useState(false);
  const [shipping, setShipping] = useState('');
  const [origin, setOrigin] = useState<ImportOrigin>('US');
  const [inTransit, setInTransit] = useState(true);
  const [tracking, setTracking] = useState('');
  const [notes, setNotes] = useState('');
  const [toHome, setToHome] = useState(false);
  const [filterSupplier, setFilterSupplier] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    searchParams.get('estado') === 'transito' ? 'in_transit' : 'all',
  );
  const [openId, setOpenId] = useState<number | null>(null);

  const stockIns = useLiveQuery(() => db.stockIns.orderBy('date').reverse().toArray());
  const products = useLiveQuery(() => db.products.where('isDeleted').equals(0).toArray());
  const suppliers = useLiveQuery(() => db.suppliers.where('isDeleted').equals(0).toArray());
  const storeSettings = useLiveQuery(() => db.storeSettings.toCollection().first());

  useEffect(() => {
    const id = Number(searchParams.get('abrir'));
    if (id) {
      setOpenId(id);
      searchParams.delete('abrir');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  if (!can('manage_stock_inout')) {
    return <LockedPage title={t('stockIn.locked.title')} permissionLabel={t('stockIn.locked.permissionLabel')} />;
  }

  const filtered = stockIns?.filter(si =>
    (filterSupplier === 'all' || si.supplierId === Number(filterSupplier)) &&
    (statusFilter === 'all' || (statusFilter === 'in_transit' ? isInTransit(si) : !isInTransit(si)))
  ) ?? [];
  const transitCount = stockIns?.filter(isInTransit).length ?? 0;

  const getProductName = (pid: number) => products?.find(p => p.id === pid)?.name ?? '-';
  const getSupplierName = (sid: number) => suppliers?.find(s => s.id === sid)?.name;

  const loadRate = async () => {
    setRateLoading(true);
    try {
      const r = await fetchUsdCopRate();
      setMarketRate(r);
      return r;
    } catch {
      toast.error(t('stockIn.import.rateError'));
      return null;
    } finally {
      setRateLoading(false);
    }
  };

  const openAdd = async () => {
    setLines([emptyLine()]); setSupplierId(''); setShipping('');
    setNotes(''); setTracking(''); setToHome(false); setCurrency('USD'); setOrigin('US'); setInTransit(true);
    setRate(storeSettings?.lastExchangeRate ? String(storeSettings.lastExchangeRate) : '');
    setDialogOpen(true);
    // Se propone la tasa del día; si no hay conexión queda la última que usaste.
    const r = await loadRate();
    if (r) setRate(String(Math.round(r.rate)));
  };

  const rateNum = currency === 'USD' ? Number(rate) || 0 : 1;
  const parsedLines = lines.map(l => ({ ...l, qty: Number(l.quantity) || 0, price: Number(l.unitPrice) || 0 }));
  const costs = splitOrderCost(parsedLines.map(l => ({ quantity: l.qty, unitPrice: l.price })), rateNum, Number(shipping) || 0);
  const orderTotal = costs.reduce((a, c) => a + c.totalCop, 0);
  const orderUsd = parsedLines.reduce((a, l) => a + l.qty * l.price, 0);
  const isMulti = lines.length > 1;
  const linesReady = parsedLines.every(l => l.productId && l.qty > 0 && l.price > 0);

  const updateLine = (key: string, patch: Partial<OrderLine>) =>
    setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));

  const handleSave = async () => {
    if (!linesReady || (currency === 'USD' && rateNum <= 0)) {
      toast.error(t('stockIn.toast.fillAll'));
      return;
    }
    const now = new Date();
    const orderId = isMulti ? newOrderId() : undefined;
    const ids: number[] = [];
    for (const [i, l] of parsedLines.entries()) {
      const cost = costs[i];
      ids.push(await db.stockIns.add({
        productId: Number(l.productId),
        supplierId: Number(supplierId) || 0,
        quantity: l.qty,
        buyPrice: cost.unitCop,
        totalPrice: cost.totalCop,
        date: now,
        notes: notes.trim(),
        createdBy: currentUser?.id,
        status: 'in_transit',
        origin,
        ...(currency === 'USD'
          ? {
              usdUnitPrice: l.price,
              exchangeRate: rateNum,
              exchangeRateSource: marketRate && Math.round(marketRate.rate) === Math.round(rateNum) ? 'market' as const : 'manual' as const,
            }
          : {}),
        shippingCost: cost.shippingCop || undefined,
        tracking: tracking.trim() || undefined,
        orderId,
        toHome,
        receivedAt: null,
      }) as number);
    }

    if (currency === 'USD' && storeSettings?.id) {
      await db.storeSettings.update(storeSettings.id, { lastExchangeRate: rateNum });
    }

    const first = products?.find(p => p.id === Number(parsedLines[0].productId));
    if (!inTransit) {
      await receiveStockIns(ids, now);
      if (isMulti) {
        toast.success(t('stockIn.import.orderReceivedToast', { count: ids.length }));
      } else {
        const updated = await db.products.get(Number(parsedLines[0].productId));
        toast.success(t('stockIn.toast.success', { product: first?.name ?? '', qty: parsedLines[0].qty, hpp: (updated?.hpp ?? costs[0].unitCop).toLocaleString('es-CO') }));
      }
    } else if (isMulti) {
      toast.success(t('stockIn.import.orderSavedInTransit', { count: ids.length }));
    } else {
      toast.success(t('stockIn.import.savedInTransit', { product: first?.name ?? '', qty: parsedLines[0].qty }));
    }
    setDialogOpen(false);
  };

  return (
    <div className="px-4 pt-6 pb-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link to="/settings">
            <Button variant="ghost" size="icon" className="h-8 w-8"><ChevronLeft className="w-4 h-4" /></Button>
          </Link>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <ArrowDownToLine className="w-5 h-5 text-success" />
            {t('stockIn.title')}
          </h1>
        </div>
        <Button size="sm" onClick={openAdd} className="h-9 gap-1.5">
          <Plus className="w-4 h-4" /> {t('stockIn.add')}
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
        {(['all', 'in_transit', 'received'] as StatusFilter[]).map(f => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className={cn(
              'rounded-md py-1.5 text-xs font-medium transition-colors',
              statusFilter === f ? 'bg-background shadow-sm' : 'text-muted-foreground',
            )}
          >
            {t(`stockIn.import.filter.${f}`)}{f === 'in_transit' && transitCount > 0 ? ` (${transitCount})` : ''}
          </button>
        ))}
      </div>

      <SearchableSelect
        value={filterSupplier}
        onChange={setFilterSupplier}
        placeholder={t('stockIn.supplierFilter.placeholder')}
        searchPlaceholder={t('stockIn.supplierFilter.searchPlaceholder')}
        options={[
          { value: 'all', label: t('stockIn.supplierFilter.all') },
          ...(suppliers?.map(s => ({ value: s.id!.toString(), label: s.name })) ?? []),
        ]}
      />

      <p className="text-xs text-muted-foreground">{t('stockIn.count', { count: filtered.length })}</p>

      {filtered.length === 0 ? (
        <div className="text-center py-12">
          <ArrowDownToLine className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">{t('stockIn.empty')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(si => {
            const transit = isInTransit(si);
            const supplierName = getSupplierName(si.supplierId);
            return (
              <Card key={si.id} className="border-0 shadow-sm cursor-pointer active:scale-[0.99] transition-transform" onClick={() => setOpenId(si.id!)}>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold truncate">
                        {si.origin && <span className="mr-1">{ORIGIN_FLAG[si.origin]}</span>}
                        {getProductName(si.productId)}
                      </h3>
                      {supplierName && <p className="text-xs text-muted-foreground">{t('stockIn.item.fromSupplier', { supplier: supplierName })}</p>}
                      <div className="flex flex-wrap items-center gap-2 mt-1.5">
                        <span className={cn(
                          'text-xs font-medium px-2 py-0.5 rounded inline-flex items-center gap-1',
                          transit ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' : 'bg-success/10 text-success',
                        )}>
                          {transit ? <Plane className="w-3 h-3" /> : <PackageCheck className="w-3 h-3" />}
                          {transit ? t('stockIn.import.statusTransit') : t('stockIn.import.statusReceived')}
                        </span>
                        <span className="text-xs font-medium">{t('stockIn.item.quantity', { qty: si.quantity })}</span>
                        {si.orderId && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{si.orderId}</span>
                        )}
                        {si.usdUnitPrice !== undefined && (
                          <span className="text-xs text-muted-foreground">{formatUsd(si.usdUnitPrice)} × {formatCurrency(si.exchangeRate ?? 0)}</span>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs text-muted-foreground">{format(new Date(si.date), 'dd MMM yy', { locale: dateLocale })}</p>
                      <p className="text-sm font-bold mt-1">{formatCurrency(si.totalPrice)}</p>
                      {transit && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 mt-1.5 text-[11px] px-2"
                          onClick={(e) => { e.stopPropagation(); setOpenId(si.id!); }}
                        >
                          {t('stockIn.import.receiveShort')}
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ReceiveImportDialog stockInId={openId} onClose={() => setOpenId(null)} />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-xl">
          <DialogHeader><DialogTitle>{t('stockIn.dialog.title')}</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>{t('stockIn.import.originLabel')}</Label>
              <div className="grid grid-cols-4 gap-1.5">
                {ORIGINS.map(o => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => { setOrigin(o); if (o === 'CO') { setCurrency('COP'); setInTransit(false); } }}
                    className={cn(
                      'rounded-lg border py-2 text-xs font-medium flex flex-col items-center gap-0.5',
                      origin === o ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground',
                    )}
                  >
                    <span className="text-base leading-none">{ORIGIN_FLAG[o]}</span>
                    {t(`stockIn.import.origin.${o}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t('stockIn.dialog.supplierLabelOptional')}</Label>
              <SearchableSelect
                value={supplierId}
                onChange={setSupplierId}
                placeholder={t('stockIn.import.supplierPlaceholder')}
                searchPlaceholder={t('stockIn.supplierFilter.searchPlaceholder')}
                options={suppliers?.map(s => ({ value: s.id!.toString(), label: s.name })) ?? []}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t('stockIn.import.paidIn')}</Label>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                {(['USD', 'COP'] as PayCurrency[]).map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCurrency(c)}
                    className={cn('rounded-md py-1.5 text-xs font-semibold', currency === c ? 'bg-background shadow-sm' : 'text-muted-foreground')}
                  >
                    {t(`stockIn.import.currency.${c}`)}
                  </button>
                ))}
              </div>
            </div>

            {currency === 'USD' && (
              <div className="space-y-1.5">
                <Label>{t('stockIn.import.rateLabel')}</Label>
                <div className="flex gap-2">
                  <NumberInput value={rate} onChange={setRate} placeholder="4000" className="h-11 flex-1" decimal />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 gap-1.5 shrink-0"
                    disabled={rateLoading}
                    onClick={async () => { const r = await loadRate(); if (r) setRate(String(Math.round(r.rate))); }}
                  >
                    <RefreshCw className={cn('w-4 h-4', rateLoading && 'animate-spin')} />
                    {t('stockIn.import.useTodayRate')}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {marketRate
                    ? t('stockIn.import.rateHint', {
                        rate: formatCurrency(Math.round(marketRate.rate)),
                        source: marketRate.source === 'trm' ? t('stockIn.import.sourceTrm') : marketRate.source,
                        date: marketRate.date ?? '',
                      })
                    : rateLoading ? t('stockIn.import.rateLoading') : t('stockIn.import.rateManualHint')}
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label>{t('stockIn.import.productsLabel')}</Label>
              {lines.map((l, i) => (
                <div key={l.key} className="rounded-lg border border-border p-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <ProductPicker
                        products={products ?? []}
                        value={l.productId}
                        onChange={(v) => updateLine(l.key, { productId: v })}
                        filter={p => isStockManaged(p)}
                        showHpp
                      />
                    </div>
                    {isMulti && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0 text-destructive"
                        aria-label={t('stockIn.import.removeLine')}
                        onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">{t('stockIn.dialog.quantityLabel')}</Label>
                      <NumberInput value={l.quantity} onChange={(v) => updateLine(l.key, { quantity: v })} placeholder="1" className="h-10" decimal />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">{currency === 'USD' ? t('stockIn.import.usdPriceLabel') : t('stockIn.dialog.buyPriceLabel')}</Label>
                      <NumberInput value={l.unitPrice} onChange={(v) => updateLine(l.key, { unitPrice: v })} placeholder={currency === 'USD' ? '24,99' : t('stockIn.dialog.buyPricePlaceholder')} className="h-10" decimal={currency === 'USD'} />
                    </div>
                  </div>
                  {isMulti && parsedLines[i].qty > 0 && parsedLines[i].price > 0 && rateNum > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      {t('stockIn.import.lineSummary', {
                        total: formatCurrency(costs[i].totalCop),
                        shipping: formatCurrency(costs[i].shippingCop),
                        unit: formatCurrency(costs[i].unitCop),
                      })}
                    </p>
                  )}
                </div>
              ))}
              <Button type="button" variant="outline" className="w-full h-10 gap-1.5" onClick={() => setLines(ls => [...ls, emptyLine()])}>
                <Plus className="w-4 h-4" /> {t('stockIn.import.addLine')}
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label>{t('stockIn.import.shippingLabel')}</Label>
              <NumberInput value={shipping} onChange={setShipping} placeholder="0" className="h-11" />
              <p className="text-[11px] text-muted-foreground">{isMulti ? t('stockIn.import.shippingHintOrder') : t('stockIn.import.shippingHint')}</p>
            </div>

            {linesReady && rateNum > 0 && (
              <div className="bg-muted/50 p-3 rounded-xl text-sm space-y-1">
                {currency === 'USD' && (
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">{formatUsd(orderUsd)} × {formatCurrency(rateNum)}</span>
                    <span>{formatCurrency(costs.reduce((a, c) => a + c.productCop, 0))}</span>
                  </div>
                )}
                {(Number(shipping) || 0) > 0 && (
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">{t('stockIn.import.shipping')}</span>
                    <span>{formatCurrency(costs.reduce((a, c) => a + c.shippingCop, 0))}</span>
                  </div>
                )}
                <div className="flex justify-between gap-2 font-bold">
                  <span>{t('stockIn.import.totalCop')}</span>
                  <span>{formatCurrency(orderTotal)}</span>
                </div>
                {!isMulti && (
                  <div className="flex justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">{t('stockIn.import.unitCost')}</span>
                    <span>{formatCurrency(costs[0].unitCop)}</span>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label>{t('stockIn.import.tracking')}</Label>
              <Input value={tracking} onChange={e => setTracking(e.target.value)} placeholder={t('stockIn.import.trackingPlaceholder')} className="h-11" />
            </div>

            <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <div>
                <p className="text-sm font-semibold flex items-center gap-1.5"><Plane className="w-4 h-4 text-amber-500" /> {t('stockIn.import.inTransitLabel')}</p>
                <p className="text-[10px] text-muted-foreground">{inTransit ? t('stockIn.import.inTransitOn') : t('stockIn.import.inTransitOff')}</p>
              </div>
              <Switch checked={inTransit} onCheckedChange={setInTransit} />
            </div>

            <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-semibold">{t('stockIn.dialog.toHomeLabel')}</p>
                <p className="text-[10px] text-muted-foreground">{t('stockIn.dialog.toHomeDesc')}</p>
              </div>
              <Switch checked={toHome} onCheckedChange={setToHome} />
            </div>
            <div className="space-y-1.5"><Label>{t('stockIn.dialog.notesLabel')}</Label><Input value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('stockIn.dialog.notesPlaceholder')} className="h-11" /></div>
            <Button className="w-full h-12 text-base font-semibold" onClick={handleSave}>{t('stockIn.dialog.save')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
