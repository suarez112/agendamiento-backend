import type pg from 'pg';
import { type Entorno, proveedorDePagoActivo } from '../../config/entorno.js';
import type { ProveedorPago } from './proveedor.js';
import { crearProveedorManual } from './proveedorManual.js';
import { crearProveedorSimulado } from './proveedorSimulado.js';
import { crearProveedorWompi } from './proveedorWompi.js';

// Elige el proveedor de pago según el entorno. undefined = pagos desactivados (producción sin PROVEEDOR_PAGO).
// El entorno ya garantizó (cargarEntorno) que en producción no hay simulado ni llaves de prueba.
export const crearProveedorDePago = (entorno: Entorno, pool: pg.Pool): ProveedorPago | undefined => {
  switch (proveedorDePagoActivo(entorno)) {
    case 'simulado':
      return crearProveedorSimulado({
        pool,
        nodeEnv: entorno.NODE_ENV,
        urlBase: entorno.URL_PUBLICA ?? `http://localhost:${entorno.PORT}`,
        urlPagos: entorno.URL_PAGOS,
      });
    case 'wompi':
      return crearProveedorWompi({
        publica: entorno.WOMPI_LLAVE_PUBLICA!,
        privada: entorno.WOMPI_LLAVE_PRIVADA!,
        secretoEventos: entorno.WOMPI_SECRETO_EVENTOS!,
        secretoIntegridad: entorno.WOMPI_SECRETO_INTEGRIDAD!,
      });
    case 'manual':
      return crearProveedorManual();
    default:
      return undefined;
  }
};
