import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import { registro } from '../../shared/registro.js';
import { buscarSuscripcion } from '../empresas/empresas.repositorio.js';
import { NEGOCIO_INACTIVO } from '../empresas/suscripcion.js';
import * as repositorio from './auth.repositorio.js';
import { cifrarContrasena, verificarContrasena } from './contrasenas.js';
import type { ServicioTokens } from './tokens.js';

// Sesión del personal del negocio. Puede ser un barbero (barberoId) o la cuenta
// del administrador de la empresa (usuarioId, tabla usuarios), que tiene los
// mismos permisos que un barbero administrador. Siempre hay exactamente uno de los dos.
export type Sesion =
  | { barberoId: string; usuarioId: null; empresaId: string; esAdmin: boolean }
  | { barberoId: null; usuarioId: string; empresaId: string; esAdmin: true };

type Dependencias = { pool: pg.Pool; tokens: ServicioTokens };

export const crearServicioAuth = ({ pool, tokens }: Dependencias) => ({
  async iniciarSesion(usuario: string, clave: string) {
    const barbero = await this.verificarCredenciales(usuario, clave);
    if (!barbero) throw errores.noAutenticado('Usuario o contraseña incorrectos');
    return await this.respuestaLogin(barbero);
  },

  // Barbero activo con ese usuario y contraseña; undefined si no coinciden
  async verificarCredenciales(usuario: string, clave: string) {
    const barbero = await repositorio.buscarBarberoPorUsuario(pool, usuario);
    const { valida, requiereActualizar } = await verificarContrasena(clave, barbero?.password_hash);
    if (!barbero || !valida) return undefined;

    if (requiereActualizar) {
      // Si falla, el usuario igual entra; se reintenta en el próximo inicio de sesión
      await cifrarContrasena(clave)
        .then((hash) => repositorio.actualizarHashContrasena(pool, barbero.id, hash))
        .catch((error: Error) =>
          registro.error('actualizar_hash_fallo', { barberoId: barbero.id, mensaje: error.message }),
        );
    }
    return barbero;
  },

  // Un empleado (no administrador) de un negocio con la suscripción vencida no
  // entra: recibe el aviso de negocio inactivo. El administrador sí entra, para
  // usar Mi negocio y consultar la suscripción.
  async respuestaLogin(barbero: repositorio.FilaBarberoLogin) {
    if (!barbero.es_admin) {
      const suscripcion = await buscarSuscripcion(pool, barbero.empresa_id);
      if (!suscripcion?.habilitada) throw errores.pagoRequerido(NEGOCIO_INACTIVO);
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
        rol: barbero.es_admin ? 'admin' : 'empleado',
        esAdmin: barbero.es_admin,
        atiendeClientes: barbero.atiende_clientes,
        especialidad: barbero.especialidad,
        porcentajeGanancia: parseFloat(barbero.porcentaje_ganancia),
        foto: barbero.foto_url,
      },
    };
  },

  // Convierte un token en la sesión vigente, con el rol actual leído de la base.
  // Acepta el token del personal (barberos) y el de la cuenta del administrador
  // de la empresa; el de un cliente no sirve aquí.
  async validarSesion(token: string | undefined): Promise<Sesion> {
    if (!token) throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');

    const datos = tokens.verificar(token);
    if (datos) {
      const rol = await repositorio.buscarRolVigente(pool, datos.barberoId, datos.empresaId);
      if (!rol) throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');
      return { ...datos, usuarioId: null, esAdmin: rol.es_admin };
    }

    const cuenta = tokens.verificarCuenta(token);
    if (!cuenta) throw errores.noAutenticado('Sesión vencida. Inicia sesión de nuevo.');
    const usuario = await repositorio.buscarCuentaVigente(pool, cuenta.usuarioId);
    // Cuenta eliminada, o cambió su contraseña después de iniciar esta sesión
    if (!usuario || usuario.version_sesion !== cuenta.version) throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');
    if (usuario.rol !== 'admin' || !usuario.empresa_id) {
      throw errores.prohibido('Esta función es solo para el personal del negocio.');
    }
    return { barberoId: null, usuarioId: cuenta.usuarioId, empresaId: usuario.empresa_id, esAdmin: true };
  },
});

export type ServicioAuth = ReturnType<typeof crearServicioAuth>;
