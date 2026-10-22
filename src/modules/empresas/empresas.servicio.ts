import type pg from 'pg';
import { CODIGO_PG, enTransaccion, esErrorPg } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import type { CambiosEmpresa } from './empresas.esquemas.js';
import * as repositorio from './empresas.repositorio.js';
import { enlacePublico } from './enlace.js';
import { armarHorario, guardarHorario, listarHorarios } from './horario.js';
import { type AlmacenFotos, urlFoto } from './fotos.js';
import type { FilaEmpresa, FilaPerfilEmpresa } from './empresas.repositorio.js';
import { buscarPlan, PLANES, planParaPersonas } from '../../config/planes.js';
import { INTERVALOS_MINUTOS } from '../citas/disponibilidad.js';
import { DIAS_RECORDATORIO, estadoEfectivo, mensajeBloqueo, planInsuficiente } from './suscripcion.js';

// Mismo formato que la restricción empresas_codigo_acceso_valido (migración 007)
const CODIGO_VALIDO = /^[A-Z0-9]{1,10}$/;

export const CODIGO_REPETIDO = 'Ese código ya lo usa otro negocio. Elige otro.';

type Visibilidad = {
  // Los usuarios de inicio de sesión solo se muestran al personal del negocio.
  // El código del negocio es público (lo usan los clientes para reservar).
  // Los clientes solo ven a quienes atienden clientes (los que se pueden reservar).
  esPublica: boolean;
};

export const crearServicioEmpresas = ({
  pool,
  fotos,
  enlaceBase,
}: {
  pool: pg.Pool;
  fotos: AlmacenFotos;
  // Dirección base de los enlaces públicos (ej. https://agendaya.app)
  enlaceBase: string;
}) => {
  const armarNegocio = async (empresa: FilaEmpresa, { esPublica }: Visibilidad, urlBase: string) => {
    const [equipo, servicios, horario, suscripcion] = await Promise.all([
      repositorio.listarBarberos(pool, empresa.id),
      repositorio.listarServicios(pool, empresa.id),
      listarHorarios(pool, [empresa.id]),
      repositorio.buscarSuscripcion(pool, empresa.id),
    ]);
    const barberos = esPublica ? equipo.filter((b) => b.atiende_clientes) : equipo;
    const { horario: dias, horarioApertura, horarioCierre } = armarHorario(horario);

    return {
      empresa: {
        id: empresa.id,
        nombre: empresa.nombre,
        codigoAcceso: empresa.codigo_acceso,
        colorPrimario: empresa.color_primario,
        colorSecundario: empresa.color_secundario,
        // Apertura más temprana y cierre más tardío de la semana (la app de antes los usa);
        // el horario de cada día está en "horario"
        horarioApertura,
        horarioCierre,
        horario: dias,
        // false si la suscripción venció: la app puede avisar antes de reservar
        recibiendoReservas: Boolean(suscripcion?.habilitada),
      },
      barberos: barberos.map((b) => ({
        id: b.id,
        nombre: b.nombre,
        usuario: esPublica ? '' : b.usuario,
        clave: '', // por seguridad, el servidor nunca envía contraseñas
        esAdmin: b.es_admin,
        atiendeClientes: b.atiende_clientes,
        especialidad: b.especialidad ?? '',
        equipo: `${empresa.nombre} TEAM`,
        porcentajeGanancia: Number(b.porcentaje_ganancia),
        foto: urlFoto(urlBase, b.foto_url) ?? undefined,
      })),
      servicios: servicios.map((s) => ({
        id: s.id,
        nombre: s.nombre,
        duracion: `${s.duracion_min} min`,
        precio: Number(s.precio),
      })),
    };
  };

  const conHorario = async (perfil: FilaPerfilEmpresa) => ({
    perfil,
    horario: armarHorario(await listarHorarios(pool, [perfil.id])),
  });

  return {
    // Vista pública para clientes que reservan con el código del negocio
    async negocioPorCodigo(codigo: string, urlBase: string) {
      const limpio = codigo.trim().toUpperCase();
      const empresa = CODIGO_VALIDO.test(limpio)
        ? await repositorio.buscarEmpresaPorCodigo(pool, limpio)
        : undefined;
      if (!empresa) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarNegocio(empresa, { esPublica: true }, urlBase);
    },

    // Vista para el personal con sesión iniciada: su propio negocio
    async negocioDeSesion(empresaId: string, urlBase: string) {
      const empresa = await repositorio.buscarEmpresaPorId(pool, empresaId);
      if (!empresa) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarNegocio(empresa, { esPublica: false }, urlBase);
    },

    // Información del negocio para clientes: sin NIT, datos internos ni suscripción.
    // urlBase arma la dirección completa de la foto (ej. https://api.mibarberia.co).
    async perfilPublico(codigo: string, urlBase: string) {
      const limpio = codigo.trim().toUpperCase();
      const perfil = CODIGO_VALIDO.test(limpio)
        ? await repositorio.buscarPerfilEmpresaPorCodigo(pool, limpio)
        : undefined;
      if (!perfil) throw errores.noEncontrado('Establecimiento no encontrado');
      const suscripcion = await repositorio.buscarSuscripcion(pool, perfil.id);
      return {
        ...armarPerfilPublico(await conHorario(perfil), urlBase),
        recibiendoReservas: Boolean(suscripcion?.habilitada),
      };
    },

    // Perfil de la empresa del administrador. El id sale siempre de la sesión.
    async perfilDeAdmin(empresaId: string, urlBase: string) {
      const perfil = await repositorio.buscarPerfilEmpresa(pool, empresaId);
      if (!perfil) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarPerfil(await conHorario(perfil), urlBase, enlaceBase);
    },

    // Datos y horario se guardan juntos: si algo falla, no cambia nada.
    // Durante la prueba, el número de empleados decide el plan (1-3 Básico, 4-5 Equipo,
    // 6-10 Pro); un plan cuyo cupo no alcanza para el equipo activo se rechaza. Fuera de
    // la prueba es solo informativo: el plan lo cambia el pago. El UPDATE bloquea la
    // fila de la empresa, así que un integrante nuevo creado a la vez espera.
    async actualizarPerfil(empresaId: string, { horario, ...cambios }: CambiosEmpresa, urlBase: string) {
      const perfil = await enTransaccion(pool, async (tx) => {
        const actualizado = await repositorio.actualizarPerfilEmpresa(tx, empresaId, cambios);
        if (actualizado && cambios.numeroEmpleados !== undefined && actualizado.estado_suscripcion === 'trial') {
          const plan = planParaPersonas(cambios.numeroEmpleados);
          const activos = await repositorio.contarEquipoActivo(tx, empresaId);
          if (activos > plan.cupo) throw errores.conflicto(planInsuficiente(plan, activos));
          await repositorio.cambiarPlanEquipo(tx, empresaId, plan.id);
        }
        if (actualizado && horario) await guardarHorario(tx, empresaId, horario);
        return actualizado;
      }).catch(traducirErrorPerfil);
      if (!perfil) throw errores.noEncontrado('Establecimiento no encontrado');
      return armarPerfil(await conHorario(perfil), urlBase, enlaceBase);
    },

    // Cada cuántos minutos pueden agendar los clientes
    async intervalo(empresaId: string) {
      const minutos = await repositorio.buscarIntervalo(pool, empresaId);
      if (minutos === undefined) throw errores.noEncontrado('Establecimiento no encontrado');
      return { intervaloMinutos: minutos, opciones: INTERVALOS_MINUTOS };
    },

    async cambiarIntervalo(empresaId: string, minutos: number) {
      const nuevo = await repositorio.cambiarIntervalo(pool, empresaId, minutos);
      if (nuevo === undefined) throw errores.noEncontrado('Establecimiento no encontrado');
      return { mensaje: 'Intervalo de horarios actualizado', intervaloMinutos: nuevo, opciones: INTERVALOS_MINUTOS };
    },

    // Para el registro y "Mi negocio": el código ya viene validado y en mayúsculas
    async codigoDisponible(codigo: string) {
      return { codigo, disponible: await repositorio.codigoDisponible(pool, codigo) };
    },

    // Sube o reemplaza la foto del negocio. Primero guarda el archivo nuevo; si la
    // base no se actualiza, lo borra. La foto anterior se borra solo al final.
    async cambiarFoto(empresaId: string, datos: Buffer, urlBase: string) {
      const ruta = await fotos.guardar(datos);
      let cambio: Awaited<ReturnType<typeof repositorio.cambiarFotoEmpresa>>;
      try {
        cambio = await repositorio.cambiarFotoEmpresa(pool, empresaId, ruta);
      } catch (error) {
        await fotos.borrar(ruta);
        throw error;
      }
      if (!cambio) {
        await fotos.borrar(ruta);
        throw errores.noEncontrado('Establecimiento no encontrado');
      }
      await fotos.borrar(cambio.foto_anterior);
      return { mensaje: 'Foto del negocio actualizada', fotoUrl: urlFoto(urlBase, ruta) };
    },

    // Días de prueba gratuita que le quedan a la empresa (null si no está en prueba)
    async estadoPrueba(empresaId: string) {
      const suscripcion = await repositorio.buscarSuscripcion(pool, empresaId);
      if (!suscripcion) throw errores.noEncontrado('Establecimiento no encontrado');
      const enPrueba = suscripcion.estado_suscripcion === 'trial';
      return {
        estadoSuscripcion: suscripcion.estado_suscripcion,
        trialEndsAt: suscripcion.trial_ends_at,
        diasRestantes: enPrueba ? Math.max(0, suscripcion.dias_restantes ?? 0) : null,
        pruebaVencida: enPrueba && !suscripcion.habilitada,
      };
    },

    // Estado, plan, fechas y días que quedan (con la fecha actual de Colombia), y si
    // la app debe mostrar un recordatorio: siempre en la prueba y en los últimos
    // días de un plan mensual o anual
    async suscripcion(empresaId: string) {
      const s = await repositorio.buscarSuscripcion(pool, empresaId);
      if (!s) throw errores.noEncontrado('Establecimiento no encontrado');
      const estado = estadoEfectivo(s);
      const plan = buscarPlan(s.plan_equipo) ?? PLANES[PLANES.length - 1];
      const dias = estado === 'vencida' ? 0 : s.dias_restantes;
      const mostrarRecordatorio =
        estado === 'prueba' || (estado === 'activa' && dias !== null && dias <= DIAS_RECORDATORIO);
      return {
        estado,
        plan: s.plan,
        fechaPago: s.fecha_pago,
        fechaFin: s.fecha_fin,
        diasRestantes: dias,
        // Días de prueba que le quedaban al pagar y se sumaron al plan (0 si pagó con la
        // prueba vencida; null si el plan no se activó durante una prueba o si está en prueba)
        diasPruebaSumados: estado === 'prueba' ? null : s.dias_prueba_sumados,
        mostrarRecordatorio,
        // true si soporte suspendió el negocio: se ve como vencida, con su propio mensaje
        suspendida: s.suspendida,
        mensaje: estado === 'vencida' ? mensajeBloqueo(s) : recordatorio(estado, s.plan, dias, mostrarRecordatorio),
        // Plan por tamaño de equipo y cuántos integrantes activos usan su cupo
        planEquipo: { id: plan.id, nombre: plan.nombre, cupo: plan.cupo },
        cupoUsado: s.equipo_activo,
        cupoDisponible: Math.max(0, plan.cupo - s.equipo_activo),
        // Día del registro (hora de Colombia): la cartera no acepta rangos que empiecen antes
        fechaRegistro: s.fecha_registro,
      };
    },
  };
};

// Texto del recordatorio; null si no hay que mostrar ninguno
const recordatorio = (estado: string, plan: string | null, dias: number | null, mostrar: boolean) => {
  if (!mostrar || dias === null) return null;
  const quedan = dias === 1 ? 'Te queda 1 día' : `Te quedan ${dias} días`;
  if (estado === 'prueba') return `${quedan} de prueba gratuita. Activa un plan para no perder el acceso.`;
  return `${quedan} de tu plan${plan ? ` ${plan}` : ''}. Renuévalo para no perder el acceso.`;
};

type PerfilConHorario = { perfil: FilaPerfilEmpresa; horario: ReturnType<typeof armarHorario> };

const numeroONulo = (valor: string | null) => (valor === null ? null : Number(valor));

// Enlace de Google Maps (no necesita clave de API): con las coordenadas si el negocio
// las tiene; si no, con la dirección, el municipio y el departamento. null si no hay datos.
export const enlaceGoogleMaps = (p: FilaPerfilEmpresa) => {
  const consulta =
    p.latitud !== null && p.longitud !== null
      ? `${Number(p.latitud)},${Number(p.longitud)}`
      : [p.direccion, p.ciudad, p.departamento].filter(Boolean).join(', ');
  return consulta ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(consulta)}` : null;
};

const armarPerfilPublico = ({ perfil: p, horario: h }: PerfilConHorario, urlBase: string) => ({
  id: p.id,
  nombre: p.nombre,
  codigoAcceso: p.codigo_acceso,
  categoria: p.categoria,
  direccion: p.direccion,
  departamento: p.departamento,
  ciudad: p.ciudad,
  horario: h.horario,
  diasAtencion: h.diasAtencion,
  horarioApertura: h.horarioApertura,
  horarioCierre: h.horarioCierre,
  logoUrl: p.logo_url,
  fotoUrl: urlFoto(urlBase, p.foto_url),
  colorPrimario: p.color_primario,
  colorSecundario: p.color_secundario,
  googleMapsUrl: enlaceGoogleMaps(p),
  intervaloMinutos: p.intervalo_minutos,
});

const armarPerfil = ({ perfil: p, horario: h }: PerfilConHorario, urlBase: string, enlaceBase: string) => ({
  id: p.id,
  nombre: p.nombre,
  codigoAcceso: p.codigo_acceso,
  enlacePublico: enlacePublico(enlaceBase, p.codigo_acceso),
  categoria: p.categoria,
  direccion: p.direccion,
  departamento: p.departamento,
  ciudad: p.ciudad,
  horario: h.horario,
  diasAtencion: h.diasAtencion,
  horarioApertura: h.horarioApertura,
  horarioCierre: h.horarioCierre,
  nombreAdministradora: p.nombre_administradora,
  numeroEmpleados: p.numero_empleados,
  logoUrl: p.logo_url,
  fotoUrl: urlFoto(urlBase, p.foto_url),
  colorPrimario: p.color_primario,
  colorSecundario: p.color_secundario,
  latitud: numeroONulo(p.latitud),
  longitud: numeroONulo(p.longitud),
  precisionUbicacion: numeroONulo(p.precision_ubicacion),
  googleMapsUrl: enlaceGoogleMaps(p),
  intervaloMinutos: p.intervalo_minutos,
  estadoSuscripcion: p.estado_suscripcion,
  trialEndsAt: p.trial_ends_at,
  creadaEn: p.created_at,
});

// Lo que la validación no puede saber sin mirar la base: el código de otro negocio
export const traducirErrorPerfil = (error: unknown): never => {
  const restriccion = (error as { constraint?: string }).constraint;
  if (esErrorPg(error, CODIGO_PG.violacionUnica) && restriccion === 'empresas_codigo_acceso_key') {
    throw errores.conflicto(CODIGO_REPETIDO);
  }
  throw error;
};

export type ServicioEmpresas = ReturnType<typeof crearServicioEmpresas>;
