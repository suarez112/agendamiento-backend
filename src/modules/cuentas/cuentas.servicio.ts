import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { CODIGO_PG, enTransaccion, esErrorPg } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import { cifrarContrasena, verificarContrasena } from '../auth/contrasenas.js';
import type { ServicioTokens } from '../auth/tokens.js';
import type { PerfilEmpresa } from '../empresas/empresas.esquemas.js';
import { DIAS_PRUEBA } from '../empresas/suscripcion.js';
import * as repositorio from './cuentas.repositorio.js';
import type { FilaUsuario, Rol } from './cuentas.repositorio.js';

// Sesión de una cuenta (tabla usuarios). Rol y empresa salen de la base.
export type SesionCuenta = { usuarioId: string; rol: Rol; empresaId: string | null };

type Dependencias = { pool: pg.Pool; tokens: ServicioTokens };
type Credenciales = { correo: string; clave: string };

// Código que los clientes escriben para encontrar el negocio. Sin 0/O ni 1/I
// para que no se confundan al dictarlo.
const LETRAS_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generarCodigoAcceso = () =>
  Array.from({ length: 6 }, () => LETRAS_CODIGO[randomInt(LETRAS_CODIGO.length)]).join('');
const INTENTOS_CODIGO = 5;

const CORREO_REPETIDO = 'Ya existe una cuenta con ese correo';

// Traduce los choques con índices únicos a un 409 con un mensaje claro
const traducirDuplicado = (error: unknown): never => {
  if (esErrorPg(error, CODIGO_PG.violacionUnica)) {
    const restriccion = (error as { constraint?: string }).constraint;
    if (restriccion === 'usuarios_correo_lower_key') throw errores.conflicto(CORREO_REPETIDO);
    if (restriccion === 'empresas_nit_key') throw errores.conflicto('Ya existe una empresa registrada con ese NIT');
  }
  throw error;
};

export const crearServicioCuentas = ({ pool, tokens }: Dependencias) => {
  const respuestaUsuario = (usuario: FilaUsuario) => ({
    id: usuario.id,
    correo: usuario.correo,
    rol: usuario.rol,
    empresaId: usuario.empresa_id,
  });

  return {
    // Crea la empresa (en prueba) y su administrador en una sola transacción:
    // si algo falla, no queda ninguno de los dos.
    async registrarEmpresa({ clave, ...perfil }: PerfilEmpresa & { clave: string }) {
      const passwordHash = await cifrarContrasena(clave);
      const { empresa, usuario } = await enTransaccion(pool, async (cliente) => {
        let empresa: repositorio.FilaEmpresaRegistrada | undefined;
        for (let intento = 0; !empresa && intento < INTENTOS_CODIGO; intento++) {
          empresa = await repositorio.insertarEmpresaEnPrueba(cliente, perfil, generarCodigoAcceso(), DIAS_PRUEBA);
        }
        if (!empresa) throw new Error('No se pudo generar un código de acceso único');

        const usuario = await repositorio.insertarUsuario(cliente, {
          correo: perfil.correo,
          passwordHash,
          rol: 'admin',
          empresaId: empresa.id,
        });
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

    async registrarCliente({ correo, clave }: Credenciales) {
      const passwordHash = await cifrarContrasena(clave);
      const usuario = await repositorio
        .insertarUsuario(pool, { correo, passwordHash, rol: 'cliente', empresaId: null })
        .catch(traducirDuplicado);
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
      return {
        mensaje: 'Autenticación exitosa',
        token: tokens.firmarCuenta({ usuarioId: usuario.id }),
        usuario: respuestaUsuario(usuario),
      };
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
