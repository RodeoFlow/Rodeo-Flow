
// scrape-precios.js
// Corre con un navegador headless (Puppeteer) para que el JavaScript de la
// página se ejecute de verdad (a diferencia de un fetch simple, que solo
// trae el HTML crudo sin renderizar). Extrae los precios reales del MAG /
// Mercado de Liniers y los guarda en precios-mag.json en la raíz del repo.
//
// Se corre automáticamente todos los días vía GitHub Actions
// (.github/workflows/scrape-precios.yml), pero también se puede correr a mano:
//   npm install
//   npm run scrape

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const OUT_PATH = path.join(__dirname, '..', 'precios-mag.json');

function limpiarNumero(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function extraerMinMax(texto, etiqueta) {
  const rx = new RegExp(
    etiqueta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '[^\\d]{0,60}([\\d]{1,5}[.,]\\d{2})[^\\d]{0,40}([\\d]{1,5}[.,]\\d{2})',
    'i'
  );
  const m = texto.match(rx);
  if (!m) return null;
  const min = limpiarNumero(m[1]);
  const max = limpiarNumero(m[2]);
  if (min == null || max == null || min < 100 || max < min) return null;
  return { min, max, prom: Math.round((min + max) / 2) };
}

async function getTextoRenderizado(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(res => setTimeout(res, 2500));
  return await page.evaluate(() => document.body.innerText);
}

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');

  const resultado = {
    fecha_scrape: new Date().toISOString(),
    fecha_mercado: null,
    fuente: 'MAG / Mercado de Liniers (elrural.com, scraping automático diario)',
    categorias: {},
    indice_arrendamiento_novillo_kg_ha: null,
    ok: false
  };

  try {
    const texto1 = await getTextoRenderizado(page, 'https://www.elrural.com/mercados/ganadero/mercado-de-liniers/liniers-precios-1/');
    const fechaM = texto1.match(/(\d{2}\/\d{2}\/\d{2,4})/);
    if (fechaM) resultado.fecha_mercado = fechaM[1];

    const brackets = ['Novillos 431/460', 'Novillos 461/490', 'Novillos 491/520']
      .map(l => extraerMinMax(texto1, l)).filter(Boolean);
    if (brackets.length) {
      const min = Math.min(...brackets.map(b => b.min));
      const max = Math.max(...brackets.map(b => b.max));
      resultado.categorias['Novillo'] = { min, max, prom: Math.round((min + max) / 2) };
      resultado.ok = true;
    }
  } catch (e) {
    console.warn('[scrape] liniers-precios-1 falló:', e.message);
  }

  try {
    const texto2 = await getTextoRenderizado(page, 'https://www.elrural.com/mercados/ganadero/mercado-de-liniers/liniers-precios-2/');
    const map2 = {
      'Novillito': 'Novillitos Reg/esp',
      'Vaquillona': 'VAQ. REG/ESP',
      'Vaca Invernada': 'VACAS REG/ESP',
      'Vaca Manufactura': 'VACAS CVA INF/BUE',
      'Toro': 'TOROS REG/ESP'
    };
    for (const [cat, etiqueta] of Object.entries(map2)) {
      const v = extraerMinMax(texto2, etiqueta);
      if (v) { resultado.categorias[cat] = v; resultado.ok = true; }
    }
  } catch (e) {
    console.warn('[scrape] liniers-precios-2 falló:', e.message);
  }

  try {
    const texto3 = await getTextoRenderizado(page, 'https://www.elrural.com/mercados/ganadero/precios-indicativos/indice-novillo-arrendamiento-precios-indicativos/');
    const m = texto3.match(/Novillo\s+Arren\.?\s*Semanal[^\d]{0,60}(\d[\d.,]{2,8})/i)
           || texto3.match(/arrendamiento[^\d]{0,60}(\d{3,4}[.,]\d{1,3})/i);
    if (m) {
      const val = limpiarNumero(m[1]);
      if (val && val > 1000 && val < 20000) resultado.indice_arrendamiento_novillo_kg_ha = val;
    }
  } catch (e) {
    console.warn('[scrape] índice arrendamiento falló:', e.message);
  }

  await browser.close();

  if (!resultado.ok) {
    console.warn('[scrape] No se consiguió ningún precio real esta vez. Se mantiene el archivo anterior.');
    if (fs.existsSync(OUT_PATH)) {
      const anterior = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
      anterior.ultimo_intento_fallido = new Date().toISOString();
      fs.writeFileSync(OUT_PATH, JSON.stringify(anterior, null, 2));
    } else {
      fs.writeFileSync(OUT_PATH, JSON.stringify(resultado, null, 2));
    }
    process.exit(0);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(resultado, null, 2));
  console.log('[scrape] precios-mag.json actualizado:', JSON.stringify(resultado, null, 2));
}

main().catch(err => {
  console.error('[scrape] Error fatal:', err);
  process.exit(1);
});
