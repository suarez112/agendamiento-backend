import type pg from 'pg';
import { buscarPlan, PLANES } from '../../config/planes.js';
import { enTransaccion } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import { verificarContrasena } from '../auth/contrasenas.js';
import type { ServicioTokens } from '../auth/tokens.js';
import { activarPlanEmpresa, type Periodo } from '../empresas/activacion.js';
import * as pqrsRepositorio from '../pqrs/pqrs.repositorio.js';
import type { EstadoPqrs, FilaPqrsSoporte, TipoPqrs } from '../pqrs/pqrs.repositorio.js';
import { descifrarSecreto, verificarTotp } from './totp.js';
import * as repositorio from './superadmin.repositorio.js';
import type { EstadoNegocio, FilaActividad, FilaDetalleNegocio, FilaNegocio } from './superadmin.repositorio.js';

export type SesionSuperadmin = { id: string; correo: string };

type Dependencias = { pool: pg.Pool; tokens: ServicioTokens; secreto: string };
export type Pagina = { pagina: number; limite: number };

const INCORRECTOS = 'Correo, contraseña o código incorrectos';
const NEGOCIO_NO_ENCONTRADO = 'Negocio no encontrado';
const PQRS_NO_ENCONTRADA = 'No existe una PQRS con ese radicado';
const MENSAJE_INACTIVIDAD = `Sesión cerrada por ${repositorio.MINUTOS_INACTIVIDAD} minutos sin actividad. Inicia sesión de nuevo.`;
// La sesión dura una hora (ver tokens.ts)
const SEGUNDOS_SESION = 3600;

const aPagina = ({ pagina, limite }: Pagina) => ({ limite, desplazamiento: (pagina - 1) * limite });
const envolver = <T>(items: { total: number }[], datos: T[], { pagina, limite }: Pagina) => ({
  total: items[0]?.total ?? 0,
  pagina,
  limite,
  datos,
});

const armarNegocio = (n: FilaNegocio) => {
  const plan = buscarPlan(n.plan_equipo) ?? PLANES[PLANES.length - 1];
  return {
    id: n.id,
    nombre: n.nombre,
    codigoAcceso: n.codigo_acceso,
    planEquipo: { id: plan.id, nombre: plan.nombre, cupo: plan.cupo },
    // Periodo del plan pagado (mensual o anual); null en la prueba
    plan: n.periodo,
    estado: n.estado,
    diasRestantes: n.dias === null ? null : Math.max(0, n.dias),
    cupoUsado: n.equipo_activo,
    municipio: n.ciudad,
    departamento: n.departamento,
    fechaRegistro: n.registro,
  };
};

const armarPqrs = (p: FilaPqrsSoporte) => ({
  radicado: p.radicado,
  tipo: p.tipo,
  estado: p.estado,
  mensaje: p.mensaje,
  nombre: p.nombre,
  contacto: p.contacto,
  conCuenta: p.con_cuenta,
  respuesta: p.respuesta,
  respondidaEn: p.respondida_en,
  creadaEn: p.creado_en,
  actualizadaEn: p.actualizado_en,
});

const armarActividad = (a: FilaActividad) => ({
  id: a.id,
  superadmin: a.superadmin_correo,
  accion: a.accion,
  negocio: a.empresa_id ? { id: a.empresa_id, codigoAcceso: a.empresa_codigo, nombre: a.empresa_nombre } : null,
  referencia: a.referencia,
  detalle: a.detalle,
  motivo: a.motivo,
  fecha: a.creado_en,
});

export const crearServicioSuperadmin = ({ pool, tokens, secreto }: Dependencias) => {
  const actividadDe = (pagina: Pagina, filtros: Omit<repositorio.FiltrosActividad, 'limite' | 'desplazamiento'>) =>
    repositorio.listarActividad(pool, { ...filtros, ...aPagina(pagina) });

  // Negocio ya modificado, para devolverlo en la respuesta de cada acción
  const negocioActual = async (id: string) => armarNegocio((await repositorio.buscarNegocio(pool, id))!);

  const empresaBloqueada = async (tx: pg.PoolClient, id: string) => {
    const empresa = await repositorio.buscarEmpresaParaCambio(tx, id);
    if (!empresa) throw errores.noEncontrado(NEGOCIO_NO_ENCONTRADO);
    return empresa;
  };

  return {
    // Correo + contraseña + código de la app autenticadora, todo en una sola solicitud
    async iniciarSesion(entrada: { correo: string; clave: string; codigo: string }, ip: string | undefined) {
      const cuenta = await repositorio.buscarSuperadminPorCorreo(pool, entrada.correo);
      if (cuenta?.bloqueado) {
        throw errores.demasiadosIntentos(
          `Demasiados intentos fallidos. Espera ${repositorio.MINUTOS_BLOQUEO} minutos para volver a intentar.`,
        );
      }
      // Siempre se hace la comparación de la contraseña, exista o no la cuenta
      const { valida } = await verificarContrasena(entrada.clave, cuenta?.password_hash);
      const clave2 = cuenta && valida ? descifrarSecreto(cuenta.totp_secreto, secreto) : null;
      const paso = clave2 ? verificarTotp(clave2, entrada.codigo) : null;
      if (!cuenta || !valida || paso === null) {
        if (cuenta) await repositorio.registrarIntentoFallido(pool, cuenta.id);
        throw errores.noAutenticado(INCORRECTOS);
      }
      // Cada código sirve una sola vez
      if (!(await repositorio.registrarEntrada(pool, cuenta.id, paso))) {
        throw errores.noAutenticado('Ese código ya se usó. Espera el siguiente código de tu app autenticadora.');
      }
      await repositorio.registrarActividad(pool, {
        superadminId: cuenta.id,
        superadminCorreo: cuenta.correo,
        accion: 'inicio_sesion',
        detalle: { ip: ip ?? null },
      });
      return {
        mensaje: 'Autenticación exitosa',
        token: tokens.firmarSuperadmin({ superadminId: cuenta.id, version: cuenta.version_sesion }),
        expiraEnSegundos: SEGUNDOS_SESION,
        inactividadMinutos: repositorio.MINUTOS_INACTIVIDAD,
        superadmin: { id: cuenta.id, correo: cuenta.correo },
      };
    },

    // Convierte un token en la sesión vigente (la cuenta se lee de la base en cada solicitud)
    async validarSesion(token: string | undefined): Promise<SesionSuperadmin> {
      if (!token) throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');
      const datos = tokens.verificarSuperadmin(token);
      if (!datos) throw errores.noAutenticado('Sesión vencida o no válida. Inicia sesión de nuevo.');
      const cuenta = await repositorio.buscarSuperadminPorId(pool, datos.superadminId);
      if (!cuenta || cuenta.version_sesion !== datos.version) {
        throw errores.noAutenticado('Sesión no válida. Inicia sesión de nuevo.');
      }
      // Cierre automático: tras 15 minutos sin solicitudes el token deja de servir, aunque no haya vencido
      if (cuenta.inactivo || !(await repositorio.registrarActividadDeSesion(pool, cuenta.id))) {
        throw errores.noAutenticado(MENSAJE_INACTIVIDAD);
      }
      return { id: cuenta.id, correo: cuenta.correo };
    },

    // Invalida la sesión en el servidor: sube la versión, así este token y los anteriores ya no sirven
    async cerrarSesion(admin: SesionSuperadmin) {
      await repositorio.cerrarSesionSuperadmin(pool, admin.id);
      await repositorio.registrarActividad(pool, {
        superadminId: admin.id,
        superadminCorreo: admin.correo,
        accion: 'cerrar_sesion',
      });
      return { mensaje: 'Sesión cerrada' };
    },

    // Cifras para los gráficos del panel. Todo es agregado: ningún dato personal de los clientes.
    async estadisticas() {
      const e = await repositorio.estadisticasPlataforma(pool);
      const porEstado = new Map(e.porEstado.map((f) => [f.estado, f.total]));
      const porPlan = new Map(e.porPlan.map((f) => [f.plan_equipo, f]));
      const detalleIngreso = e.activosPorPlan.flatMap((f) => {
        const plan = buscarPlan(f.plan_equipo);
        // Un negocio activo de antes de los planes no tiene periodo: no hay precio con qué estimarlo
        if (!plan || !f.periodo) return [];
        const porNegocio = f.periodo === 'mensual' ? plan.precioMensual : plan.precioAnual / 12;
        return [{ plan: plan.id, periodo: f.periodo, negocios: f.negocios, ingreso: Math.round(porNegocio * f.negocios) }];
      });
      return {
        negociosNuevosPorMes: e.nuevosPorMes,
        negociosPorEstado: ['prueba', 'activo', 'vencido', 'suspendido'].map((estado) => ({
          estado,
          total: porEstado.get(estado) ?? 0,
        })),
        negociosPorPlan: PLANES.map((p) => ({
          plan: p.id,
          nombre: p.nombre,
          total: porPlan.get(p.id)?.total ?? 0,
          activos: porPlan.get(p.id)?.activos ?? 0,
        })),
        citasPorDia: e.citasPorDia,
        topDepartamentos: e.departamentos,
        // Sobre los negocios que ya pagaron o cuya prueba ya terminó
        conversionPruebaAPlan: {
          pruebasTerminadas: e.conversion.base,
          convertidos: e.conversion.convertidos,
          tasaPorcentaje: e.conversion.base ? Math.round((e.conversion.convertidos / e.conversion.base) * 1000) / 10 : null,
        },
        vencenEn7Dias: {
          total: e.porVencer[0]?.total ?? 0,
          negocios: e.porVencer.map((n) => ({
            id: n.id,
            nombre: n.nombre,
            codigoAcceso: n.codigo_acceso,
            estado: n.estado,
            diasRestantes: Math.max(0, n.dias),
            fechaFin: n.fecha_fin,
          })),
        },
        ingresoMensualEstimado: {
          estimado: true,
          moneda: 'COP',
          total: detalleIngreso.reduce((suma, f) => suma + f.ingreso, 0),
          detalle: detalleIngreso,
          nota: 'Estimado con los precios de los planes de los negocios activos (el plan anual cuenta 1/12 por mes). No incluye pruebas ni suspendidos, y no son pagos reales.',
        },
      };
    },

    // Ingresos estimados: suman el precio del plan en cada activación del historial. No son pagos
    // reales (todavía no hay pasarela), por eso todo va marcado como estimado.
    async ingresos() {
      const { meses, mesActual } = await repositorio.ingresosPorMes(pool);
      const porMes = new Map(meses.map((m) => [m.mes, { total: Number(m.total), activaciones: m.activaciones }]));

      // Los últimos 12 meses, el actual al final, con ceros donde no hubo activaciones
      const [anio, mes] = mesActual.split('-').map(Number);
      const ultimos12 = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(Date.UTC(anio, mes - 1 - (11 - i), 1));
        const clave = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        return { mes: clave, total: porMes.get(clave)?.total ?? 0, activaciones: porMes.get(clave)?.activaciones ?? 0 };
      });

      // Por año: desde el primero con activaciones hasta el actual, sin huecos
      const porAnioMapa = new Map<number, { total: number; activaciones: number }>();
      for (const m of meses) {
        const a = Number(m.mes.slice(0, 4));
        const previo = porAnioMapa.get(a) ?? { total: 0, activaciones: 0 };
        porAnioMapa.set(a, { total: previo.total + Number(m.total), activaciones: previo.activaciones + m.activaciones });
      }
      const primero = meses.length ? Number(meses[0].mes.slice(0, 4)) : anio;
      const porAnio = Array.from({ length: anio - primero + 1 }, (_, i) => {
        const a = primero + i;
        return { anio: a, total: porAnioMapa.get(a)?.total ?? 0, activaciones: porAnioMapa.get(a)?.activaciones ?? 0 };
      });

      // El mejor mes y el mejor año de todo el historial (si hay empate, el más reciente); null si no hay ingresos
      const mejor = <T extends { total: number }>(filas: T[]) =>
        filas.reduce<T | null>((m, f) => (f.total > 0 && (!m || f.total >= m.total) ? f : m), null);
      const todosLosMeses = meses.map((m) => ({ mes: m.mes, total: Number(m.total), activaciones: m.activaciones }));

      return {
        estimado: true,
        moneda: 'COP',
        total: porAnio.reduce((suma, a) => suma + a.total, 0),
        activaciones: porAnio.reduce((suma, a) => suma + a.activaciones, 0),
        porMes: ultimos12,
        porAnio,
        mejorMes: mejor(todosLosMeses),
        mejorAnio: mejor(porAnio),
        nota: 'Estimado: suma el precio del plan en el momento de cada activación (el plan anual cuenta completo el mes en que se activa). No son pagos reales. Las activaciones anteriores a este historial solo incluyen la última de cada negocio.',
      };
    },

    async resumen() {
      const r = await repositorio.resumenPlataforma(pool);
      return {
        totalNegocios: r.total,
        enPrueba: r.en_prueba,
        activos: r.activos,
        vencidos: r.vencidos,
        suspendidos: r.suspendidos,
        nuevosEsteMes: r.nuevos_mes,
        porVencerEn7Dias: r.por_vencer,
        citasHoy: r.citas_hoy,
      };
    },

    async listarNegocios(filtros: { buscar?: string; estado?: EstadoNegocio }, pagina: Pagina) {
      const filas = await repositorio.listarNegocios(pool, { ...filtros, ...aPagina(pagina) });
      return envolver(filas, filas.map(armarNegocio), pagina);
    },

    // Solo cifras del negocio: nada de nombres ni teléfonos de sus clientes
    async detalleNegocio(id: string) {
      const n = await repositorio.buscarNegocio(pool, id);
      if (!n) throw errores.noEncontrado(NEGOCIO_NO_ENCONTRADO);
      const [c, correo, reciente] = await Promise.all([
        repositorio.cifrasDeNegocio(pool, id),
        repositorio.correoAdministradora(pool, id),
        actividadDe({ pagina: 1, limite: 10 }, { empresaId: id }),
      ]);
      const base = armarNegocio(n);
      return {
        ...base,
        categoria: n.categoria,
        direccion: n.direccion,
        administradora: { nombre: n.nombre_administradora, correo },
        suscripcion: detalleSuscripcion(n),
        suspension: n.suspendida_en ? { desde: n.suspendida_en, motivo: n.suspension_motivo } : null,
        equipo: {
          activos: n.equipo_activo,
          cupo: base.planEquipo.cupo,
          administradores: c.equipo_admins,
          empleados: c.equipo_empleados,
        },
        cifras: {
          clientes: c.clientes,
          servicios: c.servicios,
          productos: c.productos,
          citas: {
            total: c.citas_total,
            confirmadas: c.citas_confirmadas,
            completadas: c.citas_completadas,
            canceladas: c.citas_canceladas,
            esteMes: c.citas_mes,
            ultima: c.ultima_cita,
          },
          ventas: { total: Number(c.ventas_total), esteMes: Number(c.ventas_mes) },
        },
        actividadReciente: reciente.map(armarActividad),
      };
    },

    // Activa o cambia el plan (misma regla que el comando dev:activar-plan). Sin planEquipo conserva el actual.
    async activarPlan(
      admin: SesionSuperadmin,
      id: string,
      d: { periodo: Periodo; planEquipo?: string; motivo?: string },
    ) {
      await enTransaccion(pool, async (tx) => {
        const empresa = await empresaBloqueada(tx, id);
        if (empresa.estado_suscripcion === 'cancelada') {
          throw errores.conflicto('Este negocio está cancelado (su cuenta fue eliminada) y no se puede activar.');
        }
        const antes = (await repositorio.buscarNegocio(tx, id))!;
        await activarPlanEmpresa(tx, id, d.periodo, d.planEquipo ?? null, 'panel');
        const despues = (await repositorio.buscarNegocio(tx, id))!;
        await repositorio.registrarActividad(tx, {
          superadminId: admin.id,
          superadminCorreo: admin.correo,
          accion: 'activar_plan',
          empresa,
          motivo: d.motivo,
          detalle: {
            antes: { estado: antes.estado, planEquipo: antes.plan_equipo, plan: antes.periodo, fechaFin: antes.fecha_fin },
            despues: { estado: despues.estado, planEquipo: despues.plan_equipo, plan: despues.periodo, fechaFin: despues.fecha_fin },
          },
        });
      });
      return { mensaje: 'Plan activado', negocio: await negocioActual(id) };
    },

    // Alarga la prueba desde su fin (o desde hoy, si ya había terminado)
    async extenderPrueba(admin: SesionSuperadmin, id: string, d: { dias: number; motivo?: string }) {
      await enTransaccion(pool, async (tx) => {
        const empresa = await empresaBloqueada(tx, id);
        if (empresa.estado_suscripcion !== 'trial') {
          throw errores.conflicto('Este negocio no está en prueba gratuita. Para darle más tiempo, actívale un plan.');
        }
        const fechas = (await repositorio.extenderPrueba(tx, id, d.dias))!;
        await repositorio.registrarActividad(tx, {
          superadminId: admin.id,
          superadminCorreo: admin.correo,
          accion: 'extender_prueba',
          empresa,
          motivo: d.motivo,
          detalle: { dias: d.dias, finAnterior: fechas.anterior, finNuevo: fechas.nueva },
        });
      });
      return { mensaje: `Prueba extendida ${d.dias} día(s)`, negocio: await negocioActual(id) };
    },

    async suspender(admin: SesionSuperadmin, id: string, motivo: string) {
      await enTransaccion(pool, async (tx) => {
        const empresa = await empresaBloqueada(tx, id);
        if (empresa.suspendida) throw errores.conflicto('Este negocio ya está suspendido.');
        const antes = (await repositorio.buscarNegocio(tx, id))!;
        await repositorio.suspenderEmpresa(tx, id, motivo);
        await repositorio.registrarActividad(tx, {
          superadminId: admin.id,
          superadminCorreo: admin.correo,
          accion: 'suspender',
          empresa,
          motivo,
          detalle: { estadoAnterior: antes.estado },
        });
      });
      return { mensaje: 'Negocio suspendido', negocio: await negocioActual(id) };
    },

    async reactivar(admin: SesionSuperadmin, id: string, motivo: string) {
      await enTransaccion(pool, async (tx) => {
        const empresa = await empresaBloqueada(tx, id);
        if (!empresa.suspendida) throw errores.conflicto('Este negocio no está suspendido.');
        const antes = (await repositorio.buscarNegocio(tx, id))!;
        await repositorio.reactivarEmpresa(tx, id);
        await repositorio.registrarActividad(tx, {
          superadminId: admin.id,
          superadminCorreo: admin.correo,
          accion: 'reactivar',
          empresa,
          motivo,
          detalle: { motivoDeLaSuspension: antes.suspension_motivo },
        });
      });
      return { mensaje: 'Negocio reactivado', negocio: await negocioActual(id) };
    },

    async listarPqrs(filtros: { estado?: EstadoPqrs; tipo?: TipoPqrs }, pagina: Pagina) {
      const filas = await pqrsRepositorio.listarTodasLasPqrs(pool, { ...filtros, ...aPagina(pagina) });
      return envolver(filas, filas.map(armarPqrs), pagina);
    },

    async detallePqrs(radicado: string) {
      const fila = await pqrsRepositorio.buscarPqrsPorRadicado(pool, radicado);
      if (!fila) throw errores.noEncontrado(PQRS_NO_ENCONTRADA);
      return armarPqrs(fila);
    },

    // Cambia el estado y, si se envía texto, guarda la respuesta (sin texto conserva la anterior)
    async responderPqrs(admin: SesionSuperadmin, radicado: string, d: { estado: EstadoPqrs; respuesta?: string }) {
      return enTransaccion(pool, async (tx) => {
        const antes = await pqrsRepositorio.buscarPqrsPorRadicado(tx, radicado, true);
        if (!antes) throw errores.noEncontrado(PQRS_NO_ENCONTRADA);
        const fila = (await pqrsRepositorio.actualizarPqrs(tx, radicado, d.estado, d.respuesta ?? null))!;
        await repositorio.registrarActividad(tx, {
          superadminId: admin.id,
          superadminCorreo: admin.correo,
          accion: 'responder_pqrs',
          referencia: radicado,
          detalle: { estadoAnterior: antes.estado, estadoNuevo: d.estado, respuesta: d.respuesta ?? null },
        });
        return { mensaje: 'PQRS actualizada', pqrs: armarPqrs(fila) };
      });
    },

    async actividad(
      filtros: { accion?: string; empresaId?: string; desde?: string; hasta?: string },
      pagina: Pagina,
    ) {
      const filas = await actividadDe(pagina, filtros);
      return envolver(filas, filas.map(armarActividad), pagina);
    },
  };
};

const detalleSuscripcion = (n: FilaDetalleNegocio) => ({
  estadoGuardado: n.estado_suscripcion,
  fechaPago: n.fecha_pago,
  fechaFin: n.fecha_fin,
  finDePrueba: n.estado_suscripcion === 'trial' ? n.trial_ends_at : null,
  diasPruebaSumados: n.dias_prueba_sumados,
});

export type ServicioSuperadmin = ReturnType<typeof crearServicioSuperadmin>;
