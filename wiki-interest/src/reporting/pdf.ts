import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { AppError } from '../errors.js';
import { browserPath } from './resources.js';

export async function printPdf(html: string): Promise<{ pdf: Buffer; layout: { height: number; limit: number; width: number }; browserVersion: string }> {
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserPath;
  const { chromium } = await import('playwright');
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) { throw new AppError('BROWSER_UNAVAILABLE', 'Chromium недоступний. Виконайте npm run setup:browser; перевірте системні залежності та дозвіл запуску браузера.', { cause: String(error) }); }
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', offline: true, viewport: { width: 794, height: 1123 } });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.emulateMedia({ media: 'print' });
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
    await page.evaluate(async () => {
      await document.fonts.load('12px "Noto Sans"', 'ІЇЄҐ Český Łódź English Русский');
      await document.fonts.load('600 12px "Noto Sans"', 'ІЇЄҐ Český Łódź English Русский');
      await document.fonts.ready;
    });
    const layout = await page.evaluate(() => {
      const pages = [...document.querySelectorAll('.report-page')];
      const containers = pages.length ? pages : [document.querySelector('main')!], limit = 277 * 96 / 25.4 * (pages.length ? 1 : 3);
      const boxes = containers.map(main => {
        const box = main.getBoundingClientRect();
        const outside = [...main.querySelectorAll('p, table, h1, h2, figure, footer')].some(element => { const bounds = element.getBoundingClientRect(); return bounds.right > box.right + 1 || bounds.left < box.left - 1; });
        return { height: box.height, width: box.width, overflow: box.height > limit - 2 || main.scrollWidth > box.width + 1 || outside };
      });
      return { height: Math.max(...boxes.map(b => b.height)), limit, width: Math.max(...boxes.map(b => b.width)), overflow: containers.length > 3 || boxes.some(b => b.overflow), fonts: document.fonts.check('12px "Noto Sans"', 'ІЇЄҐ Český Łódź English Русский') };
    });
    if (!layout.fonts) throw new AppError('FONT_UNAVAILABLE', 'Локальний шрифт не завантажився.');
    if (layout.overflow) throw new AppError('REPORT_OVERFLOW', 'Вміст переповнює сторінку A4 або перевищує 3 сторінки. HTML збережено; вміст не обрізано.', { height: layout.height, limit: layout.limit, width: layout.width });
    const pdf = await page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true, scale: 1, tagged: true });
    return { pdf, layout, browserVersion: browser.version() };
  } finally { await browser.close(); }
}

export async function verifyPdf(pdf: Uint8Array, requiredText: string[], expectedNumbers: string[], requiredUrls: string[] = []): Promise<{ pages: number; widthPoints: number; heightPoints: number; text: string; preview: Buffer; previews: Buffer[]; links: string[] }> {
  const loading = getDocument({ data: new Uint8Array(pdf), useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, verbosity: 0 });
  const document = await loading.promise.catch(async (error: unknown) => {
    await loading.destroy();
    throw new AppError('PDF_INVALID', 'Файл не відкривається як PDF.', { cause: String(error) });
  });
  try {
    if (document.numPages < 1 || document.numPages > 3) throw new AppError('PDF_PAGE_COUNT', 'PDF повинен мати від 1 до 3 сторінок.', { pages: document.numPages });
    let text = '', widthPoints = 0, heightPoints = 0;
    const previews: Buffer[] = [];
    const links = new Set<string>();
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber), viewport = page.getViewport({ scale: 1 });
      for (const annotation of await page.getAnnotations()) if (annotation.subtype === 'Link' && annotation.url) links.add(new URL(annotation.url).href);
      widthPoints = viewport.width; heightPoints = viewport.height;
      if (Math.abs(viewport.width - 595.276) > 1 || Math.abs(viewport.height - 841.89) > 1) throw new AppError('PDF_NOT_A4', 'Розмір сторінки PDF не відповідає A4.', { pageNumber });
      const content = await page.getTextContent();
      const pageText = content.items.flatMap(item => 'str' in item ? [item.str + (item.hasEOL ? '\n' : '')] : []).join('');
      if (!pageText.trim()) throw new AppError('PDF_EMPTY_PAGE', 'PDF містить порожню сторінку.', { pageNumber });
      for (const item of content.items) if ('str' in item && item.str.trim() && (item.transform[4] < -1 || item.transform[4] + item.width > viewport.width + 1 || item.transform[5] < -1 || item.transform[5] > viewport.height + 1)) throw new AppError('REPORT_OVERFLOW', 'Текст PDF виходить за межі сторінки.', { pageNumber });
      text += `${pageText}\n`;
      const renderViewport = page.getViewport({ scale: 1.5 }), canvas = createCanvas(Math.ceil(renderViewport.width), Math.ceil(renderViewport.height));
      await page.render({ canvas: null, canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport: renderViewport }).promise;
      previews.push(await canvas.encode('png'));
    }
    const normalized = text.replace(/\s+/g, ' ').normalize('NFC');
    for (const required of [...requiredText, ...expectedNumbers]) if (!normalized.includes(required.replace(/\s+/g, ' ').normalize('NFC'))) throw new AppError('PDF_CONTENT_MISMATCH', 'У PDF не знайдено обов’язковий текст або розраховане число.', { expected: required });
    for (const url of requiredUrls) if (!links.has(new URL(url).href)) throw new AppError('PDF_LINK_MISSING', 'У PDF відсутнє обов’язкове активне посилання.', { url });
    return { pages: document.numPages, widthPoints, heightPoints, text, preview: previews[0]!, previews, links: [...links] };
  } finally { await loading.destroy(); }
}
