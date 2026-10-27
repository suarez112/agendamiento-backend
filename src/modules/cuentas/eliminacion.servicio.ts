import type pg from 'pg';
import { enTransaccion } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import { verificarContrasena } from '../auth/contrasenas.js';
import { reajustarCobro } from '../empresas/cobro.js';
import type { AlmacenFotos } from '../empresas/fotos.js';
import type { SesionCuenta } from './cuentas.servicio.js';

// Eliminar la cuenta (Ley 1581: derecho a suprimir los datos personales).
// - La fila de la cuenta se borra: correo, usuario, teléfono, nombre y contraseña desaparecen,
//   junto con sus negocios guardados, códigos de recuperación y autorizaciones de la cuenta.
// - Las citas y la cartera se conservan sin datos personales: la cita deja de apuntar a la cuenta
//   y el registro del cliente en cada negocio queda como "Cliente eliminado" sin teléfono.
// - Las PQRS se conservan (registro de atención) pero sin nombre ni contacto.
// - Las notificaciones del personal que nombraban al cliente se corrigen ("Cliente eliminado"); las notificaciones
//   de la cuenta eliminada se borran con ella.
// - Al cerrar un negocio, todo su equipo (también quienes ya habían salido) queda anónimo: sin nombre, usuario,
//   contraseña, especialidad ni foto (los archivos se borran del servidor), sin celulares registrados y sin
//   notificaciones. Si el negocio sigue, solo se anonimiza el perfil de profesional de la persona que se va y el
//   nombre de la administradora del negocio. Las citas y la cartera siguen mostrando "Profesional eliminado".
// - Se conservan la lista negra de los negocios y la prueba de las autorizaciones dadas como invitado
//   por teléfono: son registros del negocio y evidencia legal, no de la cuenta.

const ANONIMO = 'Cliente eliminado';
export const PROFESIONAL_ANONIMO = 'Profesional eliminado';
export const ADMINISTRADORA_ANONIMA = 'Cuenta eliminada';

export const MENSAJE_UNICA_ADMIN =
  'Eres la única persona que administra este negocio. Agrega primero a otro administrador en Equipo, ' +
  'o envía "eliminarNegocio": true para cerrar también el negocio.';

type Dependencias = { pool: pg.Pool; fotos: AlmacenFotos };
export type DatosEliminacion = { clave: string; eliminarNegocio: boolean };

// Deja a los clientes sin nombre ni teléfono (el teléfono se reemplaza por un valor único y sin formato de número)
const ANONIMIZAR_CLIENTES = `UPDATE clientes SET nombre = '${ANONIMO}', telefono = 'e' || substr(md5(id), 1, 15)`;

// Deja a los profesionales sin datos personales. Devuelve las fotos que tenían, para borrar los archivos
// cuando la transacción termine.
const ANONIMIZAR_EQUIPO = `UPDATE barberos
   SET nombre = '${PROFESIONAL_ANONIMO}', especialidad = NULL, foto_url = NULL, activo = false, atiende_clientes = false,
       usuario = NULL, password_hash = NULL, version_sesion = version_sesion + 1`;

const anonimizarEquipo = async (tx: pg.PoolClient, donde: 'empresa_id' | 'usuario_id', valor: string) => {
  const { rows } = await tx.query<{ foto_url: string }>(
    `SELECT foto_url FROM barberos WHERE ${donde} = $1 AND foto_url IS NOT NULL`,
    [valor],
  );
  await tx.query(`${ANONIMIZAR_EQUIPO} WHERE ${donde} = $1`, [valor]);
  // Sus celulares y notificaciones también se van
  const equipo = `(SELECT id FROM barberos WHERE ${donde} = $1)`;
  await tx.query(`DELETE FROM dispositivos_push WHERE barbero_id IN ${equipo}`, [valor]);
  await tx.query(`DELETE FROM notificaciones WHERE barbero_id IN ${equipo}`, [valor]);
  return rows.map((r) => r.foto_url);
};

// Las notificaciones que ya se enviaron al personal pueden nombrar al cliente: el nombre se reemplaza
const LIMPIAR_NOTIFICACIONES = `UPDATE notificaciones n SET texto = replace(n.texto, cl.nombre, '${ANONIMO}')
   FROM citas ci JOIN clientes cl ON cl.id = ci.cliente_id AND cl.empresa_id = ci.empresa_id
   WHERE n.cita_id = ci.id AND cl.nombre <> '${ANONIMO}'`;

export const crearServicioEliminacion = ({ pool, fotos }: Dependencias) => ({
  async eliminar(sesion: SesionCuenta, { clave, eliminarNegocio }: DatosEliminacion) {
    const { rows } = await pool.query<{ password_hash: string; telefono: string | null }>(
      'SELECT password_hash, telefono FROM usuarios WHERE id = $1',
      [sesion.usuarioId],
    );
    const { valida } = await verificarContrasena(clave, rows[0]?.password_hash);
    if (!rows[0] || !valida) throw errores.noAutenticado('La contraseña no es correcta');

    const fotosABorrar: string[] = [];
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
            `UPDATE empresas SET estado_suscripcion = 'cancelada', nombre_administradora = '${ADMINISTRADORA_ANONIMA}'
             WHERE id = $1`,
            [empresaId],
          );
          // Todo el equipo (activo o no) queda anónimo y sus fotos se borran del servidor
          fotosABorrar.push(...(await anonimizarEquipo(tx, 'empresa_id', empresaId)));
          await tx.query(`${LIMPIAR_NOTIFICACIONES} AND cl.empresa_id = $1`, [empresaId]);
          await tx.query(`${ANONIMIZAR_CLIENTES} WHERE empresa_id = $1`, [empresaId]);
          await tx.query('DELETE FROM lista_negra WHERE empresa_id = $1', [empresaId]);
        } else {
          // El negocio sigue, pero ya no debe guardar el nombre de quien se va
          await tx.query(`UPDATE empresas SET nombre_administradora = '${ADMINISTRADORA_ANONIMA}' WHERE id = $1`, [empresaId]);
        }
      } else if (rows[0].telefono) {
        // Cliente: su registro en cada negocio (mismo teléfono) queda sin datos personales, y las notificaciones
        // que el personal recibió con su nombre dejan de nombrarlo
        await tx.query(`${LIMPIAR_NOTIFICACIONES} AND cl.telefono = $1`, [rows[0].telefono]);
        await tx.query(`${ANONIMIZAR_CLIENTES} WHERE telefono = $1`, [rows[0].telefono]);
      }

      // Si la administradora también atendía clientes, su perfil de profesional queda desactivado y anónimo
      // (sus citas se conservan, a nombre de "Profesional eliminado")
      fotosABorrar.push(...(await anonimizarEquipo(tx, 'usuario_id', sesion.usuarioId)));
      // Un profesional menos: recalcula el nivel (no devuelve dinero)
      if (sesion.empresaId) await reajustarCobro(tx, sesion.empresaId);
      await tx.query(
        `UPDATE pqrs SET nombre = 'Cuenta eliminada', contacto = 'Cuenta eliminada' WHERE usuario_id = $1`,
        [sesion.usuarioId],
      );
      await tx.query('DELETE FROM usuarios WHERE id = $1', [sesion.usuarioId]);
    });

    // Los archivos se borran al final: si la transacción falla, las fotos siguen donde estaban
    await Promise.all(fotosABorrar.map((ruta) => fotos.borrar(ruta)));
    return { mensaje: 'Tu cuenta y tus datos personales fueron eliminados.' };
  },
});

export type ServicioEliminacion = ReturnType<typeof crearServicioEliminacion>;
