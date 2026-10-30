import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { ZONA_PLATAFORMA } from '../../config/plataforma.js';
import { COBRO, type Periodo, planParaPersonas, precioPara } from '../../config/planes.js';
import { enTransaccion } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import { aIsoEnZona } from '../../shared/zonaHoraria.js';
import { activarPlanEmpresa } from '../empresas/activacion.js';
import { contarEquipoCobrable } from '../empresas/cobro.js';
import { registrarActividad } from '../superadmin/superadmin.repositorio.js';
import type { SesionSuperadmin } from '../superadmin/superadmin.servicio.js';
import type { ServicioFormasPago } from './formasPago.servicio.js';
import type { EstadoPago } from './proveedor.js';

// Pagos manuales: el administrador del negocio crea una orden, paga por Nequi, llave Bre-B o código QR, envía el
// comprobante por WhatsApp y el superadmin la aprueba o la rechaza. Una orden manual en estado 'pendiente' está
// "pendiente de verificación". El monto siempre lo calcula el servidor.

export const TEXTO_PENDIENTE = 'Pendiente de verificación';

type FilaOrdenManual = {
  id: string;
  referencia: string;
  empresa_id: string;
  empresa_codigo: string | null;
  profesionales: number;
  periodo: Periodo;
  monto_centavos: string;
  moneda: string;
  estado: EstadoPago;
  creada_en: Date;
  revisada_en: Date | null;
  revisada_por_correo: string | null;
  motivo_revision: string | null;
  activada_en: Date | null;
};

const COLUMNAS = `id, referencia, empresa_id, empresa_codigo, profesionales, periodo, monto_centavos, moneda, estado, creada_en,
  revisada_en, revisada_por_correo, motivo_revision, activada_en`;

const TEXTO_ESTADO: Record<EstadoPago, string> = {
  pendiente: TEXTO_PENDIENTE,
  aprobada: 'Aprobada',
  rechazada: 'Rechazada',
  anulada: 'Anulada',
};

// Avisos al administrador del negocio (notificación en la app y push). Opcional: sin él solo se omiten los avisos.
export type AvisosPagoManual = { avisarPagoManual(empresaId: string, aprobado: boolean): Promise<void> };

type Dependencias = { pool: pg.Pool; formas: ServicioFormasPago; avisos?: AvisosPagoManual };

export const crearServicioPagosManuales = ({ pool, formas, avisos }: Dependencias) => {
  const resumen = (f: FilaOrdenManual) => ({
    referencia: f.referencia,
    proveedor: 'manual' as const,
    profesionales: f.profesionales,
    plan: { id: planParaPersonas(f.profesionales).id, nombre: planParaPersonas(f.profesionales).nombre },
    periodo: f.periodo,
    monto: Number(f.monto_centavos) / 100,
    moneda: f.moneda,
    estado: f.estado,
    estadoTexto: TEXTO_ESTADO[f.estado],
    creadaEn: aIsoEnZona(f.creada_en, ZONA_PLATAFORMA),
    zonaHoraria: ZONA_PLATAFORMA,
  });

  const nombreDelNegocio = async (db: pg.Pool | pg.PoolClient, empresaId: string) =>
    (await db.query<{ nombre: string; codigo_acceso: string }>('SELECT nombre, codigo_acceso FROM empresas WHERE id = $1', [empresaId])).rows[0];

  // Orden completa para la app: con lo necesario para armar el mensaje de WhatsApp (negocio, plan, periodo, monto,
  // formas de pago activas y número de WhatsApp). Mientras está pendiente incluye cómo pagar; después, el resultado.
  const armarParaApp = async (f: FilaOrdenManual, urlBase: string) => {
    const negocio = await nombreDelNegocio(pool, f.empresa_id);
    const base = {
      ...resumen(f),
      negocio: { nombre: negocio?.nombre ?? '', codigoAcceso: negocio?.codigo_acceso ?? f.empresa_codigo ?? '' },
    };
    if (f.estado === 'pendiente') return { ...base, pago: await formas.activasObligatorias(urlBase) };
    return { ...base, motivoRevision: f.motivo_revision, revisadaEn: aIsoEnZona(f.revisada_en, ZONA_PLATAFORMA) };
  };

  // El administrador crea la orden. Solo llega el periodo: los profesionales y el monto salen del servidor.
  const crearOrden = async (empresaId: string, entrada: { periodo: Periodo }, urlBase: string) => {
    // Sin formas de pago configuradas no se crea nada (503)
    await formas.activasObligatorias(urlBase);
    const fila = await enTransaccion(pool, async (tx) => {
      // Bloquea al negocio: dos solicitudes a la vez se ordenan y la segunda anula a la primera
      const empresa = (
        await tx.query<{ codigo_acceso: string; estado_suscripcion: string; suspendida_en: Date | null }>(
          'SELECT codigo_acceso, estado_suscripcion, suspendida_en FROM empresas WHERE id = $1 FOR UPDATE',
          [empresaId],
        )
      ).rows[0];
      if (!empresa) throw errores.noEncontrado('Establecimiento no encontrado');
      if (empresa.estado_suscripcion === 'cancelada') throw errores.conflicto('Este negocio está cancelado y no se puede activar.');
      if (empresa.suspendida_en) throw errores.prohibido('Negocio suspendido; contacta a soporte');
      const { cobrados } = await contarEquipoCobrable(tx, empresaId);
      const profesionales = Math.min(Math.max(cobrados, 1), COBRO.maxProfesionales);
      const montoCentavos = precioPara(profesionales, entrada.periodo) * 100;
      await tx.query(
        `UPDATE ordenes_pago
         SET estado = 'anulada', motivo_revision = 'Reemplazada por una orden nueva', actualizada_en = now()
         WHERE empresa_id = $1 AND proveedor = 'manual' AND estado = 'pendiente'`,
        [empresaId],
      );
      const referencia = `AGD-${Date.now().toString(36)}-${randomBytes(12).toString('hex')}`.toUpperCase();
      return (
        await tx.query<FilaOrdenManual>(
          `INSERT INTO ordenes_pago (referencia, empresa_id, empresa_codigo, proveedor, profesionales, periodo, monto_centavos)
           VALUES ($1, $2, $3, 'manual', $4, $5, $6) RETURNING ${COLUMNAS}`,
          [referencia, empresaId, empresa.codigo_acceso, profesionales, entrada.periodo, montoCentavos],
        )
      ).rows[0];
    });
    return armarParaApp(fila, urlBase);
  };

  // Un negocio solo ve sus propias órdenes: el negocio sale de la sesión y la consulta lo filtra.
  // undefined = no es una orden manual de este negocio.
  const consultar = async (empresaId: string, referencia: string, urlBase: string) => {
    const f = (
      await pool.query<FilaOrdenManual>(
        `SELECT ${COLUMNAS} FROM ordenes_pago WHERE referencia = $1 AND empresa_id = $2 AND proveedor = 'manual'`,
        [referencia, empresaId],
      )
    ).rows[0];
    return f ? armarParaApp(f, urlBase) : undefined;
  };

  const listarDelNegocio = async (empresaId: string) =>
    (
      await pool.query<FilaOrdenManual>(
        `SELECT ${COLUMNAS} FROM ordenes_pago WHERE empresa_id = $1 AND proveedor = 'manual' ORDER BY creada_en DESC, id DESC LIMIT 20`,
        [empresaId],
      )
    ).rows.map((f) => ({ ...resumen(f), motivoRevision: f.motivo_revision }));

  // ---- Superadmin ----

  type FilaLista = FilaOrdenManual & {
    negocio_nombre: string | null;
    administradora: string | null;
    correo_administradora: string | null;
    whatsapp_contacto: string | null;
  };

  const listarParaSuperadmin = async (filtro: { estado: EstadoPago; limite: number; desplazamiento: number }) => {
    const [filas, total] = await Promise.all([
      pool.query<FilaLista>(
        `SELECT o.id, o.referencia, o.empresa_id, o.empresa_codigo, o.profesionales, o.periodo, o.monto_centavos, o.moneda, o.estado,
                o.creada_en, o.revisada_en, o.revisada_por_correo, o.motivo_revision, o.activada_en,
                e.nombre AS negocio_nombre, e.nombre_administradora AS administradora, e.whatsapp_contacto,
                (SELECT u.correo FROM usuarios u WHERE u.empresa_id = o.empresa_id AND u.rol = 'admin' AND u.correo IS NOT NULL
                 ORDER BY u.created_at LIMIT 1) AS correo_administradora
         FROM ordenes_pago o LEFT JOIN empresas e ON e.id = o.empresa_id
         WHERE o.proveedor = 'manual' AND o.estado = $1
         ORDER BY o.creada_en ASC, o.id ASC LIMIT $2 OFFSET $3`,
        [filtro.estado, filtro.limite, filtro.desplazamiento],
      ),
      pool.query<{ total: number }>("SELECT count(*)::int AS total FROM ordenes_pago WHERE proveedor = 'manual' AND estado = $1", [filtro.estado]),
    ]);
    return {
      total: total.rows[0].total,
      datos: filas.rows.map((f) => ({
        ...resumen(f),
        negocio: { id: f.empresa_id, codigoAcceso: f.empresa_codigo, nombre: f.negocio_nombre },
        contacto: { administradora: f.administradora, correo: f.correo_administradora, whatsapp: f.whatsapp_contacto },
        revisadaPor: f.revisada_por_correo,
        revisadaEn: aIsoEnZona(f.revisada_en, ZONA_PLATAFORMA),
        motivoRevision: f.motivo_revision,
      })),
    };
  };

  // Aprobar y rechazar bloquean la orden (FOR UPDATE) y solo actúan si sigue 'pendiente': dos clics o dos solicitudes
  // a la vez no activan dos veces (la segunda espera, ve la orden ya cerrada y responde 409).
  const revisar = async (admin: SesionSuperadmin, referencia: string, aprobar: boolean, motivo: string | undefined) => {
    const resultado = await enTransaccion(pool, async (tx) => {
      const f = (
        await tx.query<FilaOrdenManual>(`SELECT ${COLUMNAS} FROM ordenes_pago WHERE referencia = $1 AND proveedor = 'manual' FOR UPDATE`, [referencia])
      ).rows[0];
      if (!f) throw errores.noEncontrado('Orden no encontrada');
      if (f.estado !== 'pendiente') {
        throw errores.conflicto(`Esta orden ya está ${TEXTO_ESTADO[f.estado].toLowerCase()}: no se puede ${aprobar ? 'aprobar' : 'rechazar'} otra vez.`);
      }
      const empresa = await nombreDelNegocio(tx, f.empresa_id);
      if (aprobar) {
        const estadoEmpresa = (
          await tx.query<{ estado_suscripcion: string; suspendida: boolean }>(
            'SELECT estado_suscripcion, suspendida_en IS NOT NULL AS suspendida FROM empresas WHERE id = $1',
            [f.empresa_id],
          )
        ).rows[0];
        if (!estadoEmpresa) throw errores.noEncontrado('Establecimiento no encontrado');
        if (estadoEmpresa.estado_suscripcion === 'cancelada') throw errores.conflicto('Este negocio está cancelado y no se puede activar.');
        // Rechazar sí se puede con el negocio suspendido; aprobar no: la orden se crea sin suspensión y puede cambiar después
        if (estadoEmpresa.suspendida) throw errores.conflicto('Este negocio está suspendido. Reactívalo primero si quieres aprobar el pago.');
        const activada = await activarPlanEmpresa(tx, f.empresa_id, f.periodo, 'manual', {
          profesionales: f.profesionales,
          precio: Number(f.monto_centavos) / 100,
        });
        if (!activada) throw errores.noEncontrado('Establecimiento no encontrado');
      }
      const g = (
        await tx.query<FilaOrdenManual>(
          `UPDATE ordenes_pago
           SET estado = $2::varchar, activada_en = CASE WHEN $2::varchar = 'aprobada' THEN now() END,
               revisada_por_id = $3, revisada_por_correo = $4, revisada_en = now(), motivo_revision = $5, actualizada_en = now()
           WHERE id = $1 RETURNING ${COLUMNAS}`,
          [f.id, aprobar ? 'aprobada' : 'rechazada', admin.id, admin.correo, motivo ?? null],
        )
      ).rows[0];
      await registrarActividad(tx, {
        superadminId: admin.id,
        superadminCorreo: admin.correo,
        accion: aprobar ? 'aprobar_pago_manual' : 'rechazar_pago_manual',
        empresa: { id: f.empresa_id, codigo_acceso: empresa?.codigo_acceso ?? f.empresa_codigo ?? '', nombre: empresa?.nombre ?? '' },
        referencia: f.referencia,
        detalle: { periodo: f.periodo, profesionales: f.profesionales, monto: Number(f.monto_centavos) / 100 },
        motivo: motivo ?? null,
      });
      return g;
    });
    // Después de guardar: un fallo del aviso nunca deshace la decisión (el servicio de avisos solo registra el error)
    await avisos?.avisarPagoManual(resultado.empresa_id, aprobar);
    return {
      mensaje: aprobar ? 'Pago aprobado: la suscripción quedó activa' : 'Pago rechazado: la suscripción no cambió',
      orden: { ...resumen(resultado), motivoRevision: resultado.motivo_revision, revisadaPor: resultado.revisada_por_correo },
    };
  };

  return {
    crearOrden,
    consultar,
    listarDelNegocio,
    listarParaSuperadmin,
    aprobar: (admin: SesionSuperadmin, referencia: string, motivo?: string) => revisar(admin, referencia, true, motivo),
    rechazar: (admin: SesionSuperadmin, referencia: string, motivo: string) => revisar(admin, referencia, false, motivo),
  };
};

export type ServicioPagosManuales = ReturnType<typeof crearServicioPagosManuales>;
