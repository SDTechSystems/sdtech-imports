import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { captureElement } from '@/lib/capture';
import { Download, Loader2, MessageCircle, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { NUMBER_LOCALE } from '@/lib/currency';
import { buildStatementText, rp, shortDate, type StatementLine } from '@/lib/customer-statement';
import { downloadOrShareFile } from '@/lib/file-utils';
import { whatsappNumber, whatsappUserUrl } from '@/lib/customer-account';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storeName: string;
  customerName: string;
  phone?: string;
  whatsappUser?: string;
  lines: StatementLine[];
  credit: number;
}

export default function CustomerStatement({ open, onOpenChange, storeName, customerName, phone, whatsappUser, lines, credit }: Props) {
  const { t } = useTranslation('settings');
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const total = lines.reduce((s, l) => s + l.remaining, 0);
  const today = new Date().toLocaleDateString(NUMBER_LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
  const wa = whatsappNumber(phone);
  const fileName = `estado-cuenta-${customerName.toLowerCase().replace(/[^a-z0-9]+/gi, '-')}.jpg`;

  const text = () =>
    buildStatementText({ storeName, customerName, lines, credit }, {
      title: t('statement.title'),
      greeting: t('statement.greeting', { name: customerName.split(' ')[0] }),
      total: t('statement.total'),
      credit: t('statement.credit'),
      net: t('statement.net'),
      paid: t('statement.paid'),
      missing: t('statement.missing'),
      thanks: t('statement.thanks', { store: storeName }),
    });

  const capture = async (): Promise<Blob | null> => {
    if (!ref.current) return null;
    const canvas = await captureElement(ref.current, { backgroundColor: '#ffffff', scale: 2, logging: false });
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92));
  };

  const shareImage = async () => {
    setBusy(true);
    try {
      const blob = await capture();
      if (!blob) throw new Error('capture');
      const file = new File([blob], fileName, { type: 'image/jpeg' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: t('statement.title'), text: t('statement.shareText', { name: customerName }) });
      } else {
        await downloadImage(blob);
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') toast.error(t('statement.error'));
    } finally {
      setBusy(false);
    }
  };

  const downloadImage = async (existing?: Blob) => {
    const blob = existing ?? (await capture());
    if (!blob) return;
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
    await downloadOrShareFile(dataUrl, { fileName, mimeType: 'image/jpeg' });
    toast.success(t('statement.downloaded'));
  };

  const download = async () => {
    setBusy(true);
    try {
      await downloadImage();
    } catch {
      toast.error(t('statement.error'));
    } finally {
      setBusy(false);
    }
  };

  const sendWhatsApp = async () => {
    const message = text();
    if (!wa && whatsappUser) {
      // Con el @ no está confirmado que WhatsApp ponga el texto en el chat,
      // así que se copia antes para poder pegarlo si llega vacío.
      let copied = false;
      try {
        await navigator.clipboard.writeText(message);
        copied = true;
      } catch {
        // Sin acceso al portapapeles: se abre igual el chat.
      }
      window.open(whatsappUserUrl(whatsappUser, message), '_blank');
      if (copied) toast.success(t('statement.copiedForUser'));
      return;
    }
    const url = `https://wa.me/${wa ?? ''}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-md rounded-xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('statement.title')}</DialogTitle>
        </DialogHeader>

        <div className="rounded-lg border overflow-hidden">
          <div ref={ref} style={{ background: '#ffffff', color: '#111827', padding: 20, fontFamily: 'system-ui, sans-serif', width: '100%' }}>
            <div style={{ background: 'linear-gradient(135deg, #1E1B6E, #6A2FD6)', color: '#fff', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.5 }}>{storeName}</div>
                <div style={{ fontSize: 12, opacity: 0.9 }}>{t('statement.title')} · {today}</div>
              </div>
              <img src="/sdtech-logo-circle.png" alt="SD Tech Imports" width={64} height={64} style={{ width: 64, height: 64, flexShrink: 0 }} />
            </div>
            <div style={{ marginTop: 14, fontSize: 13 }}>
              <span style={{ color: '#6B7280' }}>{t('statement.customer')}: </span>
              <b>{customerName}</b>
            </div>
            <table style={{ width: '100%', marginTop: 10, borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: '#6B7280', textAlign: 'left' }}>
                  <th style={{ padding: '6px 0', borderBottom: '1px solid #E5E7EB' }}>{t('statement.date')}</th>
                  <th style={{ padding: '6px 4px', borderBottom: '1px solid #E5E7EB' }}>{t('statement.products')}</th>
                  <th style={{ padding: '6px 0', borderBottom: '1px solid #E5E7EB', textAlign: 'right' }}>{t('statement.pending')}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} style={{ verticalAlign: 'top' }}>
                    <td style={{ padding: '6px 0', borderBottom: '1px solid #F3F4F6', whiteSpace: 'nowrap' }}>{shortDate(l.date)}</td>
                    <td style={{ padding: '6px 4px', borderBottom: '1px solid #F3F4F6' }}>
                      {l.items.map((it, j) => (
                        <div key={j}>{it.quantity} × {it.name}</div>
                      ))}
                      {l.paid > 0 && <div style={{ color: '#059669', fontSize: 11 }}>{t('statement.paid')} {rp(l.paid)} {t('statement.of')} {rp(l.original)}</div>}
                    </td>
                    <td style={{ padding: '6px 0', borderBottom: '1px solid #F3F4F6', textAlign: 'right', fontWeight: 600 }}>{rp(l.remaining)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 12, fontSize: 14, display: 'flex', justifyContent: 'space-between' }}>
              <b>{t('statement.total')}</b>
              <b style={{ color: '#6A2FD6' }}>{rp(total)}</b>
            </div>
            {credit > 0 && (
              <>
                <div style={{ marginTop: 4, fontSize: 12, display: 'flex', justifyContent: 'space-between', color: '#059669' }}>
                  <span>{t('statement.credit')}</span>
                  <span>− {rp(credit)}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 15, display: 'flex', justifyContent: 'space-between' }}>
                  <b>{t('statement.net')}</b>
                  <b>{rp(Math.max(0, total - credit))}</b>
                </div>
              </>
            )}
            <div style={{ marginTop: 16, fontSize: 11, color: '#6B7280', textAlign: 'center' }}>{t('statement.thanks', { store: storeName })}</div>
          </div>
        </div>

        <div className="space-y-2">
          <Button className="w-full h-11 gap-2" onClick={shareImage} disabled={busy}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
            {t('statement.shareImage')}
          </Button>
          <Button variant="outline" className="w-full h-11 gap-2" onClick={sendWhatsApp} disabled={busy}>
            <MessageCircle className="w-4 h-4" />
            {wa ? t('statement.whatsappTo', { phone }) : whatsappUser ? t('statement.whatsappTo', { phone: `@${whatsappUser}` }) : t('statement.whatsappNoPhone')}
          </Button>
          <Button variant="ghost" className="w-full h-9 gap-2 text-xs" onClick={download} disabled={busy}>
            <Download className="w-4 h-4" /> {t('statement.download')}
          </Button>
          {!wa && !whatsappUser && <p className="text-[11px] text-muted-foreground text-center">{t('statement.addPhoneHint')}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
