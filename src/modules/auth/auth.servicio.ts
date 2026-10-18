import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import { registro } from '../../shared/registro.js';
import * as repositorio from './auth.repositorio.js';
import { cifrarContrasena, verificarContrasena } from './contrasenas.js';
import type { ServicioTokens } from './tokens.js';

export type Sesion = { barberoId: string; empresaId: string; esAdmin: boolean };

type Dependencias = { pool: pg.Pool; tokens: ServicioTokens };

export const crearServicioAuth = ({ pool, tokens }: Dependencias) => ({
  async iniciarSesion(usuario: string, clave: string) {
    const barbero = await repositorio.buscarBarberoPorUsuario(pool, usuario);
    const { valida, requiereActualizar } = await verificarContrasena(clave, barbero?.password_hash);
    if (!barbero || !valida) throw errores.noAutenticado('Usuario o contraseña incorrectos');

    if (requiereActualizar) {
      // Si falla, el usuario igual entra; se reintenta en el próximo inicio de sesión
      await cifrarContrasena(clave)
        .then((hash) => repositorio.actualizarHashContrasena(pool, barbero.id, hash))
        .catch((error: Error) =>
          registro.error('actualizar_hash_fallo', { barberoId: barbero.id, mensaje: error.message }),
        );
    }

    return {
      mensaje: 'Autenticación exitosa',
      token: tokens.firmar({ barberoId: barbero.id, empresaId: barbero.empresa_id }),
      barbero: {
        id: barbero.id,
        empresaId: barbero.empresa_id,
        empresaNombre: barbero.empresa_nombre,
        empresaCodigo: barbero.empresa_codigo,
        nombre: barbero.nombre,
        usuario: barbero.usuario,
        esAdmin: barbero.es_admin,
        especialidad: barbero.especialidad,
        porcentajeGanancia: parseFloat(barbero.porcentaje_ganancia),
        foto: barbero.foto_url,
      },
    };
  },

  // Convierte un token en la sesión vigente, con el rol actual leído de la base
  async validarSesion(token: string | undefined): Promise<Sesion> {
    if (!token) throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');
    const datos = tokens.verificar(token);
    if (!datos) throw errores.noAutenticado('Sesión vencida. Inicia sesión de nuevo.');

    const rol = await repositorio.buscarRolVigente(pool, datos.barberoId, datos.empresaId);
    if (!rol) throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');
    return { ...datos, esAdmin: rol.es_admin };
  },
});

export type ServicioAuth = ReturnType<typeof crearServicioAuth>;
