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
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IngelabPanel/1.0)' },
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
        await new Promise((r) => setTimeout(r, 1200 * attempt));
      }
    }
  }
  throw lastError;
}

function readSnapshot() {
  const filePath = path.join(process.cwd(), 'datos_erp_combinados.json');
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function combineCompanyRows(emp, saldos, productos, ventas, snapshotByCompany) {
  const saldosActivos = saldos.filter((s) => Number(s.saldoDisponible || 0) > 0);
  const prodMap = new Map();
  if (Array.isArray(productos)) {
    for (const p of productos) {
      const codItem = cleanStr(p.codItem);
      if (codItem) prodMap.set(codItem, p);
    }
  }

  // Fallback rápido por si falló Catalyst productos para algún código
  const snapshotProdMap = new Map();
  for (const row of snapshotByCompany) {
    if (row.codigo && !snapshotProdMap.has(row.codigo)) {
      snapshotProdMap.set(row.codigo, row);
    }
  }

  const ventasLoteMap = new Map();
  const ventasBodegaSinLote = new Map();
  if (Array.isArray(ventas)) {
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

  // Precalcular saldo total de lotes sin match exacto para repartir ventas sin lote sin duplicar
  const sinLoteMatchSaldos = new Map();
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

  return saldosActivos.map((s) => {
    const codItem = cleanStr(s.codItem);
    const item = prodMap.get(codItem) || {};
    const snap = snapshotProdMap.get(codItem) || {};

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
    } else if (!prodMap.size && snap.vencimiento) {
      vencFinal = snap.vencimiento;
      origenVencimiento = snap.origenVencimiento || 'Respaldo local';
    }

    const saldoActual = Number(s.saldoDisponible || 0);
    let vendido = 0;
    const exactKey = `${codItem}|||${codBodega}|||${loteErp}`;
    const grpKey = `${codItem}|||${codBodega}`;
    if (loteErp && ventasLoteMap.has(exactKey)) {
      vendido = ventasLoteMap.get(exactKey);
    } else if (ventasBodegaSinLote.has(grpKey)) {
      const totalGrupo = sinLoteMatchSaldos.get(grpKey) || 0;
      if (totalGrupo > 0) {
        vendido = ventasBodegaSinLote.get(grpKey) * (saldoActual / totalGrupo);
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Data-Source, X-Updated-At, X-Live-Companies');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const reqUrl = new URL(req.url || '/api/datos', 'http://localhost');
  const forceLive = reqUrl.searchParams.get('live') === '1' || reqUrl.searchParams.get('refresh') === '1';
  const modeSnapshot = reqUrl.searchParams.get('mode') === 'snapshot';

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
    return res.status(200).send(JSON.stringify(snapshot));
  }

  if (forceLive) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
  } else {
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
  }

  try {
    const companyResults = await Promise.all(
      EMPRESAS.map(async (emp) => {
        const urlSaldos = `http://95.217.116.101:7777/insoftApi/ZOHO/saldos-items?pcod_empresa=${emp.cod}&pautorizacion=${emp.auth}&pcod_item=`;
        const urlProd = `https://funciones-digital-strategy-831038044.development.catalystserverless.com/productos?pautorizacion=${emp.auth}&pcod_empresa=${emp.cod}`;
        const urlVentas = `https://funciones-digital-strategy-831038044.development.catalystserverless.com/ventas-historicas?pautorizacion=${emp.auth}&pcod_empresa=${emp.cod}`;

        const [saldosRes, prodRes, ventasRes] = await Promise.allSettled([
          fetchJsonWithRetry(urlSaldos, 45000, 2),
          fetchJsonWithRetry(urlProd, 45000, 2),
          fetchJsonWithRetry(urlVentas, 45000, 2)
        ]);

        const snapRows = snapshot.filter((r) => r.empresaCod === emp.cod || r.empresa === emp.nombre);

        if (saldosRes.status === 'fulfilled' && saldosRes.value.length > 0) {
          const productos = prodRes.status === 'fulfilled' ? prodRes.value : [];
          const ventas = ventasRes.status === 'fulfilled' ? ventasRes.value : [];
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

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Data-Source', sourceLabel);
    res.setHeader('X-Live-Companies', liveCompanies.join(',') || 'none');
    res.setHeader('X-Updated-At', new Date().toISOString());
    return res.status(200).send(JSON.stringify(combinedRows));
  } catch (error) {
    console.error('Error crítico en /api/datos:', error);
    if (snapshot.length) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Data-Source', 'snapshot');
      res.setHeader('X-Updated-At', new Date().toISOString());
      return res.status(200).send(JSON.stringify(snapshot));
    }
    return res.status(500).json({ error: 'Error interno al cargar datos', details: error.message });
  }
}
