import { COBRO, planParaPersonas, precioPuesto, type Periodo } from '../../config/planes.js';
import { ZONA_PLATAFORMA } from '../../config/plataforma.js';
import type { Consultable } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';

// Cobro por profesional. Cobrados = integrantes activos que atienden clientes. Los administradores que no
// atienden no se cobran (hasta COBRO.maxAdminsSinAtender por negocio). Ver src/config/planes.ts.

export type ConteoEquipo = { cobrados: number; adminsSinAtender: number };

export const contarEquipoCobrable = async (db: Consultable, empresaId: string): Promise<ConteoEquipo> => {
  const f = (
    await db.query<{ cobrados: number; admins_sin_atender: number }>(
      `SELECT count(*) FILTER (WHERE atiende_clientes)::int AS cobrados,
              count(*) FILTER (WHERE NOT atiende_clientes AND es_admin)::int AS admins_sin_atender
       FROM barberos WHERE empresa_id = $1 AND activo`,
      [empresaId],
    )
  ).rows[0];
  return { cobrados: f.cobrados, adminsSinAtender: f.admins_sin_atender };
};

export const MENSAJE_MAXIMO = `Un negocio puede tener hasta ${COBRO.maxProfesionales} profesionales que atienden clientes. Para agregar a alguien más, quita primero a quien ya no trabaje en el negocio.`;
export const MENSAJE_MAXIMO_ADMINS = `Solo puedes tener hasta ${COBRO.maxAdminsSinAtender} administradores que no atienden clientes.`;
export const MENSAJE_SOLO_ADMIN_SIN_ATENDER = 'Solo un administrador puede no atender clientes. Un empleado debe atender clientes.';

// Verifica los topes con el conteo ANTES del cambio y lo que el cambio suma a cada número (+1 o -1)
export const validarTopes = (antes: ConteoEquipo, cambio: { cobrados?: number; adminsSinAtender?: number }) => {
  const cobrados = cambio.cobrados ?? 0;
  const admins = cambio.adminsSinAtender ?? 0;
  if (cobrados > 0 && antes.cobrados + cobrados > COBRO.maxProfesionales) throw errores.conflicto(MENSAJE_MAXIMO);
  if (admins > 0 && antes.adminsSinAtender + admins > COBRO.maxAdminsSinAtender) {
    throw errores.conflicto(MENSAJE_MAXIMO_ADMINS);
  }
};

type FilaCobro = {
  codigo_acceso: string;
  nombre: string;
  estado_suscripcion: string;
  numero_empleados: number;
  plan_suscripcion: Periodo | null;
  pagados: number;
  dias_restantes: number | null;
  dias_periodo: number | null;
};

// Debe correr dentro de la transacción que cambió al equipo, con la empresa bloqueada (FOR UPDATE):
// 1) recalcula el nivel con los profesionales cobrados (en la prueba, también el número de empleados del registro);
// 2) si el plan está pagado y vigente y los cobrados superan lo ya pagado, crea un cargo 'pendiente' por cada
//    profesional de más, proporcional a los días que faltan del periodo (mínimo COBRO.cargoProporcionalMinimo).
//    Reemplazar a alguien sin pasar de lo ya pagado no cuesta. Quitar a alguien no devuelve nada.
export const reajustarCobro = async (db: Consultable, empresaId: string, barberoId: string | null = null) => {
  const f = (
    await db.query<FilaCobro>(
      `SELECT e.codigo_acceso, e.nombre, e.estado_suscripcion, e.numero_empleados, e.plan_suscripcion,
              e.profesionales_pagados AS pagados,
              CASE WHEN e.estado_suscripcion = 'activa' THEN e.suscripcion_fin - h.hoy END AS dias_restantes,
              CASE WHEN e.estado_suscripcion = 'activa'
                   THEN e.suscripcion_fin - (e.suscripcion_fin - CASE e.plan_suscripcion WHEN 'anual' THEN interval '1 year' ELSE interval '1 month' END)::date
              END AS dias_periodo
       FROM empresas e
       CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE e.zona_horaria)::date AS hoy) h
       WHERE e.id = $1`,
      [empresaId],
    )
  ).rows[0];
  if (!f) return;
  const { cobrados } = await contarEquipoCobrable(db, empresaId);
  const nivel = planParaPersonas(Math.max(cobrados, f.estado_suscripcion === 'trial' ? f.numero_empleados : 0));
  await db.query('UPDATE empresas SET plan_equipo = $2 WHERE id = $1', [empresaId, nivel.id]);

  // Sin plan pagado y vigente (prueba, vencido o activo antiguo sin fecha de fin) no hay periodo que prorratear
  if (!f.plan_suscripcion || !f.dias_periodo || f.dias_restantes === null || f.dias_restantes <= 0) return;
  if (cobrados <= f.pagados) return;
  for (let k = f.pagados + 1; k <= cobrados; k++) {
    const completo = precioPuesto(k, f.plan_suscripcion);
    const proporcional = Math.max(COBRO.cargoProporcionalMinimo, Math.round((completo * f.dias_restantes) / f.dias_periodo));
    await db.query(
      `INSERT INTO cargos (empresa_id, empresa_codigo, empresa_nombre, barbero_id, concepto, periodo, dias_restantes, dias_periodo, monto, fecha)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, (now() AT TIME ZONE '${ZONA_PLATAFORMA}')::date)`,
      [
        empresaId,
        f.codigo_acceso,
        f.nombre,
        barberoId,
        `Profesional ${k} del plan ${f.plan_suscripcion}: ${f.dias_restantes} de ${f.dias_periodo} días`,
        f.plan_suscripcion,
        f.dias_restantes,
        f.dias_periodo,
        proporcional,
      ],
    );
  }
  await db.query('UPDATE empresas SET profesionales_pagados = $2 WHERE id = $1', [empresaId, cobrados]);
};

// Marca como pagados los cargos pendientes de una empresa (o uno solo). Devuelve los que cambió.
export const marcarCargosPagados = async (
  db: Consultable,
  empresaId: string,
  pagadoPor: 'comando' | 'activacion' | 'panel',
  cargoId?: string,
) =>
  (
    await db.query<{ id: string; concepto: string; monto: string }>(
      `UPDATE cargos
       SET estado = 'pagado', pagado_en = now(), fecha_pago = (now() AT TIME ZONE '${ZONA_PLATAFORMA}')::date, pagado_por = $2
       WHERE empresa_id = $1 AND estado = 'pendiente' AND ($3::bigint IS NULL OR id = $3::bigint)
       RETURNING id, concepto, monto`,
      [empresaId, pagadoPor, cargoId ?? null],
    )
  ).rows;
