import html2canvas from 'html2canvas';

/**
 * Copia en `doc` los estilos que esta página ya tiene cargados, en lugar de
 * dejar que la copia los vuelva a pedir al servidor. Después de publicar una
 * versión nueva, el archivo de estilos de la versión anterior ya no existe y
 * la imagen salía sin diseño. Las hojas de otros dominios (fuentes) se dejan
 * como enlace porque el navegador no deja leerlas.
 */
function inlineLoadedStyles(doc: Document) {
  const inlined = new Set<string>();
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    css += Array.from(rules, (r) => r.cssText).join('\n') + '\n';
    if (sheet.href) inlined.add(sheet.href);
  }
  doc.querySelectorAll('style').forEach((n) => n.remove());
  doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach((link) => {
    if (inlined.has(link.href)) link.remove();
  });
  const style = doc.createElement('style');
  style.textContent = css;
  doc.head.appendChild(style);
}

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
      inlineLoadedStyles(doc);
      const style = doc.createElement('style');
      style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
      doc.head.appendChild(style);
      options.onclone?.(doc, el);
    },
  });
}
