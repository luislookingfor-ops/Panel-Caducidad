import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const filePath = path.join(process.cwd(), 'datos_erp_combinados.json');
    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(fileContent);
    } else {
      return res.status(404).json({ error: 'Archivo de datos no encontrado' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Error interno al cargar datos', details: error.message });
  }
}
