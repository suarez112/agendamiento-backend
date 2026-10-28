import { type Request, type Response, Router } from 'express';
import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import type { ConsultaPago, EstadoPago, OrdenParaPago, ProveedorPago, ResultadoPago } from './proveedor.js';

export const RUTA_SIMULADO = '/simulado';

// Proveedor simulado: solo para desarrollo y pruebas. Se niega a existir con NODE_ENV=production.
// "Pagar" es abrir una página de pruebas con dos enlaces (aprobar o rechazar) que guarda la decisión en la orden;
// consultarPago la lee de ahí, igual que Wompi respondería con el estado de la transacción.
export const crearProveedorSimulado = ({
  pool,
  nodeEnv,
  urlBase,
  urlPagos,
}: {
  pool: pg.Pool;
  nodeEnv: string;
  // Dirección pública de este servidor (para armar la página de pago de pruebas)
  urlBase: string;
  // URL_PAGOS: a dónde se devuelve a la persona después de "pagar"
  urlPagos?: string;
}): ProveedorPago & { rutas: () => Router } => {
  if (nodeEnv === 'production') {
    throw new Error('El proveedor de pago simulado no puede usarse con NODE_ENV=production');
  }

  const idSimulado = (referencia: string) => `sim_${referencia}`;

  const decidir = async (referencia: string, resultado: 'aprobada' | 'rechazada') =>
    (
      await pool.query(
        `UPDATE ordenes_pago SET resultado_simulado = $2, actualizada_en = now()
         WHERE referencia = $1 AND proveedor = 'simulado' AND estado = 'pendiente'`,
        [referencia, resultado],
      )
    ).rowCount;

  return {
    nombre: 'simulado',
    async crearPago(orden: OrdenParaPago) {
      return { url: `${urlBase}/api/v1/pagos${RUTA_SIMULADO}/${encodeURIComponent(orden.referencia)}` };
    },
    async consultarPago({ referencia }: ConsultaPago): Promise<ResultadoPago | null> {
      const f = (
        await pool.query<{ resultado_simulado: 'aprobada' | 'rechazada' | null; monto_centavos: string; moneda: string }>(
          `SELECT resultado_simulado, monto_centavos, moneda FROM ordenes_pago WHERE referencia = $1 AND proveedor = 'simulado'`,
          [referencia],
        )
      ).rows[0];
      if (!f) return null;
      const estado: EstadoPago = f.resultado_simulado ?? 'pendiente';
      return {
        estado,
        referencia,
        montoCentavos: Number(f.monto_centavos),
        moneda: f.moneda,
        idExterno: f.resultado_simulado ? idSimulado(referencia) : null,
      };
    },
    // Página de pago de pruebas: GET /api/v1/pagos/simulado/:referencia (con enlaces aprobar y rechazar)
    rutas() {
      const rutas = Router();
      const escapar = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      rutas.get('/:referencia', async (req, res) => {
        const referencia = String(req.params.referencia);
        const f = (
          await pool.query<{ monto_centavos: string; estado: string }>(
            `SELECT monto_centavos, estado FROM ordenes_pago WHERE referencia = $1 AND proveedor = 'simulado'`,
            [referencia],
          )
        ).rows[0];
        if (!f) throw errores.noEncontrado('Orden no encontrada');
        const base = `${RUTA_SIMULADO}/${encodeURIComponent(referencia)}`;
        res
          .type('html')
          .send(
            `<!doctype html><meta charset="utf-8"><title>Pago simulado</title>` +
              `<h1>Pago simulado (solo desarrollo)</h1><p>Orden ${escapar(referencia)}: ` +
              `${(Number(f.monto_centavos) / 100).toLocaleString('es-CO')} COP (${escapar(f.estado)})</p>` +
              `<p><a href="${base}/aprobar">Aprobar el pago</a> · <a href="${base}/rechazar">Rechazar el pago</a></p>`,
          );
      });
      // Decide y devuelve a la persona a la app, como haría la pasarela real (con ?id=<transacción>)
      const resolver = (resultado: 'aprobada' | 'rechazada') => async (req: Request, res: Response) => {
        const referencia = String(req.params.referencia);
        const existe = (await pool.query(`SELECT 1 FROM ordenes_pago WHERE referencia = $1 AND proveedor = 'simulado'`, [referencia])).rowCount;
        if (!existe) throw errores.noEncontrado('Orden no encontrada');
        if (!(await decidir(referencia, resultado))) throw errores.conflicto('Esa orden ya no está pendiente');
        if (!urlPagos) {
          res.type('text').send(`Pago ${resultado}. Configura URL_PAGOS para volver a la app.`);
          return;
        }
        res.redirect(`${urlPagos}/${encodeURIComponent(referencia)}?id=${encodeURIComponent(idSimulado(referencia))}`);
      };
      rutas.get('/:referencia/aprobar', resolver('aprobada'));
      rutas.get('/:referencia/rechazar', resolver('rechazada'));
      return rutas;
    },
  };
};
