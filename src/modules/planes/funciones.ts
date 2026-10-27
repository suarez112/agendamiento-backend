import { type RequestHandler, Router } from 'express';
import type pg from 'pg';
import { FUNCIONES, type IdFuncion, incluyeFuncion, planDeFuncion } from '../../config/funciones.js';
import { buscarPlan, COBRO, PLANES, precioPara, precioPuesto } from '../../config/planes.js';
import type { Consultable } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import { sesionDe } from '../auth/guardias.js';
import type { Guardias } from '../auth/guardias.js';
import { contarEquipoCobrable } from '../empresas/cobro.js';
import { empresaDeSesion } from '../empresas/suscripcion.js';

// Nivel de la empresa (automático según sus profesionales cobrados). En la prueba gratuita también cuenta
// el número de empleados del registro (se calcula al registrar, al cambiar numeroEmpleados y al cambiar el equipo).
const planDeEmpresa = async (db: Consultable, empresaId: string) => {
  const { rows } = await db.query<{ plan_equipo: string; estado_suscripcion: string }>(
    'SELECT plan_equipo, estado_suscripcion FROM empresas WHERE id = $1',
    [empresaId],
  );
  if (!rows[0]) throw errores.noEncontrado('Establecimiento no encontrado');
  return { plan: buscarPlan(rows[0].plan_equipo) ?? PLANES[PLANES.length - 1], enPrueba: rows[0].estado_suscripcion === 'trial' };
};

// 403 con código "funcion_no_incluida" y el plan que sí incluye la función
export const funcionNoIncluida = (funcion: IdFuncion) => {
  const plan = planDeFuncion(funcion);
  return errores.prohibido(
    `La función «${FUNCIONES[funcion].nombre}» no está incluida en tu nivel. Está disponible desde el nivel ${plan.nombre}.`,
    { codigo: 'funcion_no_incluida', funcion, planRequerido: { id: plan.id, nombre: plan.nombre }, nivelRequerido: { id: plan.id, nombre: plan.nombre } },
  );
};

export const crearServicioFunciones = ({ pool }: { pool: pg.Pool }) => {
  const incluida = async (empresaId: string, funcion: IdFuncion) =>
    incluyeFuncion((await planDeEmpresa(pool, empresaId)).plan.id, funcion);

  return {
    incluida,

    // Lanza 403 si el plan de la empresa no incluye la función
    async exigir(empresaId: string, funcion: IdFuncion) {
      if (!(await incluida(empresaId, funcion))) throw funcionNoIncluida(funcion);
    },

    // Nivel, funciones y precio actual del negocio (según los profesionales que atienden clientes hoy)
    async deEmpresa(empresaId: string) {
      const { plan, enPrueba } = await planDeEmpresa(pool, empresaId);
      const { cobrados, adminsSinAtender } = await contarEquipoCobrable(pool, empresaId);
      return {
        plan: { id: plan.id, nombre: plan.nombre, cupo: plan.cupo },
        // Mismo dato que "plan": el nivel que se asigna solo según los profesionales cobrados
        nivel: { id: plan.id, nombre: plan.nombre, profesionalesDesde: plan.personasDesde, profesionalesHasta: plan.cupo },
        enPrueba,
        profesionales: {
          cobrados,
          maximo: COBRO.maxProfesionales,
          adminsSinAtender,
          maximoAdminsSinAtender: COBRO.maxAdminsSinAtender,
        },
        precio: {
          moneda: 'COP',
          mensual: precioPara(cobrados, 'mensual'),
          anual: precioPara(cobrados, 'anual'),
          // Lo que costaría el siguiente profesional (cargo completo del periodo, antes de prorratear)
          siguienteProfesionalMensual: cobrados >= COBRO.maxProfesionales ? null : precioPuesto(cobrados + 1, 'mensual'),
          siguienteProfesionalAnual: cobrados >= COBRO.maxProfesionales ? null : precioPuesto(cobrados + 1, 'anual'),
        },
        funciones: (Object.keys(FUNCIONES) as IdFuncion[]).map((id) => {
          const minimo = planDeFuncion(id);
          return {
            id,
            nombre: FUNCIONES[id].nombre,
            incluida: incluyeFuncion(plan.id, id),
            planRequerido: { id: minimo.id, nombre: minimo.nombre },
          };
        }),
      };
    },
  };
};

export type ServicioFunciones = ReturnType<typeof crearServicioFunciones>;

// Middleware: va después de la guardia de sesión
export const requerirFuncion =
  (funciones: ServicioFunciones, funcion: IdFuncion): RequestHandler =>
  async (_req, res, next) => {
    await funciones.exigir(empresaDeSesion(res), funcion);
    next();
  };

// GET /api/v1/funciones: funciones del plan del negocio (cualquier sesión del personal o la administradora;
// responde aunque la suscripción esté vencida)
export const crearRutasFunciones = (funciones: ServicioFunciones, guardias: Guardias) => {
  const rutas = Router();
  rutas.get('/', guardias.requerirSesion, async (_req, res) => {
    res.json(await funciones.deEmpresa(sesionDe(res).empresaId));
  });
  return rutas;
};
