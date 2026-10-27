import dotenv from 'dotenv';
import { cargarEntornoBaseDeDatos } from '../config/entorno.js';
import { buscarSuscripcion } from '../modules/empresas/empresas.repositorio.js';
import { estadoEfectivo } from '../modules/empresas/suscripcion.js';
import { negarEnProduccion, registrarComando } from './comandos.js';
import { crearPool } from './pool.js';

// npm run dev:simular-vencimiento -- CODIGO DIAS
// Solo en desarrollo: deja a la empresa con DIAS días restantes de su prueba o de
// su plan (0 o negativo = vencida), para probar recordatorios y bloqueos sin esperar.
// Cambia la fecha de fin; el estado se calcula a partir de ella.
dotenv.config({ quiet: true });

negarEnProduccion('dev:simular-vencimiento');

const USO = 'Uso: npm run dev:simular-vencimiento -- CODIGO DIAS   (ej. 3, 0 o -2)';
const [codigoArg, diasArg] = process.argv.slice(2);
const codigo = codigoArg?.trim().toUpperCase();
const dias = Number(diasArg);

if (!codigo || diasArg === undefined || !Number.isInteger(dias) || Math.abs(dias) > 3660) {
  console.error(USO);
  process.exit(1);
}

const pool = crearPool(cargarEntornoBaseDeDatos());

try {
  // Prueba: el fin queda a DIAS días de ahora (misma hora). Plan: a DIAS días de hoy en la zona del negocio.
  const { rows } = await pool.query<{ id: string; nombre: string }>(
    `UPDATE empresas
     SET trial_ends_at = CASE WHEN estado_suscripcion = 'trial'
                              THEN now() + make_interval(days => $2) ELSE trial_ends_at END,
         suscripcion_fin = CASE WHEN estado_suscripcion = 'activa'
                                THEN (now() AT TIME ZONE zona_horaria)::date + $2::int ELSE suscripcion_fin END
     WHERE codigo_acceso = $1 AND estado_suscripcion IN ('trial', 'activa')
     RETURNING id, nombre`,
    [codigo, dias],
  );
  if (rows.length === 0) {
    const existe = await pool.query('SELECT 1 FROM empresas WHERE codigo_acceso = $1', [codigo]);
    console.error(
      existe.rowCount
        ? `El negocio ${codigo} no está en prueba ni activo. Actívale un plan primero: npm run dev:activar-plan -- ${codigo} mensual`
        : `No existe un negocio con el código ${codigo}`,
    );
    process.exitCode = 1;
  } else {
    const s = (await buscarSuscripcion(pool, rows[0].id))!;
    await registrarComando(pool, {
      comando: 'dev:simular-vencimiento',
      accion: 'simular_vencimiento',
      empresa: { id: rows[0].id, codigo_acceso: codigo, nombre: rows[0].nombre },
      detalle: { dias },
    });
    console.log(
      `✔ ${rows[0].nombre} (${codigo}): ${estadoEfectivo(s)}. Fin: ${s.fecha_fin}. Días restantes: ${s.dias_restantes}.`,
    );
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
