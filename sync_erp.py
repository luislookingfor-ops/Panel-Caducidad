"""
Script de sincronización integral de inventario, ventas y caducidad
Combina 3 APIs de Catalyst e Insoft para 047 (JORGE ESTRELLA) y 079 (INGELAB GROUP S.A.S):
1. API Insoft de Saldos-Items: codItem, codBodega, nombreBodega, nroLote, fechaVencimiento, saldoDisponible
2. API Catalyst de Productos: codItem, descripcion, costoPromedio, marca, regSanitario, fechaCaducaRegSanitario
3. API Catalyst de Ventas Históricas: codItem, codBodega, nroLote, cantidad vendida
"""

import json
import urllib.request
import sys
import os
from datetime import datetime

EMPRESAS = [
    {
        'cod': '047',
        'nombre': 'JORGE ESTRELLA',
        'auth': '047-1001089458071'
    },
    {
        'cod': '079',
        'nombre': 'INGELAB GROUP S.A.S',
        'auth': '079-1001176123971'
    }
]

def load_local_backup(path):
    if not os.path.exists(path):
        return []
    for enc in ['utf-8', 'utf-16', 'latin-1']:
        try:
            with open(path, 'r', encoding=enc) as f:
                return json.load(f)
        except Exception:
            continue
    return []

def fetch_json(url, timeout=50):
    print(f"Descargando: {url} ...")
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        content = response.read().decode('utf-8', errors='ignore')
        return json.loads(content)

def sincronizar():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    todas_las_filas = []

    for emp in EMPRESAS:
        cod = emp['cod']
        nombre = emp['nombre']
        auth = emp['auth']
        print(f"\n=======================================================")
        print(f"Sincronizando Empresa {cod} - {nombre}")
        print(f"=======================================================")

        # 1. API Saldos-Items (Insoft) -> Ahora incluye nroLote y fechaVencimiento
        url_saldos = f"http://95.217.116.101:7777/insoftApi/ZOHO/saldos-items?pcod_empresa={cod}&pautorizacion={auth}&pcod_item="
        try:
            saldos = fetch_json(url_saldos)
            print(f"  [1/3] Saldos en bodegas: {len(saldos)} registros")
            saldos_activos = [s for s in saldos if float(s.get('saldoDisponible') or 0) > 0]
            print(f"        Saldos con stock disponible > 0: {len(saldos_activos)}")
            con_lote = [s for s in saldos_activos if s.get('nroLote')]
            print(f"        Registros con nroLote y fechaVencimiento: {len(con_lote)}")
            with open(os.path.join(base_dir, f"saldos_{cod}_positivos.json"), 'w', encoding='utf-8') as f:
                json.dump(saldos_activos, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"  [AVISO] Error descargando saldos en vivo: {e}. Usando respaldo local.")
            backup_saldos = os.path.join(base_dir, f"saldos_{cod}_positivos.json")
            saldos_activos = load_local_backup(backup_saldos)

        # 2. API Productos (Catalyst) -> costoPromedio, marca, regSanitario, fechaCaducaRegSanitario
        url_prod = f"https://funciones-digital-strategy-831038044.development.catalystserverless.com/productos?pautorizacion={auth}&pcod_empresa={cod}"
        try:
            productos = fetch_json(url_prod)
            print(f"  [2/3] Productos: {len(productos)} registros recibidos")
            prod_map = {p['codItem']: p for p in productos if p.get('codItem')}
            with open(os.path.join(base_dir, f"test_{cod}.json" if cod == "047" else f"test_{cod}_new.json"), 'w', encoding='utf-8') as f:
                json.dump(productos, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"  [AVISO] Error descargando productos en vivo: {e}. Usando respaldo local.")
            backup_prod = os.path.join(base_dir, f"test_{cod}.json" if cod == "047" else f"test_{cod}_new.json")
            prod_list = load_local_backup(backup_prod)
            prod_map = {p['codItem']: p for p in prod_list if p.get('codItem')}

        # 3. API Ventas Históricas (Catalyst) -> cantidad vendida
        url_ventas = f"https://funciones-digital-strategy-831038044.development.catalystserverless.com/ventas-historicas?pautorizacion={auth}&pcod_empresa={cod}"
        try:
            ventas = fetch_json(url_ventas)
            print(f"  [3/3] Ventas históricas: {len(ventas)} facturas/líneas recibidas")
            with open(os.path.join(base_dir, f"test_ventas_{cod}.json"), 'w', encoding='utf-8') as f:
                json.dump(ventas, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"  [AVISO] Error descargando ventas en vivo: {e}. Usando respaldo local.")
            backup_ventas = os.path.join(base_dir, f"test_ventas_{cod}.json")
            ventas = load_local_backup(backup_ventas)

        # Agrupar ventas por (codItem, codBodega, nroLote), (codItem, codBodega) y codItem
        ventas_lote_map = {}
        ventas_bodega_map = {}
        ventas_item_total = {}

        for v in ventas:
            it = v.get('codItem')
            bd = v.get('codBodega')
            lt = v.get('nroLote')
            cant = float(v.get('cantidad') or 0)
            if it:
                ventas_item_total[it] = ventas_item_total.get(it, 0) + cant
                if bd:
                    ventas_bodega_map[(it, bd)] = ventas_bodega_map.get((it, bd), 0) + cant
                    if lt and lt != 'null':
                        ventas_lote_map[(it, bd, lt)] = ventas_lote_map.get((it, bd, lt), 0) + cant

        print(f"        Total items con ventas registradas: {len(ventas_item_total)}")
        print(f"        Total unidades vendidas acumuladas: {sum(ventas_item_total.values()):,.1f}")

        # 4. Combinar Lotes de Almacén + Productos + Ventas Históricas
        for s in saldos_activos:
            cod_item = s.get('codItem')
            item = prod_map.get(cod_item, {})
            
            cod_bodega = s.get('codBodega') or 'B1'
            nombre_bodega = s.get('nombreBodega') or ''
            bodega_display = f"{cod_bodega} · {nombre_bodega}" if nombre_bodega else cod_bodega

            # Lote y fecha de vencimiento:
            # 1. Prioridad: el nroLote y fechaVencimiento que vienen directamente en saldos-items
            # 2. Respaldo: el Registro Sanitario y fecha de caducidad de Registro Sanitario de productos
            lote_erp = s.get('nroLote')
            venc_erp = s.get('fechaVencimiento')
            
            reg_san = item.get('regSanitario')
            fecha_reg = item.get('fechaCaducaRegSanitario')

            if lote_erp and lote_erp.strip() and lote_erp != 'null':
                lote_final = lote_erp.strip()
                tipo_lote = 'LOTE'
            elif reg_san and reg_san.strip() and reg_san != 'null':
                lote_final = reg_san.strip()
                tipo_lote = 'REG_SANITARIO'
            else:
                lote_final = 'S/L'
                tipo_lote = 'SIN_LOTE'

            if venc_erp and venc_erp.strip() and venc_erp != 'null':
                venc_final = venc_erp.strip()
                origen_venc = 'Vencimiento de Lote'
            elif fecha_reg and fecha_reg.strip() and fecha_reg != 'null':
                venc_final = fecha_reg.strip()
                origen_venc = 'Caducidad Reg. Sanitario'
            else:
                venc_final = ''
                origen_venc = 'Sin fecha'

            # Unidades vendidas para este lote/bodega
            vendido = 0
            if lote_erp and (cod_item, cod_bodega, lote_erp) in ventas_lote_map:
                vendido = ventas_lote_map[(cod_item, cod_bodega, lote_erp)]
            elif (cod_item, cod_bodega) in ventas_bodega_map:
                vendido = ventas_bodega_map[(cod_item, cod_bodega)]
            elif cod_item in ventas_item_total and len(ventas_bodega_map) == 0:
                vendido = ventas_item_total[cod_item]

            # Stock disponible actual en bodega
            saldo_actual = float(s.get('saldoDisponible') or 0)
            stock_base = saldo_actual + vendido

            marca = item.get('nombreTipo') or item.get('codMarca') or item.get('nombreGrupo') or 'GENERAL'
            costo = float(item.get('costoPromedio') or item.get('precioCompra') or 0)

            todas_las_filas.append({
                'empresa': nombre,
                'empresaCod': cod,
                'codigo': cod_item,
                'descripcion': s.get('descripcion') or item.get('descripcion', ''),
                'marca': marca,
                'bodega': cod_bodega,
                'nombreBodega': nombre_bodega,
                'bodegaCompleta': bodega_display,
                'codBodega': cod_bodega,
                'lote': lote_final,
                'tipoLote': tipo_lote,
                'nroLoteReal': lote_erp or '',
                'regSanitario': reg_san or '',
                'vencimiento': venc_final,
                'origenVencimiento': origen_venc,
                'costo': costo,
                'stock': round(stock_base, 2),
                'vendido': round(vendido, 2),
                'aumento': 0
            })

    # Guardar archivo unificado
    salida_path = os.path.join(base_dir, 'datos_erp_combinados.json')
    with open(salida_path, 'w', encoding='utf-8') as f:
        json.dump(todas_las_filas, f, ensure_ascii=False, indent=2)

    con_venc = [f for f in todas_las_filas if f['vencimiento']]
    con_lote_real = [f for f in todas_las_filas if f['nroLoteReal']]
    con_ventas = [f for f in todas_las_filas if f['vendido'] > 0]
    total_vendido = sum(f['vendido'] for f in todas_las_filas)
    total_stock_actual = sum(f['stock'] - f['vendido'] for f in todas_las_filas)

    print(f"\n=======================================================")
    print(f"PROCESO FINALIZADO EXITOSAMENTE:")
    print(f"Total registros con stock en bodega: {len(todas_las_filas)}")
    print(f"Registros con LOTE REAL del ERP (nroLote): {len(con_lote_real)}")
    print(f"Registros con FECHA DE VENCIMIENTO monitoreada: {len(con_venc)}")
    print(f"Registros con ventas históricas asociadas: {len(con_ventas)}")
    print(f"Total unidades vendidas acumuladas: {total_vendido:,.1f}")
    print(f"Total unidades en stock actual (sin vender): {total_stock_actual:,.1f}")
    print(f"Archivo generado: {salida_path}")
    print(f"=======================================================\n")

if __name__ == '__main__':
    sincronizar()
