import dotenv from 'dotenv';
import { cargarEntornoBaseDeDatos } from '../config/entorno.js';
import { buscarPlan, precioPara } from '../config/planes.js';
import { activarPlanEmpresa } from '../modules/empresas/activacion.js';
import { buscarSuscripcion } from '../modules/empresas/empresas.repositorio.js';
import { ErrorApp } from '../shared/errores.js';
import { crearPool, enTransaccion } from './pool.js';

// npm run dev:activar-plan -- CODIGO mensual|anual
// Activa (o renueva) el plan de una empresa sin pagos reales (no hay pasarela de pagos todavía).
// El precio sale de los profesionales que atienden clientes ahora (el primero $35.000 y cada adicional $25.000
// al mes, mínimo uno; el anual es × 12 con 10 % de descuento) y el nivel (Emprendedor, Equipo, Pro), de ese número.
// Los cargos proporcionales pendientes del negocio quedan pagados (el equipo actual ya va en el precio).
// La fecha de pago es hoy (fecha en la zona horaria del negocio) y la empresa queda 'activa' de inmediato.
// El plan dura 1 mes o 1 año contados desde:
// - el fin de la prueba, si paga durante la prueba (no pierde los días gratis que le
//   quedaban; se guardan en dias_prueba_sumados),
// - el fin del plan actual, si renueva antes de que venza (no pierde días),
// - hoy, en cualquier otro caso.
dotenv.config({ quiet: true });

const USO = `Uso: npm run dev:activar-plan -- CODIGO periodo

  CODIGO   código del negocio (sin distinguir mayúsculas)
  periodo  mensual | anual

El precio y el nivel salen de los profesionales que atienden clientes.
Ejemplo: npm run dev:activar-plan -- INFINITY anual`;
const argumentos = process.argv.slice(2).map((a) => a.trim().toLowerCase());
const codigo = argumentos[0]?.toUpperCase();
const plan = argumentos[1];

if (!codigo || argumentos.length !== 2 || (plan !== 'mensual' && plan !== 'anual')) {
  console.error(USO);
  process.exit(1);
}

const pool = crearPool(cargarEntornoBaseDeDatos());

try {
  const rows = await enTransaccion(pool, async (tx) => {
    const empresa = (
      await tx.query<{ id: string; nombre: string }>('SELECT id, nombre FROM empresas WHERE codigo_acceso = $1', [codigo])
    ).rows[0];
    if (!empresa) return [];
    await activarPlanEmpresa(tx, empresa.id, plan);
    return [empresa];
  });
  if (rows.length === 0) {
    console.error(`No existe un negocio con el código ${codigo}`);
    process.exitCode = 1;
  } else {
    const s = (await buscarSuscripcion(pool, rows[0].id))!;
    console.log(
      `✔ ${rows[0].nombre} (${codigo}): nivel ${buscarPlan(s.plan_equipo)?.nombre ?? s.plan_equipo}, plan ${s.plan} activo ` +
        `(${s.profesionales_cobrados} profesional(es) cobrado(s), ${precioPara(s.profesionales_cobrados, plan).toLocaleString('es-CO')} COP). ` +
        `Pago: ${s.fecha_pago}. Fin: ${s.fecha_fin}. Días restantes: ${s.dias_restantes}.` +
        (s.dias_prueba_sumados ? ` Días de prueba sumados: ${s.dias_prueba_sumados}.` : ''),
    );
  }
} catch (error) {
  console.error(error instanceof ErrorApp ? `✖ ${error.message}` : (error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
