import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { differenceInCalendarDays, format } from 'date-fns';
import { PackageCheck, Plane } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { db } from '@/lib/db';
import { formatCurrency } from '@/lib/currency';
import { ORIGIN_FLAG, formatUsd, isInTransit, receiveStockIn } from '@/lib/imports';
import { getDateLocale } from '@/i18n';

interface Props {
  stockInId: number | null;
  onClose: () => void;
}

/** Detalle de una compra y botón para marcarla como recibida (disponible para vender). */
export default function ReceiveImportDialog({ stockInId, onClose }: Props) {
  const { t, i18n } = useTranslation('settings');
  const dateLocale = getDateLocale(i18n.language);
  const [saving, setSaving] = useState(false);

  const si = useLiveQuery(() => (stockInId ? db.stockIns.get(stockInId) : undefined), [stockInId]);
  const product = useLiveQuery(() => (si ? db.products.get(si.productId) : undefined), [si?.productId]);
  const supplier = useLiveQuery(() => (si?.supplierId ? db.suppliers.get(si.supplierId) : undefined), [si?.supplierId]);

  const handleReceive = async () => {
    if (!si?.id) return;
    setSaving(true);
    try {
      const done = await receiveStockIn(si.id);
      if (done) toast.success(t('stockIn.import.receivedToast', { product: product?.name ?? '', qty: si.quantity }));
      onClose();
    } catch {
      toast.error(t('stockIn.import.receiveError'));
    } finally {
      setSaving(false);
    }
  };

  const inTransit = si ? isInTransit(si) : false;
  const days = si ? differenceInCalendarDays(new Date(), new Date(si.date)) : 0;

  return (
    <Dialog open={stockInId !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[95vw] sm:max-w-md rounded-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {inTransit ? <Plane className="w-5 h-5 text-amber-500" /> : <PackageCheck className="w-5 h-5 text-success" />}
            {product?.name ?? '…'}
          </DialogTitle>
        </DialogHeader>
        {si && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <Info label={t('stockIn.import.quantity')} value={`${si.quantity} ${product?.unit ?? ''}`} />
              <Info
                label={t('stockIn.import.originLabel')}
                value={si.origin ? `${ORIGIN_FLAG[si.origin]} ${t(`stockIn.import.origin.${si.origin}`)}` : '-'}
              />
              <Info label={t('stockIn.import.paidOn')} value={format(new Date(si.date), 'dd MMM yyyy', { locale: dateLocale })} />
              <Info
                label={inTransit ? t('stockIn.import.daysInTransit') : t('stockIn.import.receivedOn')}
                value={
                  inTransit
                    ? t('stockIn.import.days', { count: days })
                    : si.receivedAt
                      ? format(new Date(si.receivedAt), 'dd MMM yyyy', { locale: dateLocale })
                      : '-'
                }
              />
              {supplier && <Info label={t('stockIn.import.supplier')} value={supplier.name} />}
              {si.tracking && <Info label={t('stockIn.import.tracking')} value={si.tracking} />}
            </div>
            <div className="rounded-lg bg-muted/50 p-3 space-y-1">
              {si.usdUnitPrice !== undefined && si.exchangeRate && (
                <Row
                  label={t('stockIn.import.usdLine', { usd: formatUsd(si.usdUnitPrice * si.quantity), rate: formatCurrency(si.exchangeRate) })}
                  value={formatCurrency(Math.round(si.usdUnitPrice * si.quantity * si.exchangeRate))}
                />
              )}
              {!!si.shippingCost && <Row label={t('stockIn.import.shipping')} value={formatCurrency(si.shippingCost)} />}
              <Row label={t('stockIn.import.totalCop')} value={formatCurrency(si.totalPrice)} bold />
              <Row label={t('stockIn.import.unitCost')} value={formatCurrency(si.buyPrice)} />
            </div>
            {si.notes && <p className="text-xs text-muted-foreground italic">{si.notes}</p>}
            {inTransit ? (
              <>
                <p className="text-xs text-muted-foreground">{t('stockIn.import.receiveHint')}</p>
                <Button className="w-full h-12 gap-2 text-base font-semibold" onClick={handleReceive} disabled={saving}>
                  <PackageCheck className="w-5 h-5" /> {t('stockIn.import.markReceived')}
                </Button>
              </>
            ) : (
              <p className="text-xs text-success font-medium">{t('stockIn.import.alreadyReceived')}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border p-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-sm font-medium break-words">{value}</p>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between gap-2 ${bold ? 'font-bold' : ''}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
