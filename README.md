# Panel de Caducidad · Insumos y Equipos de Laboratorio

Panel analítico para control de vencimiento de lotes, rotación de inventario y valor en riesgo monetario ($) para:
* **047 - JORGE ESTRELLA**
* **079 - INGELAB GROUP S.A.S**

---

## 🚀 Arquitectura e Integración de APIs

El proyecto combina la información de tres servicios en tiempo real:

1. **API Insoft de Saldos y Lotes (`/saldos-items`):**
   * Códigos de ítems (`codItem`), descripciones, almacén (`codBodega`, `nombreBodega`), números de lote (`nroLote`), fechas de expiración (`fechaVencimiento`) y saldos físicos en almacén (`saldoDisponible`).
2. **API Catalyst de Productos (`/productos`):**
   * Costos promedio unitarios (`costoPromedio`), marcas (`nombreTipo`), registros sanitarios (`regSanitario`) y fechas de caducidad de registro sanitario.
3. **API Catalyst de Ventas Históricas (`/ventas-historicas`):**
   * Unidades facturadas acumuladas para calcular la rotación, el stock total histórico y el porcentaje recuperado.

---

## 🌐 Despliegue en Vercel

* **¿Requiere Base de Datos?**
  **No.** El sistema funciona de forma serverless consumiendo las APIs del ERP y sirviendo los datos consolidados a través de la Serverless Function `/api/datos` con almacenamiento en caché perimetral (`Cache-Control`).
* **Estructura del Proyecto:**
  * `index.html`: Interfaz del panel (KPIs, semáforos, gráficos de Chart.js y tabla de lotes).
  * `api/datos.js`: Endpoint serverless en Node.js para servir los datos en Vercel.
  * `datos_erp_combinados.json`: Archivo consolidado de inventario y caducidad.
  * `sync_erp.py`: Script para sincronización y cruce de datos desde las APIs.
  * `vercel.json`: Configuración de encabezados y rutas para Vercel.

---

## 💻 Ejecución en Local

1. Para abrir el servidor local:
   * Ejecuta `iniciar_servidor.bat` o corre `python -m http.server 8085`.
   * Abre en tu navegador: [http://localhost:8085](http://localhost:8085)
2. Para actualizar los datos desde las APIs del ERP:
   * Ejecuta `actualizar_datos_erp.bat`.
