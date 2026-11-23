import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { format } from 'date-fns';
import { ArrowLeft, Banknote, CheckCircle2, ChevronRight, CreditCard, FileImage, PiggyBank, Search, UserRound, Wallet } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { db, type Customer, type Debt, type TransactionItemRecord } from '@/lib/db';
import { useAuth } from '@/hooks/use-auth';
import LockedPage from '@/components/LockedPage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from 'react-i18next';
import { CURRENCY_SYMBOL, NUMBER_LOCALE } from '@/lib/currency';
import { getDateLocale } from '@/i18n';
import CustomerStatement from '@/components/CustomerStatement';
import type { StatementLine } from '@/lib/customer-statement';
import {
  addCustomerCredit,
  applyCreditToDebts,
  creditBalance,
  CREDIT_METHOD_CATEGORY,
  customerKey,
  recordCustomerPayment,
  customerLabel,
} from '@/lib/customer-account';

type DebtFilter = 'active' | 'settled' | 'all';

interface Account {
  key: string;
  name: string;
  customer?: Customer;
  debts: Debt[];
  pending: Debt[];
  remaining: number;
  credit: number;
  oldest?: Date;
}

export default function DebtsPage() {
  const navigate = useNavigate();
  const { can, currentUser } = useAuth();
  const { t, i18n } = useTranslation('settings');
  const dateLocale = getDateLocale(i18n.language);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<DebtFilter>('active');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethodId, setPaymentMethodId] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [creditOpen, setCreditOpen] = useState(false);
  const [creditAmount, setCreditAmount] = useState('');
  const [creditNote, setCreditNote] = useState('');
  const [statementOpen, setStatementOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const debts = useLiveQuery(() => db.debts.toArray());
  const payments = useLiveQuery(() => db.debtPayments.orderBy('date').reverse().toArray());
  const transactions = useLiveQuery(() => db.transactions.toArray());
  const items = useLiveQuery(() => db.transactionItems.toArray());
  const customers = useLiveQuery(() => db.customers.where('isDeleted').equals(0).toArray());
  const paymentMethods = useLiveQuery(() => db.paymentMethods.toArray());
  const storeSettings = useLiveQuery(() => db.storeSettings.toCollection().first());

  const txById = useMemo(() => new Map((transactions ?? []).map((tx) => [tx.id, tx])), [transactions]);
  const itemsByTx = useMemo(() => {
    const map = new Map<number, TransactionItemRecord[]>();
    for (const it of items ?? []) {
      const list = map.get(it.transactionId) ?? [];
      list.push(it);
      map.set(it.transactionId, list);
    }
    return map;
  }, [items]);

  const accounts = useMemo(() => {
    const byKey = new Map<string, Account>();
    const customerById = new Map((customers ?? []).map((c) => [c.id, c]));
    for (const d of debts ?? []) {
      const key = customerKey(d);
      const acc = byKey.get(key) ?? { key, name: d.customerName, customer: d.customerId ? customerById.get(d.customerId) : undefined, debts: [], pending: [], remaining: 0, credit: 0 };
      acc.debts.push(d);
      if (d.status !== 'paid' && d.remainingAmount > 0) {
        acc.pending.push(d);
        acc.remaining += d.remainingAmount;
        const created = new Date(d.createdAt);
        if (!acc.oldest || created < acc.oldest) acc.oldest = created;
      }
      byKey.set(key, acc);
    }
    // Clientes con saldo a favor aunque no tengan deudas.
    for (const c of customers ?? []) {
      const balance = creditBalance(c);
      const key = `id:${c.id}`;
      if (balance !== 0 && !byKey.has(key)) byKey.set(key, { key, name: c.name, customer: c, debts: [], pending: [], remaining: 0, credit: 0 });
    }
    for (const acc of byKey.values()) {
      acc.credit = creditBalance(acc.customer);
      if (acc.customer) acc.name = customerLabel(acc.customer);
      acc.pending.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }
    return [...byKey.values()].sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name));
  }, [debts, customers]);

  if (!can('manage_customers')) {
    return <LockedPage title={t('debts.locked.title')} permissionLabel={t('debts.locked.permissionLabel')} />;
  }

  const numberLocale = NUMBER_LOCALE;
  const rp = (value: number) => `${CURRENCY_SYMBOL} ${Math.round(value).toLocaleString(numberLocale)}`;
  const getPaymentName = (id: number) => paymentMethods?.find((m) => m.id === id)?.name ?? t('debts.deletedMethodFallback');

  const totalReceivable = accounts.reduce((s, a) => s + a.remaining, 0);
  const debtorCount = accounts.filter((a) => a.remaining > 0).length;
  const totalCredit = accounts.reduce((s, a) => s + Math.max(0, a.credit), 0);

  const filtered = accounts.filter((a) => {
    if (filter === 'active' && a.remaining <= 0 && a.credit <= 0) return false;
    if (filter === 'settled' && a.remaining > 0) return false;
    if (!search.trim()) return true;
    return a.name.toLowerCase().includes(search.toLowerCase());
  });

  const selected = accounts.find((a) => a.key === selectedKey) ?? null;
  const selectedPayments = selected
    ? (payments ?? []).filter((p) => selected.debts.some((d) => d.id === p.debtId))
    : [];

  const statementLines: StatementLine[] = (selected?.pending ?? []).map((d) => {
    const tx = txById.get(d.transactionId);
    const txItems = itemsByTx.get(d.transactionId) ?? [];
    return {
      date: new Date(tx?.date ?? d.createdAt),
      items: txItems.map((i) => ({ name: i.productName, quantity: i.quantity, subtotal: i.subtotal })),
      original: d.originalAmount,
      paid: d.originalAmount - d.remainingAmount,
      remaining: d.remainingAmount,
    };
  });

  const cashMethods = (paymentMethods ?? []).filter((m) => m.category !== CREDIT_METHOD_CATEGORY);

  const openPayment = () => {
    if (!selected) return;
    setPaymentAmount(String(selected.remaining));
    setPaymentMethodId(cashMethods[0]?.id?.toString() ?? '');
    setPaymentNotes('');
    setPaymentOpen(true);
  };

  const savePayment = async () => {
    if (!selected) return;
    const amount = Math.round(Number(paymentAmount) || 0);
    if (amount <= 0) return toast.error(t('debts.toast.invalidAmount'));
    if (!paymentMethodId) return toast.error(t('debts.toast.selectMethod'));
    if (amount > selected.remaining && !selected.customer?.id) return toast.error(t('debts.toast.invalidAmount'));
    setSaving(true);
    try {
      const { toCredit } = await recordCustomerPayment({
        debts: selected.pending,
        customerId: selected.customer?.id,
        amount,
        paymentMethodId: Number(paymentMethodId),
        notes: paymentNotes.trim() || undefined,
        userId: currentUser?.id,
      });
      setPaymentOpen(false);
      if (toCredit > 0) toast.success(t('debtsAccount.toast.excessToCredit', { amount: rp(toCredit) }));
      else toast.success(amount >= selected.remaining ? t('debts.toast.paidOff') : t('debts.toast.recorded'));
    } catch {
      toast.error(t('debts.toast.failed'));
    } finally {
      setSaving(false);
    }
  };

  const saveCredit = async () => {
    if (!selected?.customer?.id) return;
    const amount = Math.round(Number(creditAmount) || 0);
    if (amount <= 0) return toast.error(t('debts.toast.invalidAmount'));
    setSaving(true);
    try {
      await addCustomerCredit(selected.customer.id, amount, creditNote.trim() || t('debtsAccount.credit.defaultNote'));
      setCreditOpen(false);
      toast.success(t('debtsAccount.toast.creditAdded'));
    } catch {
      toast.error(t('debts.toast.failed'));
    } finally {
      setSaving(false);
    }
  };

  const useCredit = async () => {
    if (!selected?.customer?.id) return;
    setSaving(true);
    try {
      const applied = await applyCreditToDebts(selected.customer.id, selected.pending, currentUser?.id);
      toast.success(t('debtsAccount.toast.creditUsed', { amount: rp(applied) }));
    } catch {
      toast.error(t('debts.toast.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-4 pt-6 pb-4 space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(-1)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <CreditCard className="w-5 h-5 text-primary" />
          {t('debts.title')}
        </h1>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="bg-warning/10 p-3 rounded-lg">
          <p className="text-[10px] text-muted-foreground">{t('debts.summary.totalReceivable')}</p>
          <p className="text-lg font-bold text-warning">{rp(totalReceivable)}</p>
        </div>
        <div className="bg-muted/50 p-3 rounded-lg">
          <p className="text-[10px] text-muted-foreground">{t('debtsAccount.debtors')}</p>
          <p className="text-lg font-bold">{debtorCount}</p>
          {totalCredit > 0 && <p className="text-[10px] text-success">{t('debtsAccount.creditTotal', { amount: rp(totalCredit) })}</p>}
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('debtsAccount.searchPlaceholder')} className="pl-9 h-10" />
      </div>

      <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
        {([
          ['active', t('debts.filters.active')],
          ['settled', t('debtsAccount.filters.settled')],
          ['all', t('debts.filters.all')],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`h-9 rounded-md text-xs font-semibold transition-colors ${filter === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12">
          <CheckCircle2 className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">{t('debts.empty')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((a) => (
            <Card key={a.key} className="border-0 shadow-sm">
              <CardContent className="p-3">
                <button type="button" className="w-full text-left" onClick={() => setSelectedKey(a.key)}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{a.name}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {a.remaining > 0
                          ? t('debtsAccount.pendingCount', { count: a.pending.length, date: a.oldest ? format(a.oldest, 'dd MMM', { locale: dateLocale }) : '' })
                          : t('debtsAccount.upToDate')}
                      </p>
                      {a.credit > 0 && <Badge variant="secondary" className="mt-1 text-[10px] text-success">{t('debtsAccount.creditBadge', { amount: rp(a.credit) })}</Badge>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <p className={`text-base font-bold ${a.remaining > 0 ? 'text-warning' : 'text-success'}`}>{rp(a.remaining)}</p>
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                </button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Sheet open={!!selected && !paymentOpen && !creditOpen && !statementOpen} onOpenChange={(open) => { if (!open) setSelectedKey(null); }}>
        <SheetContent side="bottom" className="max-h-[88vh] rounded-t-xl overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2"><UserRound className="w-4 h-4" />{selected.name}</SheetTitle>
              </SheetHeader>
              <div className="space-y-4 mt-4">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border p-3">
                    <p className="text-[10px] text-muted-foreground">{t('debtsAccount.owes')}</p>
                    <p className="text-lg font-bold text-warning">{rp(selected.remaining)}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-[10px] text-muted-foreground">{t('debtsAccount.creditLabel')}</p>
                    <p className="text-lg font-bold text-success">{rp(selected.credit)}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Button className="h-11 gap-1.5" onClick={openPayment} disabled={selected.remaining <= 0 && !selected.customer}>
                    <Banknote className="w-4 h-4" /> {t('debts.recordPayment')}
                  </Button>
                  <Button variant="outline" className="h-11 gap-1.5" onClick={() => setStatementOpen(true)} disabled={selected.pending.length === 0}>
                    <FileImage className="w-4 h-4" /> {t('debtsAccount.statement')}
                  </Button>
                  {selected.customer?.id && (
                    <Button variant="outline" className="h-10 gap-1.5 text-xs" onClick={() => { setCreditAmount(''); setCreditNote(''); setCreditOpen(true); }}>
                      <PiggyBank className="w-4 h-4" /> {t('debtsAccount.addCredit')}
                    </Button>
                  )}
                  {selected.customer?.id && selected.credit > 0 && selected.remaining > 0 && (
                    <Button variant="outline" className="h-10 gap-1.5 text-xs" onClick={useCredit} disabled={saving}>
                      <Wallet className="w-4 h-4" /> {t('debtsAccount.useCredit')}
                    </Button>
                  )}
                </div>
                {!selected.customer && <p className="text-[11px] text-muted-foreground">{t('debtsAccount.noCustomerHint')}</p>}

                <div className="space-y-2">
                  <p className="text-sm font-semibold">{t('debtsAccount.pendingTitle')}</p>
                  {selected.pending.length === 0 && <p className="text-xs text-muted-foreground py-2 text-center">{t('debtsAccount.nothingPending')}</p>}
                  {selected.pending.map((d) => {
                    const tx = txById.get(d.transactionId);
                    const txItems = itemsByTx.get(d.transactionId) ?? [];
                    return (
                      <button key={d.id} type="button" className="w-full text-left rounded-lg border p-3" onClick={() => navigate(`/history?txId=${d.transactionId}`)}>
                        <div className="flex justify-between gap-3">
                          <p className="text-[11px] text-muted-foreground">{format(new Date(tx?.date ?? d.createdAt), 'dd MMM yyyy, HH:mm', { locale: dateLocale })}</p>
                          <p className="text-sm font-bold text-warning">{rp(d.remainingAmount)}</p>
                        </div>
                        <p className="text-xs mt-1">{txItems.map((i) => `${i.quantity} × ${i.productName}`).join(', ') || tx?.receiptNumber}</p>
                        {d.remainingAmount < d.originalAmount && (
                          <p className="text-[10px] text-success mt-0.5">{t('debtsAccount.partiallyPaid', { paid: rp(d.originalAmount - d.remainingAmount), total: rp(d.originalAmount) })}</p>
                        )}
                      </button>
                    );
                  })}
                </div>

                {selected.customer?.creditMovements?.length ? (
                  <div className="space-y-2">
                    <p className="text-sm font-semibold">{t('debtsAccount.creditHistory')}</p>
                    {[...selected.customer.creditMovements].reverse().map((m) => (
                      <div key={m.id} className="flex justify-between gap-3 rounded-lg border p-2.5">
                        <div>
                          <p className="text-xs">{m.note}</p>
                          <p className="text-[10px] text-muted-foreground">{format(new Date(m.date), 'dd MMM yyyy', { locale: dateLocale })}</p>
                        </div>
                        <p className={`text-sm font-bold ${m.amount >= 0 ? 'text-success' : 'text-muted-foreground'}`}>{m.amount >= 0 ? '+' : '−'} {rp(Math.abs(m.amount))}</p>
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="space-y-2">
                  <p className="text-sm font-semibold">{t('debts.detail.paymentHistory')}</p>
                  {selectedPayments.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2 text-center">{t('debts.detail.noInstallments')}</p>
                  ) : selectedPayments.map((p) => (
                    <div key={p.id} className="flex justify-between gap-3 rounded-lg border p-2.5">
                      <div>
                        <p className="text-xs font-semibold">{getPaymentName(p.paymentMethodId)}</p>
                        <p className="text-[10px] text-muted-foreground">{format(new Date(p.date), 'dd MMM yyyy, HH:mm', { locale: dateLocale })}{p.notes ? ` · ${p.notes}` : ''}</p>
                      </div>
                      <p className="text-sm font-bold text-success">{rp(p.amount)}</p>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={paymentOpen} onOpenChange={setPaymentOpen}>
        <DialogContent className="max-w-[95vw] rounded-xl">
          <DialogHeader>
            <DialogTitle>{t('debts.paymentDialog.title')} · {selected?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="rounded-lg bg-warning/10 p-3 flex justify-between items-center">
              <span className="text-sm">{t('debtsAccount.owes')}</span>
              <span className="font-bold text-warning">{rp(selected?.remaining ?? 0)}</span>
            </div>
            <div className="space-y-1.5">
              <Label>{t('debts.paymentDialog.amountLabel')}</Label>
              <Input type="number" inputMode="numeric" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} className="h-11 text-lg font-bold" />
              <p className="text-[11px] text-muted-foreground">{t('debtsAccount.paymentHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t('debts.paymentDialog.methodLabel')}</Label>
              <Select value={paymentMethodId} onValueChange={setPaymentMethodId}>
                <SelectTrigger className="h-11"><SelectValue placeholder={t('debts.paymentDialog.methodPlaceholder')} /></SelectTrigger>
                <SelectContent>
                  {cashMethods.map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('debts.paymentDialog.notesLabel')}</Label>
              <Textarea value={paymentNotes} onChange={(e) => setPaymentNotes(e.target.value)} placeholder={t('debts.paymentDialog.notesPlaceholder')} rows={2} />
            </div>
            <Button className="w-full h-11" onClick={savePayment} disabled={saving || !paymentMethodId || Number(paymentAmount) <= 0}>
              {saving ? t('debts.paymentDialog.saving') : t('debts.paymentDialog.save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={creditOpen} onOpenChange={setCreditOpen}>
        <DialogContent className="max-w-[95vw] sm:max-w-sm rounded-xl">
          <DialogHeader>
            <DialogTitle>{t('debtsAccount.addCredit')} · {selected?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{t('debtsAccount.credit.help')}</p>
            <Input type="number" inputMode="numeric" placeholder={t('debtsAccount.credit.amount')} value={creditAmount} onChange={(e) => setCreditAmount(e.target.value)} className="h-11" />
            <Input placeholder={t('debtsAccount.credit.note')} value={creditNote} onChange={(e) => setCreditNote(e.target.value)} className="h-11" />
            <Button className="w-full h-11" onClick={saveCredit} disabled={saving || Number(creditAmount) <= 0}>{t('debtsAccount.credit.save')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {selected && (
        <CustomerStatement
          open={statementOpen}
          onOpenChange={setStatementOpen}
          storeName={storeSettings?.storeName || 'SD Tech Imports'}
          customerName={selected.name}
          phone={selected.customer?.phone}
          whatsappUser={selected.customer?.whatsappUser}
          lines={statementLines}
          credit={Math.max(0, selected.credit)}
        />
      )}
    </div>
  );
}
