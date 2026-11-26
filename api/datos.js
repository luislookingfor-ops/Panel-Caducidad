import fs from 'fs';
import path from 'path';

const EMPRESAS = [
  {
    cod: '047',
    nombre: 'JORGE ESTRELLA',
    auth: '047-1001089458071'
  },
  {
    cod: '079',
    nombre: 'INGELAB GROUP S.A.S',
    auth: '079-1001176123971'
  }
];

const COMBINED_TTL_MS = 3 * 60 * 1000;   // 3 min en memoria caliente
const CATALYST_TTL_MS = 30 * 60 * 1000; // 30 min para catálogo de productos y ventas históricas

function getCache() {
  if (!globalThis.__INGELAB_API_CACHE__) {
    globalThis.__INGELAB_API_CACHE__ = {
      snapshotRaw: null,
      snapshotParsed: null,
      combined: null, // { body, headers, ts }
      catalyst: {}    // { [cod]: { productos, ventas, ts } }
    };
  }
  return globalThis.__INGELAB_API_CACHE__;
}

function cleanStr(val) {
  if (val === null || val === undefined) return '';
  const s = String(val).trim();
  return s.toLowerCase() === 'null' ? '' : s;
}

async function fetchJsonWithRetry(url, timeoutMs = 45000, retries = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; IngelabPanel/2.0)',
          'Accept-Encoding': 'gzip, deflate, br'
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} en ${url}`);
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        throw new Error(`Respuesta inválida (no es arreglo JSON) en ${url}`);
      }
      return data;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }
  throw lastError;
}

function readSnapshot() {
  const cache = getCache();
  if (cache.snapshotParsed) return cache.snapshotParsed;
  const filePath = path.join(process.cwd(), 'datos_erp_combinados.json');
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  cache.snapshotRaw = raw;
  cache.snapshotParsed = parsed;
  return parsed;
}

function buildSnapshotIndexes(snapshotByCompany) {
  const prodByCode = new Map();
  const salesByExactKey = new Map();
  for (const row of snapshotByCompany) {
    if (row.codigo && !prodByCode.has(row.codigo)) {
      prodByCode.set(row.codigo, row);
    }
    const loteKey = cleanStr(row.nroLoteReal) || cleanStr(row.lote);
    const exactKey = `${cleanStr(row.codigo)}|||${cleanStr(row.codBodega || row.bodega)}|||${loteKey}`;
    if (!salesByExactKey.has(exactKey)) {
      salesByExactKey.set(exactKey, Number(row.vendido || 0));
    }
  }
  return { prodByCode, salesByExactKey };
}

function combineCompanyRows(emp, saldos, productos, ventas, snapshotByCompany) {
  const saldosActivos = saldos.filter((s) => Number(s.saldoDisponible || 0) > 0);
  const { prodByCode: snapProdMap, salesByExactKey: snapSalesMap } = buildSnapshotIndexes(snapshotByCompany);

  const hasLiveProductos = Array.isArray(productos) && productos.length > 0;
  const prodMap = new Map();
  if (hasLiveProductos) {
    for (const p of productos) {
      const codItem = cleanStr(p.codItem);
      if (codItem) prodMap.set(codItem, p);
    }
  }

  const hasLiveVentas = Array.isArray(ventas) && ventas.length > 0;
  const ventasLoteMap = new Map();
  const ventasBodegaSinLote = new Map();
  if (hasLiveVentas) {
    for (const v of ventas) {
      const it = cleanStr(v.codItem);
      const bd = cleanStr(v.codBodega);
      const lt = cleanStr(v.nroLote);
      const cant = Number(v.cantidad || 0);
      if (!it || !bd || !cant) continue;
      if (lt) {
        const k = `${it}|||${bd}|||${lt}`;
        ventasLoteMap.set(k, (ventasLoteMap.get(k) || 0) + cant);
      } else {
        const k = `${it}|||${bd}`;
        ventasBodegaSinLote.set(k, (ventasBodegaSinLote.get(k) || 0) + cant);
      }
    }
  }

  const sinLoteMatchSaldos = new Map();
  if (hasLiveVentas) {
    for (const s of saldosActivos) {
      const codItem = cleanStr(s.codItem);
      const codBodega = cleanStr(s.codBodega) || 'B1';
      const loteErp = cleanStr(s.nroLote);
      const loteKey = `${codItem}|||${codBodega}|||${loteErp}`;
      if (!(loteErp && ventasLoteMap.has(loteKey))) {
        const grpKey = `${codItem}|||${codBodega}`;
        sinLoteMatchSaldos.set(
          grpKey,
          (sinLoteMatchSaldos.get(grpKey) || 0) + Number(s.saldoDisponible || 0)
        );
      }
    }
  }

  return saldosActivos.map((s) => {
    const codItem = cleanStr(s.codItem);
    const item = prodMap.get(codItem) || {};
    const snap = snapProdMap.get(codItem) || {};

    const codBodega = cleanStr(s.codBodega) || 'B1';
    const nombreBodega = cleanStr(s.nombreBodega);
    const bodegaCompleta = nombreBodega ? `${codBodega} · ${nombreBodega}` : codBodega;

    const loteErp = cleanStr(s.nroLote);
    const vencErp = cleanStr(s.fechaVencimiento);
    const regSan = cleanStr(item.regSanitario) || cleanStr(snap.regSanitario);
    const fechaReg = cleanStr(item.fechaCaducaRegSanitario);

    let loteFinal = 'S/L';
    let tipoLote = 'SIN_LOTE';
    if (loteErp) {
      loteFinal = loteErp;
      tipoLote = 'LOTE';
    } else if (regSan) {
      loteFinal = regSan;
      tipoLote = 'REG_SANITARIO';
    }

    let vencFinal = '';
    let origenVencimiento = 'Sin fecha';
    if (vencErp) {
      vencFinal = vencErp;
      origenVencimiento = 'Vencimiento de Lote';
    } else if (fechaReg) {
      vencFinal = fechaReg;
      origenVencimiento = 'Caducidad Reg. Sanitario';
    } else if (!hasLiveProductos && snap.vencimiento) {
      vencFinal = snap.vencimiento;
      origenVencimiento = snap.origenVencimiento || 'Respaldo sincronizado';
    }

    const saldoActual = Number(s.saldoDisponible || 0);
    let vendido = 0;
    const exactKey = `${codItem}|||${codBodega}|||${loteErp}`;
    const grpKey = `${codItem}|||${codBodega}`;

    if (hasLiveVentas) {
      if (loteErp && ventasLoteMap.has(exactKey)) {
        vendido = ventasLoteMap.get(exactKey);
      } else if (ventasBodegaSinLote.has(grpKey)) {
        const totalGrupo = sinLoteMatchSaldos.get(grpKey) || 0;
        if (totalGrupo > 0) {
          vendido = ventasBodegaSinLote.get(grpKey) * (saldoActual / totalGrupo);
        }
      }
    } else {
      const snapExactKey = `${codItem}|||${codBodega}|||${loteErp || loteFinal}`;
      if (snapSalesMap.has(snapExactKey)) {
        vendido = snapSalesMap.get(snapExactKey);
      }
    }

    const stockBase = saldoActual + vendido;
    const marca =
      cleanStr(item.nombreTipo) ||
      cleanStr(item.codMarca) ||
      cleanStr(item.nombreGrupo) ||
      cleanStr(snap.marca) ||
      'GENERAL';
    const costo = Number(item.costoPromedio || item.precioCompra || snap.costo || 0);

    return {
      empresa: emp.nombre,
      empresaCod: emp.cod,
      codigo: codItem,
      descripcion: cleanStr(s.descripcion) || cleanStr(item.descripcion) || cleanStr(snap.descripcion),
      marca,
      bodega: codBodega,
      nombreBodega,
      bodegaCompleta,
      codBodega,
      lote: loteFinal,
      tipoLote,
      nroLoteReal: loteErp,
      regSanitario: regSan,
      vencimiento: vencFinal,
      origenVencimiento,
      fechaSaldo: cleanStr(s.fecha),
      unidadMedida: cleanStr(item.codUnidadMedida) || cleanStr(item.unidadMedida) || cleanStr(snap.unidadMedida),
      precioPvp: Number(Number(item.precioPvp || snap.precioPvp || 0).toFixed(4)),
      costo,
      stock: Number(stockBase.toFixed(2)),
      vendido: Number(vendido.toFixed(2)),
      aumento: 0
    };
  });
}

export default async function handler(req, res) {
  const t0 = Date.now();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Data-Source, X-Updated-At, X-Live-Companies, X-Response-Time-Ms, X-Scope');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const reqUrl = new URL(req.url || '/api/datos', 'http://localhost');
  const forceLive = reqUrl.searchParams.get('live') === '1' || reqUrl.searchParams.get('refresh') === '1';
  const forceFull = reqUrl.searchParams.get('full') === '1';
  const scopeStockOnly = reqUrl.searchParams.get('scope') === 'stock';
  const modeSnapshot = reqUrl.searchParams.get('mode') === 'snapshot';

  const cache = getCache();
  let snapshot = [];
  try {
    snapshot = readSnapshot();
  } catch (err) {
    console.error('Error leyendo snapshot local:', err);
  }

  if (modeSnapshot && snapshot.length) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    res.setHeader('X-Data-Source', 'snapshot');
    res.setHeader('X-Updated-At', new Date().toISOString());
    res.setHeader('X-Response-Time-Ms', String(Date.now() - t0));
    return res.status(200).send(cache.snapshotRaw || JSON.stringify(snapshot));
  }

  // Servir caché caliente en memoria si no se forzó recarga en vivo
  if (!forceLive && !forceFull && cache.combined && (Date.now() - cache.combined.ts) < COMBINED_TTL_MS) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    res.setHeader('X-Data-Source', cache.combined.source);
    res.setHeader('X-Live-Companies', cache.combined.companies);
    res.setHeader('X-Updated-At', cache.combined.updatedAt);
    res.setHeader('X-Scope', 'warm-memory');
    res.setHeader('X-Response-Time-Ms', String(Date.now() - t0));
    return res.status(200).send(cache.combined.body);
  }

  res.setHeader(
    'Cache-Control',
    forceLive ? 'no-store, max-age=0' : 'public, s-maxage=300, stale-while-revalidate=3600'
  );

  try {
    const now = Date.now();
    const companyResults = await Promise.all(
      EMPRESAS.map(async (emp) => {
        const urlSaldos = `http://95.217.116.101:7777/insoftApi/ZOHO/saldos-items?pcod_empresa=${emp.cod}&pautorizacion=${emp.auth}&pcod_item=`;
        const urlProd = `https://funciones-digital-strategy-831038044.development.catalystserverless.com/productos?pautorizacion=${emp.auth}&pcod_empresa=${emp.cod}`;
        const urlVentas = `https://funciones-digital-strategy-831038044.development.catalystserverless.com/ventas-historicas?pautorizacion=${emp.auth}&pcod_empresa=${emp.cod}`;

        const cachedCat = cache.catalyst[emp.cod];
        const catalystWarm = cachedCat && (now - cachedCat.ts) < CATALYST_TTL_MS;
        const skipCatalystFetch = !forceFull && (scopeStockOnly || catalystWarm);

        const saldosPromise = fetchJsonWithRetry(urlSaldos, 45000, 2);
        const prodPromise = skipCatalystFetch
          ? Promise.resolve(catalystWarm ? cachedCat.productos : null)
          : fetchJsonWithRetry(urlProd, 45000, 2);
        const ventasPromise = skipCatalystFetch
          ? Promise.resolve(catalystWarm ? cachedCat.ventas : null)
          : fetchJsonWithRetry(urlVentas, 45000, 2);

        const [saldosRes, prodRes, ventasRes] = await Promise.allSettled([
          saldosPromise,
          prodPromise,
          ventasPromise
        ]);

        const snapRows = snapshot.filter((r) => r.empresaCod === emp.cod || r.empresa === emp.nombre);

        const productos = prodRes.status === 'fulfilled' ? prodRes.value : (cachedCat ? cachedCat.productos : null);
        const ventas = ventasRes.status === 'fulfilled' ? ventasRes.value : (cachedCat ? cachedCat.ventas : null);

        if (!skipCatalystFetch && Array.isArray(productos) && Array.isArray(ventas)) {
          cache.catalyst[emp.cod] = { productos, ventas, ts: Date.now() };
        }

        if (saldosRes.status === 'fulfilled' && saldosRes.value.length > 0) {
          return {
            cod: emp.cod,
            live: true,
            rows: combineCompanyRows(emp, saldosRes.value, productos, ventas, snapRows)
          };
        }

        console.error(
          `Fallback snapshot para empresa ${emp.cod}:`,
          saldosRes.status === 'rejected' ? saldosRes.reason?.message : 'saldos vacíos'
        );
        return {
          cod: emp.cod,
          live: false,
          rows: snapRows
        };
      })
    );

    const combinedRows = companyResults.flatMap((r) => r.rows);
    const liveCompanies = companyResults.filter((r) => r.live).map((r) => r.cod);
    const sourceLabel =
      liveCompanies.length === EMPRESAS.length
        ? 'live'
        : liveCompanies.length > 0
          ? 'partial'
          : 'snapshot';

    if (!combinedRows.length) {
      return res.status(502).json({ error: 'No se pudieron obtener datos en vivo ni desde el respaldo.' });
    }

    const bodyStr = JSON.stringify(combinedRows);
    const updatedAt = new Date().toISOString();
    const companiesStr = liveCompanies.join(',') || 'none';

    if (liveCompanies.length > 0) {
      cache.combined = {
        body: bodyStr,
        source: sourceLabel,
        companies: companiesStr,
        updatedAt,
        ts: Date.now()
      };
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Data-Source', sourceLabel);
    res.setHeader('X-Live-Companies', companiesStr);
    res.setHeader('X-Updated-At', updatedAt);
    res.setHeader('X-Scope', scopeStockOnly ? 'stock' : 'full');
    res.setHeader('X-Response-Time-Ms', String(Date.now() - t0));
    return res.status(200).send(bodyStr);
  } catch (error) {
    console.error('Error crítico en /api/datos:', error);
    if (snapshot.length) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Data-Source', 'snapshot');
      res.setHeader('X-Updated-At', new Date().toISOString());
      res.setHeader('X-Response-Time-Ms', String(Date.now() - t0));
      return res.status(200).send(cache.snapshotRaw || JSON.stringify(snapshot));
    }
    return res.status(500).json({ error: 'Error interno al cargar datos', details: error.message });
  }
}
