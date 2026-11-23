import { db } from '@/lib/db';
import { buildBackupData, restoreFromBackupData } from '@/lib/backup';

/**
 * Copia automática en la nube (Cloudflare Worker en /api, ver worker/index.ts).
 *
 * La clave y el estado se guardan en localStorage, fuera de la base de datos,
 * para que la clave no viaje dentro de las copias y para que guardar el estado
 * no cambie los datos (y no provoque otra subida).
 */

const STORAGE_KEY = 'sdtech.cloudBackup';
const AUTO_INTERVAL_MS = 3 * 60 * 1000;

export interface CloudBackupMeta {
  savedAt: string;
  size: number;
  device?: string;
  transactions?: number;
  products?: number;
}

export interface CloudBackupItem {
  key: string;
  meta: CloudBackupMeta | null;
}

interface CloudState {
  key: string;
  enabled: boolean;
  lastHash?: string;
  lastUploadAt?: string;
  lastError?: string;
}

type Listener = (state: CloudBackupStatus) => void;

export interface CloudBackupStatus {
  connected: boolean;
  enabled: boolean;
  uploading: boolean;
  lastUploadAt?: string;
  lastError?: string;
}

export class CloudBackupError extends Error {
  constructor(public code: string, message?: string) {
    super(message || code);
  }
}

let uploading = false;
const listeners = new Set<Listener>();

function readState(): CloudState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CloudState) : null;
  } catch {
    return null;
  }
}

function writeState(state: CloudState | null) {
  try {
    if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Almacenamiento no disponible: la copia en la nube sigue funcionando en esta sesión.
  }
  notify();
}

export function getCloudStatus(): CloudBackupStatus {
  const s = readState();
  return {
    connected: Boolean(s?.key),
    enabled: Boolean(s?.key && s.enabled),
    uploading,
    lastUploadAt: s?.lastUploadAt,
    lastError: s?.lastError,
  };
}

/** Clave de la nube guardada en este dispositivo (o null si no está conectado). */
export function getCloudKey(): string | null {
  return readState()?.key || null;
}

function notify() {
  const status = getCloudStatus();
  listeners.forEach((l) => l(status));
}

export function subscribeCloudStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function api(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${key}` },
      cache: 'no-store',
    });
  } catch {
    throw new CloudBackupError('offline');
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) code = body.error;
    } catch {
      // respuesta sin JSON
    }
    throw new CloudBackupError(code);
  }
  return res;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Valida la clave contra el servidor (la registra si es la primera vez). */
export async function connectCloud(key: string): Promise<{ latest: CloudBackupMeta | null }> {
  const trimmed = key.trim();
  if (trimmed.length < 8) throw new CloudBackupError('short_key');
  const res = await api('/api/connect', trimmed, { method: 'POST' });
  const body = await res.json();
  return { latest: body.latest ?? null };
}

/** Guarda la clave en este dispositivo. `enabled` activa la subida automática. */
export function saveCloudKey(key: string, enabled: boolean) {
  const prev = readState();
  writeState({ ...prev, key: key.trim(), enabled, lastError: undefined });
}

export function setCloudEnabled(enabled: boolean) {
  const s = readState();
  if (!s) return;
  writeState({ ...s, enabled });
}

export function disconnectCloud() {
  writeState(null);
}

/** Número de ventas guardadas en este dispositivo. */
export async function localTransactionCount(): Promise<number> {
  return db.transactions.count();
}

/**
 * Sube la base de datos si cambió desde la última subida.
 * Devuelve true si subió algo.
 */
export async function uploadCloudBackup(force = false): Promise<boolean> {
  const s = readState();
  if (!s?.key) throw new CloudBackupError('not_connected');
  if (uploading) return false;
  uploading = true;
  notify();
  try {
    const data = await buildBackupData();
    const { exportedAt: _ignored, ...content } = data;
    const hash = await sha256(JSON.stringify(content));
    if (!force && hash === s.lastHash) return false;

    await api('/api/backup', s.key, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-device-name': deviceName() },
      body: JSON.stringify(data),
    });
    const current = readState();
    if (current?.key === s.key) {
      writeState({ ...current, lastHash: hash, lastUploadAt: new Date().toISOString(), lastError: undefined });
    }
    return true;
  } catch (err) {
    const current = readState();
    if (current) writeState({ ...current, lastError: err instanceof CloudBackupError ? err.code : 'unknown' });
    throw err;
  } finally {
    uploading = false;
    notify();
  }
}

export async function listCloudBackups(): Promise<CloudBackupItem[]> {
  const s = readState();
  if (!s?.key) throw new CloudBackupError('not_connected');
  const res = await api('/api/backups', s.key);
  const body = await res.json();
  return (body.items || []) as CloudBackupItem[];
}

/**
 * Reemplaza los datos de este dispositivo con una copia de la nube.
 * Después activa la subida automática, porque el dispositivo ya tiene los datos.
 */
export async function restoreCloudBackup(backupKey = 'latest'): Promise<void> {
  const s = readState();
  if (!s?.key) throw new CloudBackupError('not_connected');
  const res = await api(`/api/backup?key=${encodeURIComponent(backupKey)}`, s.key);
  const data = await res.json();
  await restoreFromBackupData(data);
  const restored = await buildBackupData();
  const { exportedAt: _ignored, ...content } = restored;
  const current = readState();
  if (current) writeState({ ...current, enabled: true, lastHash: await sha256(JSON.stringify(content)) });
}

function deviceName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad/i.test(ua)) return 'iPhone';
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac os/i.test(ua)) return 'Mac';
  return 'Navegador';
}

let started = false;

/** Sube cambios cada pocos minutos, al volver la conexión y al salir de la app. */
export function startCloudAutoBackup() {
  if (started || typeof window === 'undefined') return;
  started = true;

  const tick = () => {
    const s = readState();
    if (!s?.key || !s.enabled || !navigator.onLine) return;
    uploadCloudBackup().catch(() => {
      // El error queda en el estado y se muestra en Ajustes.
    });
  };

  setInterval(tick, AUTO_INTERVAL_MS);
  window.addEventListener('online', tick);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') tick();
  });
  setTimeout(tick, 15_000);
}
