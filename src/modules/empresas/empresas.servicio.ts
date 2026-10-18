import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import * as repositorio from './empresas.repositorio.js';
import type { FilaEmpresa } from './empresas.repositorio.js';

const CODIGO_VALIDO = /^[A-Z0-9_-]{1,32}$/;

type Visibilidad = {
  // Los usuarios de inicio de sesión solo se muestran al personal del negocio.
  // El código del negocio es público (lo usan los clientes para reservar).
  incluirUsuarios: boolean;
};

export const crearServicioEmpresas = ({ pool }: { pool: pg.Pool }) => {
  const armarNegocio = async (empresa: FilaEmpresa, { incluirUsuarios }: Visibilidad) => {
    const [barberos, servicios] = await Promise.all([
      repositorio.listarBarberos(pool, empresa.id),
      repositorio.listarServicios(pool, empresa.id),
    ]);

    return {
      empresa: {
        id: empresa.id,
        nombre: empresa.nombre,
        codigoAcceso: empresa.codigo_acceso,
        colorPrimario: empresa.color_primario,
        colorSecundario: empresa.color_secundario,
        // la base manda "08:00:00"; la app usa "08:00"
        horarioApertura: String(empresa.horario_apertura).slice(0, 5),
        horarioCierre: String(empresa.horario_cierre).slice(0, 5),
      },
      barberos: barberos.map((b) => ({
        id: b.id,
        nombre: b.nombre,
        usuario: incluirUsuarios ? b.usuario : '',
        clave: '', // por seguridad, el servidor nunca envía contraseñas
        esAdmin: b.es_admin,
        especialidad: b.especialidad ?? '',
        equipo: `${empresa.nombre} TEAM`,
        porcentajeGanancia: Number(b.porcentaje_ganancia),
        foto: b.foto_url ?? undefined,
      })),
      servicios: servicios.map((s) => ({
        id: s.id,
        nombre: s.nombre,
        duracion: `${s.duracion_min} min`,
        precio: Number(s.precio),
      })),
    };
  };

  return {
    // Vista pública para clientes que reservan con el código del negocio
    async negocioPorCodigo(codigo: string) {
      const limpio = codigo.trim().toUpperCase();
      const empresa = CODIGO_VALIDO.test(limpio)
        ? await repositorio.buscarEmpresaPorCodigo(pool, limpio)
        : undefined;
      if (!empresa) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarNegocio(empresa, { incluirUsuarios: false });
    },

    // Vista para el personal con sesión iniciada: su propio negocio
    async negocioDeSesion(empresaId: string) {
      const empresa = await repositorio.buscarEmpresaPorId(pool, empresaId);
      if (!empresa) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarNegocio(empresa, { incluirUsuarios: true });
    },
  };
};

export type ServicioEmpresas = ReturnType<typeof crearServicioEmpresas>;
