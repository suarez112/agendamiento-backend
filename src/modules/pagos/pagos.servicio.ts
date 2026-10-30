import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { buscarPlan, COBRO, type Periodo, precioPara } from '../../config/planes.js';
import { enTransaccion } from '../../db/pool.js';
import { ErrorApp, errores } from '../../shared/errores.js';
import { registro } from '../../shared/registro.js';
import { activarPlanEmpresa } from '../empresas/activacion.js';
import { contarEquipoCobrable } from '../empresas/cobro.js';
import { registrarActividad } from '../superadmin/superadmin.repositorio.js';
import type { EstadoPago, ProveedorPago, ResultadoPago } from './proveedor.js';

export type Orden = {
  referencia: string;
  proveedor: string;
  profesionales: number;
  periodo: Periodo;
  monto: number;
  moneda: string;
  estado: EstadoPago;
  activada: boolean;
};

type FilaOrden = {
  id: string;
  referencia: string;
  empresa_id: string;
  empresa_codigo: string | null;
  proveedor: string;
  profesionales: number;
  periodo: Periodo;
  monto_centavos: string;
  moneda: string;
  estado: EstadoPago;
  id_externo: string | null;
  activada_en: Date | null;
};

const COLUMNAS = `id, referencia, empresa_id, empresa_codigo, proveedor, profesionales, periodo, monto_centavos, moneda, estado,
                  id_externo, activada_en`;

const aOrden = (f: FilaOrden): Orden => ({
  referencia: f.referencia,
  proveedor: f.proveedor,
  profesionales: f.profesionales,
  periodo: f.periodo,
  monto: Number(f.monto_centavos) / 100,
  moneda: f.moneda,
  estado: f.estado,
  activada: f.activada_en !== null,
});

export const MENSAJE_SIN_PAGOS = 'Los pagos en línea no están disponibles por ahora. Comunícate con soporte para activar tu plan.';

export type DependenciasPagos = {
  pool: pg.Pool;
  // undefined = pagos desactivados (producción sin pasarela configurada)
  proveedor?: ProveedorPago;
  // URL_PAGOS: a dónde se devuelve a la persona después de pagar
  urlPagos?: string;
  // El proveedor activo cobra en modo de prueba (simulado o llaves de prueba)
  esDePrueba?: boolean;
};

export type EstadoPublico = 'aprobado' | 'pendiente' | 'rechazado';

export const crearServicioPagos = ({ pool, proveedor, urlPagos, esDePrueba = false }: DependenciasPagos) => {
  const requerirProveedor = () => {
    if (!proveedor) throw new ErrorApp(503, MENSAJE_SIN_PAGOS);
    return proveedor;
  };

  // Crea la orden con el precio que sale de las reglas actuales (src/config/planes.ts) y devuelve dónde pagar
  const crearOrden = async (empresaId: string, entrada: { profesionales: number; periodo: Periodo }) => {
    const pasarela = requerirProveedor();
    if (pasarela.nombre === 'manual') throw errores.solicitudInvalida('Con los pagos manuales la orden solo lleva el periodo: el monto lo calcula el servidor');
    if (!urlPagos) throw new ErrorApp(503, 'Los pagos no están configurados: falta URL_PAGOS en el servidor.');
    if (entrada.profesionales > COBRO.maxProfesionales) {
      throw errores.solicitudInvalida(`Un negocio puede tener hasta ${COBRO.maxProfesionales} profesionales`);
    }
    const empresa = (
      await pool.query<{ codigo_acceso: string; estado_suscripcion: string; suspendida_en: Date | null }>(
        'SELECT codigo_acceso, estado_suscripcion, suspendida_en FROM empresas WHERE id = $1',
        [empresaId],
      )
    ).rows[0];
    if (!empresa) throw errores.noEncontrado('Establecimiento no encontrado');
    if (empresa.estado_suscripcion === 'cancelada') throw errores.conflicto('Este negocio está cancelado y no se puede activar.');
    if (empresa.suspendida_en) throw errores.prohibido('Negocio suspendido; contacta a soporte');
    const { cobrados } = await contarEquipoCobrable(pool, empresaId);
    if (entrada.profesionales < cobrados) {
      throw errores.conflicto(
        `Tienes ${cobrados} profesional(es) que atienden clientes: elige al menos ${cobrados}, o quita primero a quien ya no trabaje en el negocio.`,
      );
    }
    const monto = precioPara(entrada.profesionales, entrada.periodo);
    const montoCentavos = monto * 100;
    const referencia = `AGD-${Date.now().toString(36)}-${randomBytes(12).toString('hex')}`.toUpperCase();
    const { url } = await pasarela.crearPago({
      referencia,
      montoCentavos,
      moneda: 'COP',
      urlRegreso: `${urlPagos}/${encodeURIComponent(referencia)}`,
    });
    await pool.query(
      `INSERT INTO ordenes_pago (referencia, empresa_id, empresa_codigo, proveedor, profesionales, periodo, monto_centavos)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [referencia, empresaId, empresa.codigo_acceso, pasarela.nombre, entrada.profesionales, entrada.periodo, montoCentavos],
    );
    return {
      referencia,
      proveedor: pasarela.nombre,
      profesionales: entrada.profesionales,
      periodo: entrada.periodo,
      monto,
      moneda: 'COP',
      estado: 'pendiente' as const,
      urlPago: url,
    };
  };

  const buscarOrden = async (empresaId: string, referencia: string) => {
    const f = (
      await pool.query<FilaOrden>(`SELECT ${COLUMNAS} FROM ordenes_pago WHERE referencia = $1 AND empresa_id = $2`, [referencia, empresaId])
    ).rows[0];
    if (!f) throw errores.noEncontrado('Orden no encontrada');
    return f;
  };

  // Aplica lo que dijo la pasarela, dentro de una transacción con la orden bloqueada: así dos confirmaciones a la
  // vez (volver a la app + webhook) no activan dos veces. El plan solo se activa si la pasarela dice "aprobada" Y la
  // referencia, el monto y la moneda coinciden con la orden. Una orden que ya salió de "pendiente" no se vuelve a tocar.
  const aplicar = (referencia: string, resultado: ResultadoPago | null) =>
    aplicarEnTransaccion(referencia, resultado).catch((error) => {
      // Una transacción de la pasarela solo puede pagar una orden (índice único en id_externo)
      if ((error as { code?: string }).code === '23505') {
        throw errores.conflicto('Esa transacción de la pasarela ya está asociada a otra orden. No se activó el plan: comunícate con soporte.');
      }
      throw error;
    });

  const aplicarEnTransaccion = (referencia: string, resultado: ResultadoPago | null) =>
    enTransaccion(pool, async (tx) => {
      const f = (await tx.query<FilaOrden>(`SELECT ${COLUMNAS} FROM ordenes_pago WHERE referencia = $1 FOR UPDATE`, [referencia])).rows[0];
      if (!f) throw errores.noEncontrado('Orden no encontrada');
      // Un rechazo o una anulación no cierra la orden: en Web Checkout la persona puede reintentar con la misma
      // referencia y pagar después. Una aprobación posterior sí la activa; una orden ya aprobada no se toca, y un
      // resultado que no es aprobado nunca cambia una orden que ya salió de "pendiente".
      const abierta = f.estado === 'pendiente' || (f.estado !== 'aprobada' && resultado?.estado === 'aprobada');
      if (!abierta || !resultado || resultado.estado === 'pendiente') return { orden: aOrden(f), inconsistente: false };

      const coincide =
        resultado.referencia === f.referencia && resultado.montoCentavos === Number(f.monto_centavos) && resultado.moneda === f.moneda;
      if (!coincide) {
        // Lo cobrado no es lo que se pidió: no se activa nada. Queda para revisión de soporte.
        registro.warn('pago_inconsistente', { referencia: f.referencia, proveedor: f.proveedor, estadoPasarela: resultado.estado });
        return { orden: aOrden(f), inconsistente: true };
      }
      if (resultado.estado !== 'aprobada') {
        const g = (
          await tx.query<FilaOrden>(
            `UPDATE ordenes_pago SET estado = $2, id_externo = COALESCE($3, id_externo), actualizada_en = now()
             WHERE id = $1 RETURNING ${COLUMNAS}`,
            [f.id, resultado.estado, resultado.idExterno],
          )
        ).rows[0];
        return { orden: aOrden(g), inconsistente: false };
      }

      const activada = await activarPlanEmpresa(tx, f.empresa_id, f.periodo, 'pasarela', {
        profesionales: f.profesionales,
        precio: Number(f.monto_centavos) / 100,
      });
      if (!activada) throw errores.noEncontrado('Establecimiento no encontrado');
      const g = (
        await tx.query<FilaOrden>(
          `UPDATE ordenes_pago SET estado = 'aprobada', id_externo = $2, activada_en = now(), actualizada_en = now()
           WHERE id = $1 RETURNING ${COLUMNAS}`,
          [f.id, resultado.idExterno],
        )
      ).rows[0];
      const empresa = (await tx.query<{ nombre: string }>('SELECT nombre FROM empresas WHERE id = $1', [f.empresa_id])).rows[0];
      await registrarActividad(tx, {
        superadminId: 'sistema',
        superadminCorreo: `pasarela:${f.proveedor}`,
        accion: 'pago_aprobado',
        empresa: { id: f.empresa_id, codigo_acceso: f.empresa_codigo ?? '', nombre: empresa?.nombre ?? '' },
        referencia: f.referencia,
        detalle: { periodo: f.periodo, profesionales: f.profesionales, monto: Number(f.monto_centavos) / 100, idExterno: resultado.idExterno },
      });
      return { orden: aOrden(g), inconsistente: false };
    });

  // Pregunta a la pasarela y aplica el resultado. Es seguro repetirla.
  const confirmarFila = async (orden: FilaOrden, idExterno?: string) => {
    const pasarela = requerirProveedor();
    // Solo una orden aprobada es definitiva; una rechazada o anulada se vuelve a preguntar (puede haber un reintento).
    // Una orden manual no tiene pasarela a la que preguntar: su estado lo decide el superadmin.
    if (orden.estado === 'aprobada' || orden.proveedor === 'manual') return aOrden(orden);
    const resultado = await pasarela.consultarPago({ referencia: orden.referencia, idExterno: idExterno ?? orden.id_externo });
    const { orden: final, inconsistente } = await aplicar(orden.referencia, resultado);
    if (inconsistente) {
      throw errores.conflicto('El pago no coincide con la orden (monto o referencia). No se activó el plan: comunícate con soporte.');
    }
    return final;
  };

  // Al volver del pago: pregunta a la pasarela y aplica el resultado. Es seguro repetirla.
  const confirmar = async (empresaId: string, referencia: string, idExterno?: string) => {
    requerirProveedor();
    return confirmarFila(await buscarOrden(empresaId, referencia), idExterno);
  };

  // Resultado público (sin sesión): la referencia es larga y aleatoria, y solo se responde el estado, el nivel y el
  // vencimiento cuando está aprobada. Nada de montos ni datos de personas.
  const estadoPublico = async (referencia: string, idExterno?: string) => {
    requerirProveedor();
    const f = (await pool.query<FilaOrden>(`SELECT ${COLUMNAS} FROM ordenes_pago WHERE referencia = $1`, [referencia])).rows[0];
    if (!f) throw errores.noEncontrado('Orden no encontrada');
    const orden = await confirmarFila(f, idExterno);
    if (orden.estado === 'pendiente') return { estado: 'pendiente' as EstadoPublico };
    if (orden.estado !== 'aprobada') return { estado: 'rechazado' as EstadoPublico };
    const e = (
      await pool.query<{ plan_equipo: string; suscripcion_fin: string | null }>(
        "SELECT plan_equipo, to_char(suscripcion_fin, 'YYYY-MM-DD') AS suscripcion_fin FROM empresas WHERE id = $1",
        [f.empresa_id],
      )
    ).rows[0];
    const plan = e ? buscarPlan(e.plan_equipo) : undefined;
    return {
      estado: 'aprobado' as EstadoPublico,
      nivel: plan ? { id: plan.id, nombre: plan.nombre } : null,
      vencimiento: e?.suscripcion_fin ?? null,
    };
  };

  // Para que la app sepa si debe avisar que los pagos son de prueba. Nunca expone llaves.
  const configuracion = () => ({
    disponible: Boolean(proveedor),
    proveedor: proveedor?.nombre ?? null,
    esDePrueba: Boolean(proveedor) && esDePrueba,
  });

  const consultar = async (empresaId: string, referencia: string) => aOrden(await buscarOrden(empresaId, referencia));

  // Webhook de la pasarela: la firma se verifica en el proveedor y el evento solo dice qué orden mirar; el estado se
  // vuelve a pedir a la pasarela. Devuelve false si la firma no es válida (la ruta responde 401).
  const procesarEvento = async (cuerpo: unknown): Promise<boolean> => {
    if (!proveedor?.verificarEvento) return false;
    const evento = await proveedor.verificarEvento(cuerpo);
    if (!evento) return false;
    const existe = (await pool.query('SELECT 1 FROM ordenes_pago WHERE referencia = $1 AND proveedor = $2', [evento.referencia, proveedor.nombre])).rowCount;
    // Una referencia que no es nuestra (la cuenta puede tener otros cobros) se reconoce y se ignora
    if (!existe) return true;
    const resultado = await proveedor.consultarPago({ referencia: evento.referencia, idExterno: evento.idExterno });
    await aplicar(evento.referencia, resultado);
    return true;
  };

  return { crearOrden, confirmar, consultar, procesarEvento, estadoPublico, configuracion };
};

export type ServicioPagos = ReturnType<typeof crearServicioPagos>;
