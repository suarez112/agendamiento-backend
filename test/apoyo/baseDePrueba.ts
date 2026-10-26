import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import pg from 'pg';
import { aplicarMigraciones } from '../../src/db/migraciones.js';
import { hoyEn, sumarDiasAFecha, ZONA_POR_DEFECTO } from '../../src/shared/zonaHoraria.js';
import { crearPool } from '../../src/db/pool.js';
import { esBaseTemporalDePrueba, leerConfigPruebas } from './configuracionPruebas.js';

dotenv.config({ quiet: true });
process.env.NODE_ENV = 'test';

// Fecha "YYYY-MM-DD" a N días de hoy en la zona del negocio de pruebas (Bogotá), no la del computador:
// así las pruebas no fallan cerca de la medianoche ni en otra zona horaria.
export const fechaEnDias = (dias: number) => sumarDiasAFecha(hoyEn(ZONA_POR_DEFECTO), dias);

export const FECHA_FUTURA = fechaEnDias(7);

// Datos conocidos: dos negocios para probar el aislamiento entre ellos
const sembrar = async (pool: pg.Pool) => {
  const hashSecreta = await bcrypt.hash('secreta', 4);
  await pool.query(`
    INSERT INTO empresas (id, nombre, codigo_acceso, horario_apertura, horario_cierre) VALUES
      ('emp_a', 'Negocio A', 'NEGA', '08:00', '20:00'),
      ('emp_b', 'Negocio B', 'NEGB', '08:00', '20:00');
    INSERT INTO barberos (id, empresa_id, nombre, usuario, password_hash, es_admin) VALUES
      ('admin_a', 'emp_a', 'Admin A', 'admin.a', '1234', true),
      ('barb_a', 'emp_a', 'Barbero A', 'barbero.a', 'clave-a', false),
      ('barb_a2', 'emp_a', 'Barbero A2', 'barbero.a2', '${hashSecreta}', false),
      ('admin_b', 'emp_b', 'Admin B', 'admin.b', 'clave-b', true);
    INSERT INTO servicios (id, empresa_id, nombre, duracion_min, precio) VALUES
      ('serv_a', 'emp_a', 'Corte', 30, 20000),
      ('serv_a_largo', 'emp_a', 'Corte y barba', 60, 35000),
      ('serv_b', 'emp_b', 'Corte B', 30, 18000);
    INSERT INTO clientes (id, empresa_id, telefono, indicativo, nombre, total_citas) VALUES
      ('cli_b', 'emp_b', '3009998877', '57', 'Cliente de B', 1);
    INSERT INTO citas (id, empresa_id, barbero_id, servicio_id, cliente_id, fecha, hora_inicio, hora_fin, precio, estado) VALUES
      ('cita_b', 'emp_b', 'admin_b', 'serv_b', 'cli_b', '${FECHA_FUTURA}', '10:00', '10:30', 18000, 'CONFIRMADA');
  `);
};

const VERSION_SEMILLA = '002';

export type BaseDePrueba = { nombre: string; pool: pg.Pool; destruir: () => Promise<void> };

// Crea una base temporal, la migra y la llena; destruir() la elimina. Nunca toca la base de
// desarrollo: solo usa la base de pruebas de TEST_DB_NAME (y se niega a correr si falta).
export const crearBaseDePrueba = async (opciones: { hasta?: string } = {}): Promise<BaseDePrueba> => {
  const config = leerConfigPruebas();
  const nombre = `${config.prefijo}${process.pid}_${Date.now().toString(36)}`;
  const conAdmin = async (sql: string) => {
    const cliente = new pg.Client({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.baseMantenimiento,
    });
    await cliente.connect();
    try {
      await cliente.query(sql);
    } finally {
      await cliente.end();
    }
  };

  await conAdmin(`CREATE DATABASE "${nombre}"`);
  const pool = crearPool({
    DB_HOST: config.host,
    DB_PORT: config.port,
    DB_USER: config.user,
    DB_PASSWORD: config.password,
    DB_NAME: nombre,
    DB_POOL_MAX: 10,
  });
  // Los datos sembrados son negocios que ya existían antes del registro de
  // empresas (003): se insertan con el esquema 002 y luego se migra el resto.
  const hastaSemilla = opciones.hasta && opciones.hasta < VERSION_SEMILLA ? opciones.hasta : VERSION_SEMILLA;
  await aplicarMigraciones(pool, { hasta: hastaSemilla });
  await sembrar(pool);
  await aplicarMigraciones(pool, opciones);

  return {
    nombre,
    pool,
    destruir: async () => {
      await pool.end();
      // Última defensa: solo se borra una base que lleve el prefijo de las temporales de pruebas
      if (!esBaseTemporalDePrueba(config, nombre)) throw new Error(`No se borra "${nombre}": no es una base temporal de pruebas`);
      await conAdmin(`DROP DATABASE IF EXISTS "${nombre}" WITH (FORCE)`);
    },
  };
};
