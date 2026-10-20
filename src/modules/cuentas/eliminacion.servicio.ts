import type pg from 'pg';
import { enTransaccion } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import { verificarContrasena } from '../auth/contrasenas.js';
import type { SesionCuenta } from './cuentas.servicio.js';

// Eliminar la cuenta (Ley 1581: derecho a suprimir los datos personales).
// - La fila de la cuenta se borra: correo, usuario, teléfono, nombre y contraseña desaparecen,
//   junto con sus negocios guardados, códigos de recuperación y autorizaciones de la cuenta.
// - Las citas y la cartera se conservan sin datos personales: la cita deja de apuntar a la cuenta
//   y el registro del cliente en cada negocio queda como "Cliente eliminado" sin teléfono.
// - Las PQRS se conservan (registro de atención) pero sin nombre ni contacto.
// - Se conservan la lista negra de los negocios y la prueba de las autorizaciones dadas como invitado
//   por teléfono: son registros del negocio y evidencia legal, no de la cuenta.

const ANONIMO = 'Cliente eliminado';

export const MENSAJE_UNICA_ADMIN =
  'Eres la única persona que administra este negocio. Agrega primero a otro administrador en Equipo, ' +
  'o envía "eliminarNegocio": true para cerrar también el negocio.';

type Dependencias = { pool: pg.Pool };
export type DatosEliminacion = { clave: string; eliminarNegocio: boolean };

// Deja a los clientes sin nombre ni teléfono (el teléfono se reemplaza por un valor único y sin formato de número)
const ANONIMIZAR_CLIENTES = `UPDATE clientes SET nombre = '${ANONIMO}', telefono = 'e' || substr(md5(id), 1, 15)`;

export const crearServicioEliminacion = ({ pool }: Dependencias) => ({
  async eliminar(sesion: SesionCuenta, { clave, eliminarNegocio }: DatosEliminacion) {
    const { rows } = await pool.query<{ password_hash: string; telefono: string | null }>(
      'SELECT password_hash, telefono FROM usuarios WHERE id = $1',
      [sesion.usuarioId],
    );
    const { valida } = await verificarContrasena(clave, rows[0]?.password_hash);
    if (!rows[0] || !valida) throw errores.noAutenticado('La contraseña no es correcta');

    await enTransaccion(pool, async (tx) => {
      if (sesion.rol === 'admin' && sesion.empresaId) {
        const empresaId = sesion.empresaId;
        await tx.query('SELECT 1 FROM empresas WHERE id = $1 FOR UPDATE', [empresaId]);
        const { rows: otros } = await tx.query<{ n: number }>(
          `SELECT (SELECT count(*) FROM barberos WHERE empresa_id = $1 AND activo AND es_admin)::int
                + (SELECT count(*) FROM usuarios WHERE empresa_id = $1 AND rol = 'admin' AND id <> $2)::int AS n`,
          [empresaId, sesion.usuarioId],
        );
        if (otros[0].n === 0) {
          if (!eliminarNegocio) throw errores.conflicto(MENSAJE_UNICA_ADMIN);
          // Cierra el negocio: nadie del equipo entra, los clientes no reservan y se borran sus datos personales
          await tx.query(
            `UPDATE empresas SET estado_suscripcion = 'cancelada', nombre_administradora = 'Cuenta eliminada'
             WHERE id = $1`,
            [empresaId],
          );
          await tx.query('UPDATE barberos SET activo = false WHERE empresa_id = $1', [empresaId]);
          await tx.query(`${ANONIMIZAR_CLIENTES} WHERE empresa_id = $1`, [empresaId]);
          await tx.query('DELETE FROM lista_negra WHERE empresa_id = $1', [empresaId]);
        }
      } else if (rows[0].telefono) {
        // Cliente: su registro en cada negocio (mismo teléfono) queda sin datos personales
        await tx.query(`${ANONIMIZAR_CLIENTES} WHERE telefono = $1`, [rows[0].telefono]);
      }

      await tx.query(
        `UPDATE pqrs SET nombre = 'Cuenta eliminada', contacto = 'Cuenta eliminada' WHERE usuario_id = $1`,
        [sesion.usuarioId],
      );
      await tx.query('DELETE FROM usuarios WHERE id = $1', [sesion.usuarioId]);
    });

    return { mensaje: 'Tu cuenta y tus datos personales fueron eliminados.' };
  },
});

export type ServicioEliminacion = ReturnType<typeof crearServicioEliminacion>;
