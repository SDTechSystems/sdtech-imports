import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  ArrowLeft, Plus, PackageSearch, Search, MapPin, Copy, MessageCircle, Trash2, Edit2, ExternalLink, CalendarClock, X,
} from 'lucide-react';
import { db, type OrderTracking, type TrackingEvent, type TrackingStage, type Customer } from '@/lib/db';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import CustomerPicker from '@/components/CustomerPicker';
import NumberInput from '@/components/NumberInput';
import LockedPage from '@/components/LockedPage';
import { useAuth } from '@/hooks/use-auth';
import { getDateLocale } from '@/i18n';
import { formatCurrency } from '@/lib/currency';
import { whatsappNumber, whatsappUserUrl } from '@/lib/customer-account';
import { cn } from '@/lib/utils';
import {
  TRACKING_STAGES, PROGRESS_STAGES, currentStage, currentCity, sortEvents, trackingProgress, trackingUrl,
  newTrackingCode, newEventId, toPublicTracking, publishTracking, unpublishTracking,
} from '@/lib/order-tracking';

type Filter = 'active' | 'delivered' | 'all';

const STAGE_TONE: Partial<Record<TrackingStage, string>> = {
  delivered: 'bg-success/15 text-success',
  issue: 'bg-destructive/15 text-destructive',
  customs: 'bg-warning/15 text-warning',
};

/** "AAAA-MM-DDTHH:mm" en hora local, para un <input type="datetime-local">. */
const localInputValue = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm");

export default function OrderTrackingPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation('settings');
  const dateLocale = getDateLocale(i18n.language);

  const orders = useLiveQuery(() => db.orderTrackings.toArray());
  const customers = useLiveQuery(() => db.customers.where('isDeleted').equals(0).toArray());
  const settings = useLiveQuery(() => db.storeSettings.toCollection().first());

  const [filter, setFilter] = useState<Filter>('active');
  const [search, setSearch] = useState('');
  const [viewId, setViewId] = useState<number | null>(null);
  const [editing, setEditing] = useState<OrderTracking | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  // Formulario del pedido
  const [customerName, setCustomerName] = useState('');
  const [customerId, setCustomerId] = useState<number | undefined>();
  const [transactionId, setTransactionId] = useState<string>('none');
  const [title, setTitle] = useState('');
  const [amountPaid, setAmountPaid] = useState('');
  const [estimatedDate, setEstimatedDate] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [firstCity, setFirstCity] = useState('');
  const [firstNote, setFirstNote] = useState('');

  // Formulario de actualización
  const [stage, setStage] = useState<TrackingStage>('purchased');
  const [city, setCity] = useState('');
  const [note, setNote] = useState('');
  const [eventDate, setEventDate] = useState(localInputValue(new Date()));
  const [removeEvent, setRemoveEvent] = useState<string | null>(null);

  const customerSales = useLiveQuery(
    async () => {
      if (!customerId) return [];
      const all = await db.transactions.filter((tx) => tx.customerId === customerId && tx.status === 'completed').toArray();
      return all.sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 20);
    },
    [customerId],
  );

  const viewing = orders?.find((o) => o.id === viewId) ?? null;

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (orders ?? [])
      .filter((o) => (filter === 'all' ? true : filter === 'delivered' ? o.status === 'delivered' : o.status !== 'delivered'))
      .filter((o) => !q || [o.title, o.customerName, o.code, o.customerPhone].some((v) => (v ?? '').toLowerCase().includes(q)))
      .sort((a, b) => +new Date(b.updatedAt ?? b.createdAt) - +new Date(a.updatedAt ?? a.createdAt));
  }, [orders, filter, search]);

  if (!can('manage_customers')) {
    return <LockedPage title={t('orderTracking.locked.title')} permissionLabel={t('orderTracking.locked.permissionLabel')} />;
  }

  const stageLabel = (s: TrackingStage) => t(`orderTracking.stages.${s}`);
  const storeName = settings?.storeName || 'SD Tech Imports';

  const publish = async (order: OrderTracking) => {
    const result = await publishTracking(toPublicTracking(order, storeName, settings?.phone));
    if (result === 'offline') toast.warning(t('orderTracking.toast.notPublished'));
    else if (result === 'error') toast.error(t('orderTracking.toast.publishError'));
  };

  const contactFor = (order: OrderTracking): { phone?: string; waUser?: string } => {
    const c = order.customerId ? customers?.find((x) => x.id === order.customerId) : undefined;
    return { phone: c?.phone || order.customerPhone, waUser: c?.whatsappUser };
  };

  const openCreate = () => {
    setEditing(null);
    setCustomerName(''); setCustomerId(undefined); setTransactionId('none'); setTitle(''); setAmountPaid('');
    setEstimatedDate(''); setInternalNotes(''); setFirstCity(''); setFirstNote('');
    setFormOpen(true);
  };

  const openEdit = (o: OrderTracking) => {
    setEditing(o);
    setCustomerName(o.customerName ?? ''); setCustomerId(o.customerId);
    setTransactionId(o.transactionId ? String(o.transactionId) : 'none');
    setTitle(o.title); setAmountPaid(o.amountPaid ? String(o.amountPaid) : '');
    setEstimatedDate(o.estimatedDate ?? ''); setInternalNotes(o.internalNotes ?? '');
    setFormOpen(true);
  };

  /** Al elegir la venta se llenan los productos, el valor pagado y, si está vacío, el título. */
  const pickSale = async (value: string) => {
    setTransactionId(value);
    if (value === 'none') return;
    const tx = await db.transactions.get(Number(value));
    const items = await db.transactionItems.where('transactionId').equals(Number(value)).toArray();
    if (tx) setAmountPaid(String(tx.total - (tx.debtAmount ?? 0)));
    if (!title.trim() && items.length) {
      setTitle(items.length === 1 ? items[0].productName : `${items[0].productName} + ${items.length - 1}`);
    }
  };

  const handleSave = async () => {
    if (!title.trim()) {
      toast.error(t('orderTracking.form.titleRequired'));
      return;
    }
    const customer: Customer | undefined = customerId ? customers?.find((c) => c.id === customerId) : undefined;
    const txId = transactionId === 'none' ? undefined : Number(transactionId);
    const items = txId
      ? (await db.transactionItems.where('transactionId').equals(txId).toArray()).map((i) => ({ name: i.productName, quantity: i.quantity }))
      : editing?.transactionId === undefined ? editing?.items : undefined;
    const base = {
      title: title.trim(),
      customerId,
      customerName: customerName.trim() || undefined,
      customerPhone: customer?.phone || undefined,
      transactionId: txId,
      items: items?.length ? items : undefined,
      amountPaid: Number(amountPaid) || undefined,
      estimatedDate: estimatedDate || undefined,
      internalNotes: internalNotes.trim() || undefined,
    };
    let saved: OrderTracking;
    if (editing?.id) {
      await db.orderTrackings.update(editing.id, base);
      saved = (await db.orderTrackings.get(editing.id))!;
      toast.success(t('orderTracking.toast.updated'));
    } else {
      const first: TrackingEvent = {
        id: newEventId(),
        stage: 'confirmed',
        city: firstCity.trim() || undefined,
        note: firstNote.trim() || undefined,
        date: new Date().toISOString(),
      };
      const order: OrderTracking = { ...base, prepaid: true, code: newTrackingCode(), status: 'confirmed', events: [first], createdAt: new Date() };
      const id = (await db.orderTrackings.add(order)) as number;
      saved = { ...order, id };
      toast.success(t('orderTracking.toast.created'));
      setViewId(id);
      prepareUpdate(saved);
    }
    setFormOpen(false);
    await publish(saved);
  };

  const prepareUpdate = (o: OrderTracking) => {
    const now = currentStage(o.events);
    const idx = PROGRESS_STAGES.indexOf(now);
    setStage(idx >= 0 && idx < PROGRESS_STAGES.length - 1 ? PROGRESS_STAGES[idx + 1] : now);
    setCity(currentCity(o.events) ?? '');
    setNote('');
    setEventDate(localInputValue(new Date()));
  };

  const openView = (o: OrderTracking) => {
    setViewId(o.id!);
    prepareUpdate(o);
  };

  const saveEvents = async (o: OrderTracking, events: TrackingEvent[]) => {
    const status = currentStage(events);
    await db.orderTrackings.update(o.id!, { events, status });
    await publish({ ...o, events, status });
  };

  const addUpdate = async () => {
    if (!viewing) return;
    // El campo no tiene segundos: si dejaron el minuto actual se usa la hora exacta,
    // para que la actualización quede después de las que se hicieron en ese mismo minuto.
    const now = new Date();
    const picked = new Date(eventDate);
    let when = isNaN(picked.getTime()) || eventDate === localInputValue(now) ? now : picked;
    const latest = sortEvents(viewing.events)[0];
    if (latest) {
      const latestDate = new Date(latest.date);
      if (when < latestDate && localInputValue(when) === localInputValue(latestDate)) when = new Date(latestDate.getTime() + 1000);
    }
    const event: TrackingEvent = {
      id: newEventId(),
      stage,
      city: city.trim() || undefined,
      note: note.trim() || undefined,
      date: when.toISOString(),
    };
    const updated = { ...viewing, events: [...viewing.events, event] };
    await saveEvents(viewing, updated.events);
    toast.success(t('orderTracking.toast.eventAdded'), {
      action: { label: t('orderTracking.detail.notify'), onClick: () => notify(updated, event) },
    });
    prepareUpdate(updated);
  };

  const confirmRemoveEvent = async () => {
    if (!viewing || !removeEvent) return;
    const events = viewing.events.filter((e) => e.id !== removeEvent);
    setRemoveEvent(null);
    if (!events.length) return;
    await saveEvents(viewing, events);
  };

  const handleDelete = async () => {
    const o = orders?.find((x) => x.id === deleteId);
    setDeleteId(null);
    if (!o?.id) return;
    await db.orderTrackings.delete(o.id);
    await db.deletedRecords.add({ tableName: 'orderTrackings', recordId: o.id, deletedAt: new Date(), syncedAt: null });
    await unpublishTracking(o.code);
    if (viewId === o.id) setViewId(null);
    toast.success(t('orderTracking.toast.deleted'));
  };

  const linkFor = (o: OrderTracking) => trackingUrl(settings, o.code);

  const copyLink = async (o: OrderTracking) => {
    try {
      await navigator.clipboard.writeText(linkFor(o));
      toast.success(t('orderTracking.toast.copied'));
    } catch {
      toast.message(linkFor(o));
    }
  };

  const messageFor = (o: OrderTracking, event?: TrackingEvent) => {
    const name = (o.customerName ?? '').split(' ')[0];
    const greeting = name ? t('orderTracking.message.greetingName', { name }) : t('orderTracking.message.greeting');
    if (!event) return `${greeting} ${t('orderTracking.message.start', { title: o.title, url: linkFor(o), code: o.code })}`;
    const where = event.city ? ` (${event.city})` : '';
    const extra = event.note ? `\n${event.note}` : '';
    return `${greeting} ${t('orderTracking.message.update', { title: o.title, stage: stageLabel(event.stage), where, url: linkFor(o) })}${extra}`;
  };

  const notify = (o: OrderTracking, event?: TrackingEvent) => {
    const text = messageFor(o, event);
    const { phone, waUser } = contactFor(o);
    const number = whatsappNumber(phone);
    const url = number
      ? `https://wa.me/${number}?text=${encodeURIComponent(text)}`
      : waUser
        ? whatsappUserUrl(waUser, text)
        : `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener');
  };

  const fmtDate = (iso: string) => format(new Date(iso), "d MMM yyyy, h:mm a", { locale: dateLocale });

  return (
    <div className="px-4 pt-6 pb-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => navigate('/settings')} aria-label={t('orderTracking.back')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <h1 className="text-xl font-bold flex items-center gap-2 min-w-0">
            <PackageSearch className="w-5 h-5 text-primary shrink-0" />
            <span className="truncate">{t('orderTracking.title')}</span>
          </h1>
        </div>
        <Button size="sm" onClick={openCreate} className="h-9 gap-1.5 shrink-0">
          <Plus className="w-4 h-4" /> {t('orderTracking.add')}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{t('orderTracking.intro')}</p>

      <div className="flex gap-1.5">
        {(['active', 'delivered', 'all'] as Filter[]).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} className="h-8 text-xs" onClick={() => setFilter(f)}>
            {t(`orderTracking.filter.${f}`)}
          </Button>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder={t('orderTracking.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-10" />
      </div>

      {list.length === 0 ? (
        <div className="text-center py-12">
          <PackageSearch className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">{t('orderTracking.empty')}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={openCreate}>
            <Plus className="w-4 h-4 mr-1" /> {t('orderTracking.add')}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((o) => {
            const last = sortEvents(o.events)[0];
            const where = currentCity(o.events);
            return (
              <Card key={o.id} className="border-0 shadow-sm cursor-pointer hover:shadow-md transition-shadow" onClick={() => openView(o)}>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold truncate">{o.title}</h3>
                      <p className="text-xs text-muted-foreground truncate">{o.customerName || t('orderTracking.noCustomer')} · {o.code}</p>
                    </div>
                    <Badge variant="secondary" className={cn('shrink-0 text-[10px]', STAGE_TONE[o.status])}>{stageLabel(o.status)}</Badge>
                  </div>
                  <Progress value={trackingProgress(o.events) * 100} className="h-1.5" />
                  <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                    {where && (<><MapPin className="w-3 h-3" /> {where} ·</>)}
                    {last ? fmtDate(last.date) : ''}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Detalle del pedido */}
      <Dialog open={!!viewing} onOpenChange={(open) => !open && setViewId(null)}>
        <DialogContent className="max-w-[95vw] sm:max-w-lg rounded-xl max-h-[90vh] overflow-y-auto">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle className="pr-6 break-words">{viewing.title}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <p>{viewing.customerName || t('orderTracking.noCustomer')}</p>
                  {viewing.amountPaid ? <p>{t('orderTracking.detail.paid', { amount: formatCurrency(viewing.amountPaid) })}</p> : null}
                  {viewing.estimatedDate && (
                    <p className="flex items-center gap-1"><CalendarClock className="w-3 h-3" /> {t('orderTracking.detail.eta', { date: format(new Date(`${viewing.estimatedDate}T12:00`), 'd MMM yyyy', { locale: dateLocale }) })}</p>
                  )}
                  {viewing.internalNotes && <p className="italic">{viewing.internalNotes}</p>}
                </div>

                <div className="rounded-lg bg-muted/50 p-3 space-y-2">
                  <p className="text-xs font-semibold">{t('orderTracking.detail.linkTitle')}</p>
                  <p className="text-xs font-mono break-all">{linkFor(viewing)}</p>
                  <div className="grid grid-cols-3 gap-2">
                    <Button size="sm" variant="outline" className="h-9 gap-1 text-xs" onClick={() => copyLink(viewing)}><Copy className="w-3.5 h-3.5" /> {t('orderTracking.detail.copy')}</Button>
                    <Button size="sm" variant="outline" className="h-9 gap-1 text-xs" asChild>
                      <a href={linkFor(viewing)} target="_blank" rel="noreferrer"><ExternalLink className="w-3.5 h-3.5" /> {t('orderTracking.detail.open')}</a>
                    </Button>
                    <Button size="sm" className="h-9 gap-1 text-xs" onClick={() => notify(viewing)}><MessageCircle className="w-3.5 h-3.5" /> {t('orderTracking.detail.send')}</Button>
                  </div>
                </div>

                <div className="space-y-3 rounded-lg border p-3">
                  <p className="text-sm font-semibold">{t('orderTracking.detail.addUpdate')}</p>
                  <div className="space-y-1.5">
                    <Label>{t('orderTracking.detail.stage')}</Label>
                    <Select value={stage} onValueChange={(v) => setStage(v as TrackingStage)}>
                      <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TRACKING_STAGES.map((s) => <SelectItem key={s} value={s}>{stageLabel(s)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('orderTracking.detail.city')}</Label>
                    <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder={t('orderTracking.detail.cityPlaceholder')} className="h-11" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('orderTracking.detail.note')}</Label>
                    <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('orderTracking.detail.notePlaceholder')} rows={2} />
                    <p className="text-[11px] text-muted-foreground">{t('orderTracking.detail.noteHint')}</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('orderTracking.detail.date')}</Label>
                    <Input type="datetime-local" value={eventDate} onChange={(e) => setEventDate(e.target.value)} className="h-11" />
                  </div>
                  <Button className="w-full h-11" onClick={addUpdate}>{t('orderTracking.detail.save')}</Button>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-semibold">{t('orderTracking.detail.history')}</p>
                  <ol className="space-y-2">
                    {sortEvents(viewing.events).map((e) => (
                      <li key={e.id} className="flex items-start gap-2 rounded-lg bg-muted/40 p-2.5">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className={cn('text-sm font-semibold', e.stage === 'issue' && 'text-destructive')}>{stageLabel(e.stage)}</span>
                            <span className="text-[11px] text-muted-foreground whitespace-nowrap">{fmtDate(e.date)}</span>
                          </div>
                          {e.city && <p className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="w-3 h-3" /> {e.city}</p>}
                          {e.note && <p className="text-xs mt-0.5 whitespace-pre-line break-words">{e.note}</p>}
                        </div>
                        {viewing.events.length > 1 && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setRemoveEvent(e.id)} aria-label={t('orderTracking.detail.removeEvent')}>
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" className="h-10 gap-1.5" onClick={() => openEdit(viewing)}><Edit2 className="w-4 h-4" /> {t('orderTracking.detail.edit')}</Button>
                  <Button variant="outline" className="h-10 gap-1.5 text-destructive" onClick={() => setDeleteId(viewing.id!)}><Trash2 className="w-4 h-4" /> {t('orderTracking.detail.delete')}</Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Crear / editar */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-[95vw] sm:max-w-lg rounded-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing ? t('orderTracking.form.editTitle') : t('orderTracking.form.addTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>{t('orderTracking.form.customer')}</Label>
              <CustomerPicker
                customers={customers ?? []}
                value={customerName}
                customerId={customerId}
                onChange={(name, id) => { setCustomerName(name); setCustomerId(id); if (id !== customerId) setTransactionId('none'); }}
              />
            </div>
            {customerId && (customerSales?.length ?? 0) > 0 && (
              <div className="space-y-1.5">
                <Label>{t('orderTracking.form.sale')}</Label>
                <Select value={transactionId} onValueChange={pickSale}>
                  <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('orderTracking.form.noSale')}</SelectItem>
                    {customerSales!.map((tx) => (
                      <SelectItem key={tx.id} value={String(tx.id)}>
                        {format(new Date(tx.date), 'd MMM yyyy', { locale: dateLocale })} · {formatCurrency(tx.total)} · {tx.receiptNumber}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">{t('orderTracking.form.saleHint')}</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>{t('orderTracking.form.title')}</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('orderTracking.form.titlePlaceholder')} className="h-11" />
              <p className="text-[11px] text-muted-foreground">{t('orderTracking.form.titleHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t('orderTracking.form.amountPaid')}</Label>
              <NumberInput value={amountPaid} onChange={setAmountPaid} placeholder="0" className="h-11" />
            </div>
            <div className="space-y-1.5">
              <Label>{t('orderTracking.form.eta')}</Label>
              <Input type="date" value={estimatedDate} onChange={(e) => setEstimatedDate(e.target.value)} className="h-11" />
            </div>
            {!editing && (
              <>
                <div className="space-y-1.5">
                  <Label>{t('orderTracking.form.firstCity')}</Label>
                  <Input value={firstCity} onChange={(e) => setFirstCity(e.target.value)} placeholder={t('orderTracking.detail.cityPlaceholder')} className="h-11" />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('orderTracking.form.firstNote')}</Label>
                  <Textarea value={firstNote} onChange={(e) => setFirstNote(e.target.value)} placeholder={t('orderTracking.detail.notePlaceholder')} rows={2} />
                </div>
              </>
            )}
            <div className="space-y-1.5">
              <Label>{t('orderTracking.form.internalNotes')}</Label>
              <Textarea value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} placeholder={t('orderTracking.form.internalNotesPlaceholder')} rows={2} />
            </div>
            <Button className="w-full h-11" onClick={handleSave}>{t('orderTracking.form.save')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent className="max-w-[90vw] rounded-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('orderTracking.deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('orderTracking.deleteDialog.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('orderTracking.deleteDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">{t('orderTracking.deleteDialog.confirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!removeEvent} onOpenChange={() => setRemoveEvent(null)}>
        <AlertDialogContent className="max-w-[90vw] rounded-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('orderTracking.removeEventDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('orderTracking.removeEventDialog.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('orderTracking.deleteDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemoveEvent} className="bg-destructive text-destructive-foreground">{t('orderTracking.removeEventDialog.confirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
