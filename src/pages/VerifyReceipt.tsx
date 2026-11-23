import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { BadgeCheck, CircleAlert, CircleX, Loader2 } from 'lucide-react';
import { db } from '@/lib/db';
import { formatCurrency } from '@/lib/currency';
import {
  isValidVerifyCode,
  toPublicReceipt,
  verifyReceiptOnline,
  type PublicReceipt,
  type VerifyResult,
} from '@/lib/receipt-verify';

/**
 * Página pública que abre el QR del recibo. No requiere iniciar sesión.
 * Pregunta al servidor; si no hay conexión, busca en los datos de este equipo.
 */
export default function VerifyReceipt() {
  const { code = '' } = useParams();
  const normalized = code.trim().toUpperCase();
  const [result, setResult] = useState<VerifyResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isValidVerifyCode(normalized)) {
        setResult({ status: 'not_found' });
        return;
      }
      let res = await verifyReceiptOnline(normalized);
      if (res.status === 'error' || res.status === 'not_found') {
        const local = await findLocal(normalized);
        if (local) res = { status: 'valid', receipt: local };
      }
      if (!cancelled) setResult(res);
    })();
    return () => { cancelled = true; };
  }, [normalized]);

  return (
    <div className="min-h-screen bg-muted/40 flex items-start justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-4">
        <img src="/sdtech-logo.png" alt="SD Tech Imports" className="w-48 mx-auto" />
        <div className="rounded-2xl bg-card shadow-sm border border-border p-5">
          {!result && (
            <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin" />
              <p className="text-sm">Verificando recibo…</p>
            </div>
          )}
          {result?.status === 'valid' && <ReceiptView receipt={result.receipt} />}
          {result?.status === 'void' && <ReceiptView receipt={result.receipt} voided />}
          {result?.status === 'not_found' && (
            <Status
              icon={<CircleX className="w-12 h-12 text-destructive" />}
              title="Recibo no encontrado"
              text="Este código no corresponde a ningún recibo emitido por SD Tech Imports. Si crees que es un error, escríbenos."
            />
          )}
          {result?.status === 'error' && (
            <Status
              icon={<CircleAlert className="w-12 h-12 text-amber-500" />}
              title="No se pudo verificar"
              text="Revisa tu conexión a internet e inténtalo de nuevo."
            />
          )}
        </div>
        <p className="text-center text-[11px] text-muted-foreground">Código: {normalized}</p>
      </div>
    </div>
  );
}

async function findLocal(code: string): Promise<PublicReceipt | null> {
  try {
    const tx = await db.transactions.where('verifyCode').equals(code).first();
    if (!tx || tx.status !== 'completed') return null;
    const items = await db.transactionItems.where('transactionId').equals(tx.id!).toArray();
    const settings = await db.storeSettings.toCollection().first();
    return toPublicReceipt(tx, items, settings?.storeName || 'SD Tech Imports');
  } catch {
    return null;
  }
}

function Status({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center text-center gap-2 py-6">
      {icon}
      <h1 className="text-lg font-bold">{title}</h1>
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function ReceiptView({ receipt, voided }: { receipt: PublicReceipt; voided?: boolean }) {
  const date = new Date(receipt.date);
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center text-center gap-1">
        {voided ? <CircleX className="w-12 h-12 text-destructive" /> : <BadgeCheck className="w-12 h-12 text-success" />}
        <h1 className="text-lg font-bold">{voided ? 'Recibo anulado' : 'Recibo auténtico'}</h1>
        <p className="text-xs text-muted-foreground">
          {voided ? 'Este recibo existió pero fue anulado por la tienda.' : `Emitido por ${receipt.store}`}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-lg bg-muted/60 p-2">
          <p className="text-[10px] text-muted-foreground">Recibo</p>
          <p className="font-medium break-all">{receipt.receiptNumber}</p>
        </div>
        <div className="rounded-lg bg-muted/60 p-2">
          <p className="text-[10px] text-muted-foreground">Fecha</p>
          <p className="font-medium">{isNaN(date.getTime()) ? '-' : format(date, "d MMM yyyy, HH:mm", { locale: es })}</p>
        </div>
      </div>
      <div className="space-y-1 text-sm">
        {receipt.items.map((it, i) => (
          <div key={i} className="flex justify-between gap-3">
            <span className="min-w-0">{it.quantity} × {it.name}</span>
            <span className="shrink-0">{formatCurrency(it.subtotal)}</span>
          </div>
        ))}
        {!!receipt.shippingFee && (
          <div className="flex justify-between gap-3 text-muted-foreground">
            <span>Envío</span>
            <span>{formatCurrency(receipt.shippingFee)}</span>
          </div>
        )}
        <div className="flex justify-between gap-3 font-bold border-t border-border pt-2 mt-2">
          <span>Total</span>
          <span>{formatCurrency(receipt.total)}</span>
        </div>
      </div>
    </div>
  );
}
