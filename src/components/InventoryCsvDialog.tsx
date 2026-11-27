import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  AlertTriangle, ArrowRight, CheckCircle2, ClipboardList, Download, FileSpreadsheet, Loader2, Package, PackagePlus,
  Upload, XCircle,
} from 'lucide-react';
import { db } from '@/lib/db';
import { useAuth } from '@/hooks/use-auth';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import SearchableSelect from '@/components/SearchableSelect';
import { cn } from '@/lib/utils';
import { downloadOrShareFile } from '@/lib/file-utils';
import { formatNumber } from '@/lib/currency';
import {
  applyInventoryRows,
  buildInventoryCsv,
  parseInventoryTable,
  readTableFile,
  type InventoryMode,
  type InventoryParseResult,
} from '@/lib/inventory-csv';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Modo con el que abre (la página de entradas abre en "entrada"). */
  defaultMode?: InventoryMode;
}

/**
 * Exporta el inventario a CSV y carga un CSV/Excel para sumar una entrada
 * de mercancía o corregir el conteo.
 */
export default function InventoryCsvDialog({ open, onOpenChange, defaultMode = 'entry' }: Props) {
  const { t } = useTranslation('products');
  const { currentUser, can } = useAuth();
  const canImport = can('manage_stock_inout');
  const [mode, setMode] = useState<InventoryMode>(defaultMode);
  const [supplierId, setSupplierId] = useState('0');
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<InventoryParseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const suppliers = useLiveQuery(() => db.suppliers.where('isDeleted').equals(0).toArray(), []);

  const reset = () => {
    setResult(null);
    setFileName('');
    if (inputRef.current) inputRef.current.value = '';
  };

  const close = (next: boolean) => {
    if (!next) {
      reset();
      setMode(defaultMode);
      setSupplierId('0');
    }
    onOpenChange(next);
  };

  const download = async (kind: 'stock' | 'entryForm') => {
    try {
      const [products, categories] = await Promise.all([db.products.toArray(), db.categories.toArray()]);
      const csv = buildInventoryCsv({ products, categories, t: (k) => t(k), kind });
      const date = format(new Date(), 'yyyy-MM-dd');
      await downloadOrShareFile(new TextEncoder().encode(csv).buffer as ArrayBuffer, {
        fileName: kind === 'stock' ? t('inventoryCsv.stockFileName', { date }) : t('inventoryCsv.entryFileName', { date }),
        mimeType: 'text/csv',
      });
      toast.success(t('inventoryCsv.downloaded'));
    } catch (err) {
      console.error(err);
      toast.error(t('inventoryCsv.downloadFailed'));
    }
  };

  const parseFile = async (file: File, m: InventoryMode) => {
    setBusy(true);
    try {
      const table = await readTableFile(file);
      const products = await db.products.toArray();
      setResult(parseInventoryTable(table, m, { products, t: (k, o) => t(k, o) as string }));
    } catch (err) {
      console.error(err);
      toast.error(t('inventoryCsv.readFailed'));
      reset();
    } finally {
      setBusy(false);
    }
  };

  const lastFile = useRef<File | null>(null);
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    lastFile.current = file;
    setFileName(file.name);
    await parseFile(file, mode);
  };

  const changeMode = (m: InventoryMode) => {
    setMode(m);
    // Si ya hay un archivo, se vuelve a leer con el otro modo.
    if (lastFile.current && result) void parseFile(lastFile.current, m);
  };

  const rows = result?.rows ?? [];
  const valid = rows.filter((r) => r.isValid);
  const invalid = rows.filter((r) => r.errors.length > 0);
  const unchanged = rows.filter((r) => r.unchanged);
  // Errores primero, luego los que cambian; los que no cambian se omiten de la lista.
  const visible = [...invalid, ...valid];

  const apply = async () => {
    if (valid.length === 0) return;
    setSaving(true);
    try {
      const note = t(mode === 'entry' ? 'inventoryCsv.entryNote' : 'inventoryCsv.countNote', { file: fileName });
      const changed = await applyInventoryRows({
        rows,
        mode,
        supplierId: Number(supplierId) || 0,
        userId: currentUser?.id,
        note,
      });
      toast.success(t(mode === 'entry' ? 'inventoryCsv.entrySaved' : 'inventoryCsv.countSaved', { count: changed }));
      close(false);
    } catch (err) {
      console.error(err);
      toast.error(t('inventoryCsv.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const qty = (n: number) => formatNumber(n);

  const modes: { id: InventoryMode; icon: typeof PackagePlus; title: string; desc: string }[] = [
    { id: 'entry', icon: PackagePlus, title: t('inventoryCsv.modeEntry'), desc: t('inventoryCsv.modeEntryDesc') },
    { id: 'count', icon: ClipboardList, title: t('inventoryCsv.modeCount'), desc: t('inventoryCsv.modeCountDesc') },
  ];

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-[95vw] sm:max-w-2xl rounded-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-primary" />
            {t('inventoryCsv.title')}
          </DialogTitle>
          <DialogDescription>{t('inventoryCsv.subtitle')}</DialogDescription>
        </DialogHeader>

        {!result && !busy && (
          <div className="space-y-4">
            {/* Exportar */}
            <div className="rounded-xl border border-border p-3 space-y-2">
              <p className="text-sm font-semibold">{t('inventoryCsv.exportTitle')}</p>
              <p className="text-xs text-muted-foreground">{t('inventoryCsv.exportDesc')}</p>
              <Button variant="outline" className="w-full gap-1.5" onClick={() => download('stock')}>
                <Download className="w-4 h-4" /> {t('inventoryCsv.exportButton')}
              </Button>
            </div>

            {canImport && (
              <div className="rounded-xl border border-border p-3 space-y-3">
                <p className="text-sm font-semibold">{t('inventoryCsv.importTitle')}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {modes.map(({ id, icon: Icon, title, desc }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => changeMode(id)}
                      className={cn(
                        'text-left rounded-lg border-2 p-3 transition-colors',
                        mode === id ? 'border-primary bg-primary/5' : 'border-muted hover:border-primary/40',
                      )}
                    >
                      <span className={cn('flex items-center gap-1.5 text-sm font-semibold', mode === id && 'text-primary')}>
                        <Icon className="w-4 h-4" /> {title}
                      </span>
                      <span className="block text-[11px] text-muted-foreground mt-1 leading-snug">{desc}</span>
                    </button>
                  ))}
                </div>

                <div className="rounded-lg bg-muted/50 p-3 space-y-2">
                  <p className="text-xs font-medium">{t('inventoryCsv.step1')}</p>
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    {t(mode === 'entry' ? 'inventoryCsv.formEntryDesc' : 'inventoryCsv.formCountDesc')}
                  </p>
                  <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => download(mode === 'entry' ? 'entryForm' : 'stock')}>
                    <Download className="w-3.5 h-3.5" />
                    {t(mode === 'entry' ? 'inventoryCsv.formEntryButton' : 'inventoryCsv.formCountButton')}
                  </Button>
                  <p className="text-[11px] text-muted-foreground leading-snug">{t('inventoryCsv.locationHint')}</p>
                </div>

                {mode === 'entry' && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t('inventoryCsv.supplierLabel')}</Label>
                    <SearchableSelect
                      value={supplierId}
                      onChange={setSupplierId}
                      placeholder={t('inventoryCsv.noSupplier')}
                      searchPlaceholder={t('inventoryCsv.supplierSearch')}
                      options={[
                        { value: '0', label: t('inventoryCsv.noSupplier') },
                        ...(suppliers ?? []).map((s) => ({ value: String(s.id), label: s.name })),
                      ]}
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <p className="text-xs font-medium">{t('inventoryCsv.step2')}</p>
                  <Button className="w-full gap-1.5" onClick={() => inputRef.current?.click()}>
                    <Upload className="w-4 h-4" /> {t('inventoryCsv.chooseFile')}
                  </Button>
                  <input ref={inputRef} type="file" accept=".csv,.txt,.xlsx,text/csv" className="hidden" onChange={onFile} />
                </div>
              </div>
            )}
          </div>
        )}

        {busy && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t('inventoryCsv.reading')}</p>
          </div>
        )}

        {result && !busy && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium truncate">{fileName}</span>
              <span className="shrink-0 rounded-full bg-primary/10 text-primary px-2 py-0.5 font-semibold">
                {t(mode === 'entry' ? 'inventoryCsv.modeEntry' : 'inventoryCsv.modeCount')}
              </span>
            </div>

            {result.missingColumns.length > 0 ? (
              <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-destructive">
                <XCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <p className="text-xs">{t('inventoryCsv.missingColumns', { columns: result.missingColumns.join(', ') })}</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-success/10 p-2">
                    <p className="text-lg font-bold text-success">{valid.length}</p>
                    <p className="text-[10px] text-muted-foreground">{t('inventoryCsv.ready')}</p>
                  </div>
                  <div className="rounded-lg bg-muted/60 p-2">
                    <p className="text-lg font-bold">{unchanged.length}</p>
                    <p className="text-[10px] text-muted-foreground">{t('inventoryCsv.unchanged')}</p>
                  </div>
                  <div className="rounded-lg bg-destructive/10 p-2">
                    <p className="text-lg font-bold text-destructive">{invalid.length}</p>
                    <p className="text-[10px] text-muted-foreground">{t('inventoryCsv.withErrors')}</p>
                  </div>
                </div>

                {mode === 'entry' && result.looksLikeStockFile && (
                  <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-warning">
                    <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                    <p className="text-xs">{t('inventoryCsv.stockFileWarning')}</p>
                  </div>
                )}
                {result.truncated && (
                  <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-warning">
                    <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                    <p className="text-xs">{t('inventoryCsv.truncated')}</p>
                  </div>
                )}

                {visible.length === 0 ? (
                  <p className="text-center text-sm text-muted-foreground py-6">{t('inventoryCsv.nothingToApply')}</p>
                ) : (
                  <div className="max-h-[45vh] overflow-y-auto space-y-1.5 pr-1">
                    {visible.map((r) => (
                      <div
                        key={r.rowNums.join('-') + r.label}
                        className={cn('rounded-lg border p-2.5', r.errors.length ? 'border-destructive/30 bg-destructive/5' : 'border-border')}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold truncate">{r.productName}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {r.sku && <span className="font-mono">{r.sku} · </span>}
                              {t('inventoryCsv.rows', { rows: r.rowNums.join(', ') })}
                            </p>
                          </div>
                          {r.isValid && mode === 'entry' && (
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {t('inventoryCsv.costEach', { cost: formatNumber(r.cost) })}
                            </span>
                          )}
                        </div>
                        {r.errors.length > 0 ? (
                          <div className="mt-1 space-y-0.5">
                            {r.errors.map((e, i) => (
                              <p key={i} className="flex items-start gap-1 text-[11px] text-destructive leading-tight">
                                <XCircle className="w-3 h-3 shrink-0 mt-0.5" /> {e}
                              </p>
                            ))}
                          </div>
                        ) : (
                          <div className={cn('mt-1.5 flex items-center gap-1 rounded-md px-2 py-1 text-xs', r.newStock !== r.currentStock ? 'bg-primary/5' : 'bg-muted/40 text-muted-foreground')}>
                            <Package className="w-3 h-3 shrink-0" />
                            <span className="text-[10px]">{t('inventoryCsv.stockLabel')}</span>
                            <span className="ml-auto font-mono">{qty(r.currentStock)}</span>
                            <ArrowRight className="w-3 h-3 shrink-0" />
                            <span className={cn('font-mono font-semibold', r.newStock > r.currentStock && 'text-success', r.newStock < r.currentStock && 'text-destructive')}>
                              {qty(r.newStock)} {r.unit}
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            <div className="flex flex-col sm:flex-row justify-end gap-2 pt-1">
              <Button variant="outline" className="w-full sm:w-auto gap-1.5" onClick={reset}>
                <Upload className="w-4 h-4" /> {t('inventoryCsv.otherFile')}
              </Button>
              <Button className="w-full sm:w-auto gap-1.5" disabled={valid.length === 0 || saving} onClick={apply}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                {t(mode === 'entry' ? 'inventoryCsv.applyEntry' : 'inventoryCsv.applyCount', { count: valid.length })}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
