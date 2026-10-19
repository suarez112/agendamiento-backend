import type pg from 'pg';
import { CODIGO_PG, enTransaccion, esErrorPg } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import { cifrarContrasena, verificarContrasena } from '../auth/contrasenas.js';
import type { ServicioTokens } from '../auth/tokens.js';
import type { PerfilEmpresa } from '../empresas/empresas.esquemas.js';
import { CODIGO_REPETIDO } from '../empresas/empresas.servicio.js';
import { guardarHorario } from '../empresas/horario.js';
import { DIAS_PRUEBA } from '../empresas/suscripcion.js';
import { registrarAutorizacion, tieneAutorizacionVigente } from '../legal/legal.js';
import * as repositorio from './cuentas.repositorio.js';
import type { FilaUsuario, Rol } from './cuentas.repositorio.js';

// Sesión de una cuenta (tabla usuarios). Rol y empresa salen de la base.
export type SesionCuenta = { usuarioId: string; rol: Rol; empresaId: string | null };

type Dependencias = { pool: pg.Pool; tokens: ServicioTokens };
type Credenciales = { correo: string; clave: string };
export type DatosRegistroEmpresa = PerfilEmpresa & { correo: string; usuario: string; clave: string };
export type DatosRegistroCliente = {
  nombre: string;
  telefono: string;
  indicativo: string;
  correo?: string;
  usuario?: string;
  clave: string;
};

const CORREO_REPETIDO = 'Ya existe una cuenta con ese correo';
export const USUARIO_REPETIDO = 'Ese usuario ya está en uso. Elige otro.';
const TELEFONO_REPETIDO = 'Ya existe una cuenta con ese número de teléfono';

// Traduce los choques con índices únicos a un 409 con un mensaje claro
const traducirDuplicado = (error: unknown): never => {
  if (esErrorPg(error, CODIGO_PG.violacionUnica)) {
    const restriccion = (error as { constraint?: string }).constraint;
    if (restriccion === 'usuarios_correo_lower_key') throw errores.conflicto(CORREO_REPETIDO);
    // El usuario no puede repetirse entre cuentas ni con el equipo (trigger de la migración 007)
    if (restriccion === 'usuarios_usuario_lower_key' || restriccion === 'usuario_login_unico') {
      throw errores.conflicto(USUARIO_REPETIDO);
    }
    if (restriccion === 'empresas_codigo_acceso_key') throw errores.conflicto(CODIGO_REPETIDO);
    // El teléfono es único entre las cuentas de cliente (migración 011)
    if (restriccion === 'usuarios_telefono_cliente_key') throw errores.conflicto(TELEFONO_REPETIDO);
  }
  throw error;
};

export const crearServicioCuentas = ({ pool, tokens }: Dependencias) => {
  const respuestaUsuario = (usuario: FilaUsuario) => ({
    id: usuario.id,
    correo: usuario.correo,
    usuario: usuario.usuario,
    rol: usuario.rol,
    empresaId: usuario.empresa_id,
    // Solo los clientes los tienen (se usan al reservar con la sesión)
    nombre: usuario.nombre,
    telefono: usuario.telefono,
    indicativo: usuario.indicativo,
  });

  // Un cliente que no ha aceptado las versiones vigentes de la política y los
  // términos debe aceptarlas en su próxima reserva (debeAceptarDocumentos: true)
  const respuestaLogin = async (usuario: FilaUsuario) => ({
    mensaje: 'Autenticación exitosa',
    token: tokens.firmarCuenta({ usuarioId: usuario.id }),
    usuario: respuestaUsuario(usuario),
    ...(usuario.rol === 'cliente' && {
      debeAceptarDocumentos: !(await tieneAutorizacionVigente(pool, usuario.id)),
    }),
  });

  return {
    // Crea la empresa (en prueba), su horario y su administradora en una sola
    // transacción: si algo falla, no queda nada guardado.
    async registrarEmpresa({ clave, correo, usuario: nombreUsuario, horario, ...perfil }: DatosRegistroEmpresa) {
      const passwordHash = await cifrarContrasena(clave);
      const { empresa, usuario } = await enTransaccion(pool, async (cliente) => {
        const empresa = await repositorio.insertarEmpresaEnPrueba(cliente, perfil, DIAS_PRUEBA);
        if (!empresa) throw errores.conflicto(CODIGO_REPETIDO);
        await guardarHorario(cliente, empresa.id, horario);

        const usuario = await repositorio.insertarUsuario(cliente, {
          correo,
          usuario: nombreUsuario,
          passwordHash,
          rol: 'admin',
          empresaId: empresa.id,
        });
        // Prueba de que aceptó la política y los términos (la ruta ya exigió la aceptación)
        await registrarAutorizacion(cliente, { origen: 'registro_empresa', usuarioId: usuario.id, empresaId: empresa.id });
        return { empresa, usuario };
      }).catch(traducirDuplicado);

      return {
        mensaje: `Empresa registrada. Tu prueba gratuita de ${DIAS_PRUEBA} días comenzó hoy.`,
        token: tokens.firmarCuenta({ usuarioId: usuario.id }),
        usuario: respuestaUsuario(usuario),
        empresa: {
          id: empresa.id,
          nombre: empresa.nombre,
          codigoAcceso: empresa.codigo_acceso,
          estadoSuscripcion: empresa.estado_suscripcion,
          trialEndsAt: empresa.trial_ends_at,
          diasPruebaRestantes: DIAS_PRUEBA,
        },
      };
    },

    // Cuenta y prueba de la autorización juntas: o se guardan las dos, o ninguna
    async registrarCliente({ clave, correo, usuario: nombreUsuario, ...datos }: DatosRegistroCliente) {
      const passwordHash = await cifrarContrasena(clave);
      const usuario = await enTransaccion(pool, async (tx) => {
        const usuario = await repositorio.insertarUsuario(tx, {
          ...datos,
          correo: correo ?? null,
          usuario: nombreUsuario ?? null,
          passwordHash,
          rol: 'cliente',
          empresaId: null,
        });
        await registrarAutorizacion(tx, { origen: 'registro_cliente', usuarioId: usuario.id });
        return usuario;
      }).catch(traducirDuplicado);
      return {
        mensaje: 'Cuenta creada',
        token: tokens.firmarCuenta({ usuarioId: usuario.id }),
        usuario: respuestaUsuario(usuario),
      };
    },

    // Sirve para administradores de empresa y clientes
    async iniciarSesion({ correo, clave }: Credenciales) {
      const usuario = await repositorio.buscarUsuarioPorCorreo(pool, correo);
      const { valida } = await verificarContrasena(clave, usuario?.password_hash);
      if (!usuario || !valida) throw errores.noAutenticado('Correo o contraseña incorrectos');
      return await respuestaLogin(usuario);
    },

    // Cuenta con ese correo o usuario (para el login único):
    // - undefined: no hay cuenta con ese dato (puede ser alguien del personal)
    // - null: la cuenta existe pero la contraseña no coincide
    async verificarCredenciales({ correo, usuario }: { correo?: string; usuario?: string }, clave: string) {
      const cuenta = correo
        ? await repositorio.buscarUsuarioPorCorreo(pool, correo)
        : await repositorio.buscarUsuarioPorNombreDeUsuario(pool, usuario ?? '');
      if (!cuenta) return undefined;
      const { valida } = await verificarContrasena(clave, cuenta.password_hash);
      return valida ? cuenta : null;
    },

    respuestaLogin: (usuario: FilaUsuario) => respuestaLogin(usuario),

    // Cuenta de cliente del token, para reservar con la sesión. null si no hay
    // token o no es de un cliente: la reserva sigue como invitado.
    async clienteDeToken(token: string | undefined): Promise<FilaUsuario | null> {
      const datos = token ? tokens.verificarCuenta(token) : null;
      if (!datos) return null;
      const usuario = await repositorio.buscarUsuarioPorId(pool, datos.usuarioId);
      return usuario?.rol === 'cliente' ? usuario : null;
    },

    // Convierte un token en la sesión vigente, con rol y empresa leídos de la base
    async validarSesion(token: string | undefined): Promise<SesionCuenta> {
      if (!token) throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');
      const datos = tokens.verificarCuenta(token);
      if (!datos) throw errores.noAutenticado('Sesión vencida o no válida. Inicia sesión de nuevo.');
      const usuario = await repositorio.buscarUsuarioPorId(pool, datos.usuarioId);
      if (!usuario) throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');
      return { usuarioId: usuario.id, rol: usuario.rol, empresaId: usuario.empresa_id };
    },
  };
};

export type ServicioCuentas = ReturnType<typeof crearServicioCuentas>;
