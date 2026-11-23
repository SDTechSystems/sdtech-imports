import html2canvas from 'html2canvas';

/**
 * Convierte un elemento en imagen (recibos, comandas, reportes).
 *
 * html2canvas captura una copia de la página. En esa copia la animación de
 * apertura del diálogo (zoom de 95 % a 100 %) vuelve a empezar, y las líneas
 * quedan dibujadas a otra escala que el texto: la línea punteada termina
 * atravesando el renglón de arriba. Por eso en la copia se apagan las
 * animaciones y transiciones antes de capturar.
 */
export function captureElement(element: HTMLElement, options: Parameters<typeof html2canvas>[1] = {}) {
  return html2canvas(element, {
    backgroundColor: '#ffffff',
    scale: 2,
    useCORS: true,
    logging: false,
    ...options,
    onclone: (doc, el) => {
      const style = doc.createElement('style');
      style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
      doc.head.appendChild(style);
      options.onclone?.(doc, el);
    },
  });
}
