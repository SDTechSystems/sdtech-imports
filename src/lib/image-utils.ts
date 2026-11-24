/**
 * Prepare a product photo picked by the user for storage.
 *
 * The app shows photos as squares (48 px thumbnails and ~160 px cards) on
 * phones with 2–3x screens, so a photo needs about 500 px per side to look
 * sharp. The photo is cropped to a centered square, scaled to `size` px and
 * saved as WebP (JPEG where the browser cannot encode WebP), about 30–60 KB.
 * This matches the 512 px catalog photos in public/product-photos/.
 */
export function compressImage(
  file: File,
  size = 512,
  quality = 0.85
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        try {
          resolve(renderSquare(img, size, quality));
        } catch (err) {
          reject(err instanceof Error ? err : new Error('Failed to process image'));
        }
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function renderSquare(img: HTMLImageElement, size: number, quality: number): string {
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const side = Math.min(srcW, srcH);
  const sx = Math.round((srcW - side) / 2);
  const sy = Math.round((srcH - side) / 2);
  const target = Math.min(size, side);

  // Crop to the centered square first.
  let canvas = makeCanvas(side);
  let ctx = getContext(canvas);
  ctx.drawImage(img, sx, sy, side, side, 0, 0, side, side);

  // Halve the size step by step: one big jump from a phone photo (3000+ px)
  // straight to 512 px drops pixels and looks soft or jagged.
  let current = side;
  while (current / 2 >= target) {
    const half = Math.round(current / 2);
    const next = makeCanvas(half);
    const nextCtx = getContext(next);
    nextCtx.drawImage(canvas, 0, 0, current, current, 0, 0, half, half);
    canvas = next;
    ctx = nextCtx;
    current = half;
  }
  if (current !== target) {
    const last = makeCanvas(target);
    const lastCtx = getContext(last);
    lastCtx.drawImage(canvas, 0, 0, current, current, 0, 0, target, target);
    canvas = last;
  }

  const webp = canvas.toDataURL('image/webp', quality);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', quality);
}

function makeCanvas(side: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  return canvas;
}

function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context not available');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}
