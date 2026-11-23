import { PackageCheck, Plane, QrCode, type LucideIcon } from 'lucide-react';
import { db } from './db';

/**
 * Static catalog of "What's New" announcements.
 * All texts (titles, descriptions, and CTA labels) are localized in translation files
 * under the `whatsNewFeatures.[id]` key path.
 *
 * IMPORTANT:
 *  - Each `id` MUST be unique and MUST NEVER change once shipped.
 *  - Order this array newest-first so the modal slideshow starts with the most recent entry.
 */

export interface WhatsNewFeature {
  id: string;
  icon: LucideIcon;
  /** Tailwind class pair, e.g. "text-warning bg-warning/10" */
  iconColor: string;
  publishedAt: string; // ISO date (YYYY-MM-DD), display only
  cta?: {
    to: string; // internal route
  };
}

export const FEATURES: WhatsNewFeature[] = [
  {
    id: '2026-11-preorder',
    icon: PackageCheck,
    iconColor: 'text-primary bg-primary/10',
    publishedAt: '2026-11-23',
    cta: { to: '/products' },
  },
  {
    id: '2026-11-receipt-qr',
    icon: QrCode,
    iconColor: 'text-primary bg-primary/10',
    publishedAt: '2026-11-23',
    cta: { to: '/settings/receipt' },
  },
  {
    id: '2026-11-imports',
    icon: Plane,
    iconColor: 'text-warning bg-warning/10',
    publishedAt: '2026-11-23',
    cta: { to: '/stock-in' },
  },
];

/** All feature ids currently shipped — useful for "mark all seen" flows. */
export const ALL_FEATURE_IDS: string[] = FEATURES.map((f) => f.id);

/** Returns the FEATURES the user has not dismissed yet, ordered newest-first. */
export function getUnseenFeatures(seenIds: string[] | undefined): WhatsNewFeature[] {
  const seen = new Set(seenIds ?? []);
  return FEATURES.filter((f) => !seen.has(f.id));
}

/** Persist all current ids as seen. Idempotent. */
export async function markAllFeaturesSeen(): Promise<void> {
  const settings = await db.storeSettings.toCollection().first();
  if (!settings?.id) return;
  const seen = new Set(settings.seenWhatsNewIds ?? []);
  for (const id of ALL_FEATURE_IDS) seen.add(id);
  await db.storeSettings.update(settings.id, { seenWhatsNewIds: Array.from(seen) });
}

/** Persist specific ids as seen. Used after the modal is dismissed. */
export async function markFeaturesSeen(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const settings = await db.storeSettings.toCollection().first();
  if (!settings?.id) return;
  const seen = new Set(settings.seenWhatsNewIds ?? []);
  for (const id of ids) seen.add(id);
  await db.storeSettings.update(settings.id, { seenWhatsNewIds: Array.from(seen) });
}
