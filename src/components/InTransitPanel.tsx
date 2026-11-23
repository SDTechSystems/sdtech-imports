import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { differenceInCalendarDays } from 'date-fns';
import { ChevronRight, Plane, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import ReceiveImportDialog from '@/components/ReceiveImportDialog';
import { db } from '@/lib/db';
import { formatCurrency } from '@/lib/currency';
import { ORIGIN_FLAG } from '@/lib/imports';

/** Tablero de compras en camino: se abren para marcarlas como recibidas. */
export default function InTransitPanel() {
  const { t } = useTranslation('dashboard');
  const [openId, setOpenId] = useState<number | null>(null);

  const rows = useLiveQuery(async () => {
    const list = await db.stockIns.where('status').equals('in_transit').toArray();
    list.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const products = await db.products.bulkGet(list.map((s) => s.productId));
    return list.map((s, i) => ({ ...s, productName: products[i]?.name ?? '-' }));
  }, []);

  if (!rows) return null;
  const total = rows.reduce((s, r) => s + r.totalPrice, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold flex items-center gap-2">
          <Plane className="w-4 h-4 text-amber-500" /> {t('inTransit.title')}
        </h2>
        <Link to="/stock-in?estado=transito" className="text-xs text-primary font-medium flex items-center gap-0.5">
          {t('inTransit.viewAll')} <ChevronRight className="w-3 h-3" />
        </Link>
      </div>
      {rows.length === 0 ? (
        <Card className="border-dashed shadow-none">
          <CardContent className="p-4 flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{t('inTransit.empty')}</p>
            <Link to="/stock-in">
              <Button size="sm" variant="outline" className="gap-1 shrink-0"><Plus className="w-4 h-4" /> {t('inTransit.add')}</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-xs text-muted-foreground mb-2">
            {t('inTransit.summary', { count: rows.length, amount: formatCurrency(total) })}
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {rows.map((r) => {
              const days = differenceInCalendarDays(new Date(), new Date(r.date));
              return (
                <Card
                  key={r.id}
                  className="border-0 shadow-sm bg-amber-500/10 hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => setOpenId(r.id!)}
                >
                  <CardContent className="p-3 flex items-center gap-3">
                    <div className="text-2xl leading-none">{r.origin ? ORIGIN_FLAG[r.origin] : '📦'}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{r.productName}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('inTransit.line', { qty: r.quantity, days: t('inTransit.days', { count: days }) })}
                        {r.tracking ? ` · ${r.tracking}` : ''}
                      </p>
                    </div>
                    <Button size="sm" className="h-8 text-xs shrink-0" onClick={(e) => { e.stopPropagation(); setOpenId(r.id!); }}>
                      {t('inTransit.open')}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}
      <ReceiveImportDialog stockInId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
