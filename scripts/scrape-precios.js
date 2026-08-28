// scrape-precios.js
// Corre con un navegador headless (Puppeteer) contra el sitio OFICIAL del
// Mercado Agroganadero (mercadoagroganadero.com.ar), que a diferencia de
// elrural.com NO tiene protección Cloudflare anti-bots.
// Guarda el resultado en precios-mag.json en la raíz del repo.
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

// Mapea el nombre de categoría tal como aparece en la tabla del MAG a
// nuestros nombres internos GENÉRICOS (los que ya usaba el resto de la app
// antes del desglose por peso — paywall, resumen, etc). Usa "incluye" en vez
// de igualdad exacta, porque el MAG a veces agrega detalles (peso, calidad)
// al nombre.
function mapearCategoria(nombreCrudo) {
  const n = nombreCrudo.toUpperCase();
  if (n.includes('INVERNADA')) {
    if (n.includes('MACHO')) return 'Invernada Machos';
    if (n.includes('HEMBRA')) return 'Invernada Hembras';
    if (n.includes('VIENTRE')) return 'Invernada Vientres';
    return null;
  }
  if (n.includes('NOVILLITO')) return 'Novillito';
  if (n.includes('NOVILLO')) return 'Novillo';
  if (n.includes('VAQUILLONA')) return 'Vaquillona';
  if (n.includes('VACA') && (n.includes('CONS') || n.includes('MANUF') || n.includes('INF'))) return 'Vaca Manufactura';
  if (n.includes('VACA')) return 'Vaca Invernada';
  if (n.includes('TORO')) return 'Toro';
  if (n.includes('TERNERA')) return 'Ternera H';
  if (n.includes('TERNERO')) return 'Ternero M';
  return null;
}

// Mapea el mismo nombre crudo a una categoría ESPECÍFICA por rango de peso
// o calidad (ej. "Novillo 431/460", "Novillo Reg.", "Vaca Cons. Buena"),
// para el desglose que se agregó a la tabla de precios en la app (ago 2026,
// a partir de una captura de Mercado Vision/MAG). Devuelve null si la fila
// no encaja en ninguna de las categorías específicas que la app conoce —
// eso es normal para filas sin datos ese día, o categorías que no agregamos
// (ej. cruzas/overos, que en la captura de referencia no traían precio).
function mapearCategoriaEspecifica(nombreCrudo) {
  const n = nombreCrudo.toUpperCase().trim();
  const rango = n.match(/(\d{3}\/\d{3}|\+\d{3})/); // ej: 431/460, 300/350, +520
  const esReg = /\bREG\b/.test(n);

  if (n.includes('NOVILLITO')) {
    if (rango) return 'Novillito ' + rango[0];
    if (esReg) return 'Novillito Reg.';
    return null;
  }
  if (n.includes('NOVILLO')) {
    if (rango) return 'Novillo ' + rango[0];
    if (esReg) return 'Novillo Reg.';
    return null; // cruzas/overos u otras variantes sin precio de referencia
  }
  if (n.includes('VAQUILLONA')) {
    if (rango) return 'Vaquillona ' + rango[0];
    if (esReg) return 'Vaquillona Reg.';
    return null;
  }
  if (n.includes('VACA')) {
    if (n.includes('CONS')) {
      if (n.includes('BUENA')) return 'Vaca Cons. Buena';
      if (n.includes('INFER') || n.includes('INF')) return 'Vaca Cons. Infer.';
      return null;
    }
    if (n.includes('BUENA') || n.includes('ESP')) return 'Vaca Buena/Esp.';
    if (esReg) return 'Vaca Reg.';
    return null;
  }
  if (n.includes('TORO')) {
    if (n.includes('BUENO') || n.includes('ESP')) return 'Toro Bueno/Esp.';
    if (esReg) return 'Toro Reg.';
    return null;
  }
  return null;
}

// Acumula min/max para una categoría (genérica o específica). Si la
// categoría ya venía de otra fila (ej. varias franjas de Novillo aportan al
// mismo bucket genérico "Novillo"), combina tomando el rango más amplio.
function acumular(categorias, cat, min, max) {
  if (!cat) return;
  if (categorias[cat]) {
    categorias[cat].min = Math.min(categorias[cat].min, min);
    categorias[cat].max = Math.max(categorias[cat].max, max);
  } else {
    categorias[cat] = { min, max };
  }
}

// Parser genérico: recorre el texto renderizado línea por línea y busca
// filas de tabla con forma "NombreCategoria  123,45  678,90  ..." (Mínimo,
// Máximo, Promedio...). No depende de adivinar el nombre exacto de cada
// categoría, sólo de reconocer el patrón "texto + varios números".
function parsearTablaCategorias(texto) {
  const categorias = {};
  const lineas = texto.split('\n').map(l => l.trim()).filter(Boolean);
  const rxFila = /^([A-Za-zÀ-ÿ0-9./\- ]{3,40}?)\s+([\d]+(?:\.\d{3})*(?:,\d+)?)\s+([\d]+(?:\.\d{3})*(?:,\d+)?)\s+([\d]+(?:\.\d{3})*(?:,\d+)?)/;
  for (const linea of lineas) {
    const m = linea.match(rxFila);
    if (!m) continue;
    const nombre = m[1].trim();
    const min = limpiarNumero(m[2]);
    const max = limpiarNumero(m[3]);
    if (min == null || max == null || min < 100 || max < min || max > 20000) continue;

    // Bucket genérico (compatibilidad con el resto de la app: paywall, etc.)
    acumular(categorias, mapearCategoria(nombre), min, max);
    // Bucket específico por rango de peso/calidad (tabla de precios detallada)
    acumular(categorias, mapearCategoriaEspecifica(nombre), min, max);
  }
  Object.values(categorias).forEach(v => { v.prom = Math.round((v.min + v.max) / 2); });
  return categorias;
}

async function getTextoRenderizado(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(res => setTimeout(res, 1500));
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
    fuente: 'MAG - Mercado Agroganadero (mercadoagroganadero.com.ar, scraping automático diario)',
    categorias: {},
    indice_arrendamiento_novillo_kg_ha: null,
    ok: false
  };

  // ── Precios por categoría (fuente oficial MAG, sin Cloudflare) ──
  try {
    const url = 'https://www.mercadoagroganadero.com.ar/dll/hacienda1.dll/haciinfo000002';
    const texto = await getTextoRenderizado(page, url);
    console.log('[scrape][diag] categorías: ' + texto.length + ' caracteres | contiene "PRECIOS POR CATEGORIA": ' + texto.toUpperCase().includes('PRECIOS POR CATEGORIA'));

    const fechaM = texto.match(/(\d{2}\/\d{2}\/\d{4})\s+AL\s+[^\d]*(\d{2}\/\d{2}\/\d{4})/i);
    if (fechaM) resultado.fecha_mercado = fechaM[2];

    const categorias = parsearTablaCategorias(texto);
    if (Object.keys(categorias).length) {
      resultado.categorias = categorias;
      resultado.ok = true;
      console.log('[scrape][diag] Categorías encontradas: ' + Object.keys(categorias).join(', '));
    } else {
      console.log('[scrape][diag] Tabla sin filas de precios todavía (puede que hoy no haya remate cargado). Primeros 1200 caracteres:\n' + texto.slice(0, 1200));
    }
  } catch (e) {
    console.warn('[scrape] Precios por categoría falló:', e.message);
  }

  // ── Índice de arrendamiento (misma fuente oficial MAG) ──
  try {
    const url2 = 'https://www.mercadoagroganadero.com.ar/dll/hacienda2.dll/haciinfo000013';
    const texto2 = await getTextoRenderizado(page, url2);
    const m = texto2.match(/Totales\s+([\d.]+)\s+([\d.,]+)\s+([\d.,]+)/i);
    if (m) {
      const val = limpiarNumero(m[3]);
      if (val && val > 500 && val < 30000) resultado.indice_arrendamiento_novillo_kg_ha = val;
    } else {
      console.log('[scrape][diag] índice arrendamiento: no se encontró patrón. Primeros 800 caracteres:\n' + texto2.slice(0, 800));
    }
  } catch (e) {
    console.warn('[scrape] Índice arrendamiento falló:', e.message);
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
