import dotenv from 'dotenv';
import { cargarEntornoBaseDeDatos } from '../config/entorno.js';
import { marcarCargosPagados } from '../modules/empresas/cobro.js';
import { negarEnProduccion, registrarComando } from './comandos.js';
import { crearPool, enTransaccion } from './pool.js';

// npm run dev:cargos -- listar CODIGO
// npm run dev:cargos -- pagar CODIGO [ID]
// Cargos proporcionales por agregar profesionales a mitad de un periodo. Todavía no hay pagos reales:
// cada cargo nace 'pendiente' y este comando lo marca 'pagado' (uno solo con ID, o todos los del negocio).
dotenv.config({ quiet: true });

const USO = `Uso:
  npm run dev:cargos -- listar CODIGO
  npm run dev:cargos -- pagar CODIGO [ID]

  CODIGO  código del negocio (sin distinguir mayúsculas)
  ID      número de un cargo (sin él, paga todos los pendientes del negocio)

Ejemplo: npm run dev:cargos -- pagar INFINITY`;
const [accion, codigoCrudo, id] = process.argv.slice(2).map((a) => a.trim());
const codigo = codigoCrudo?.toUpperCase();

if ((accion !== 'listar' && accion !== 'pagar') || !codigo || (accion === 'listar' && id) || (id && !/^\d+$/.test(id))) {
  console.error(USO);
  process.exit(1);
}

// Marcar cargos como pagados mueve dinero que no se cobró de verdad: solo en desarrollo
if (accion === 'pagar') negarEnProduccion('dev:cargos pagar');

const pool = crearPool(cargarEntornoBaseDeDatos());

try {
  const empresa = (
    await pool.query<{ id: string; nombre: string }>('SELECT id, nombre FROM empresas WHERE codigo_acceso = $1', [codigo])
  ).rows[0];
  if (!empresa) {
    console.error(`No existe un negocio con el código ${codigo}`);
    process.exitCode = 1;
  } else if (accion === 'listar') {
    const { rows } = await pool.query<{ id: string; fecha: string; estado: string; monto: string; concepto: string }>(
      `SELECT id, to_char(fecha, 'YYYY-MM-DD') AS fecha, estado, monto, concepto
       FROM cargos WHERE empresa_id = $1 ORDER BY id DESC`,
      [empresa.id],
    );
    if (rows.length === 0) console.log(`${empresa.nombre} (${codigo}) no tiene cargos.`);
    for (const c of rows) {
      console.log(`#${c.id} ${c.fecha} ${c.estado.toUpperCase()} ${Number(c.monto).toLocaleString('es-CO')} COP — ${c.concepto}`);
    }
  } else {
    const pagados = await enTransaccion(pool, async (tx) => {
      const marcados = await marcarCargosPagados(tx, empresa.id, 'comando', id);
      if (marcados.length > 0) {
        await registrarComando(tx, {
          comando: 'dev:cargos',
          accion: 'pagar_cargos',
          empresa: { id: empresa.id, codigo_acceso: codigo, nombre: empresa.nombre },
          detalle: { cargos: marcados.length, total: marcados.reduce((suma, c) => suma + Number(c.monto), 0) },
        });
      }
      return marcados;
    });
    if (pagados.length === 0) {
      console.error(id ? `✖ No hay un cargo pendiente #${id} en ${codigo}` : `✖ ${codigo} no tiene cargos pendientes`);
      process.exitCode = 1;
    } else {
      const total = pagados.reduce((suma, c) => suma + Number(c.monto), 0);
      console.log(`✔ ${empresa.nombre} (${codigo}): ${pagados.length} cargo(s) pagado(s), ${total.toLocaleString('es-CO')} COP.`);
    }
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
