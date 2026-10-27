import type pg from 'pg';
import { buscarPlan, COBRO, comisionPasarela, PLANES, precioMensualPara, precioPara } from '../../config/planes.js';
import { enTransaccion } from '../../db/pool.js';
import { ZONA_PLATAFORMA } from '../../config/plataforma.js';
import { errores } from '../../shared/errores.js';
import { aIsoEnZona } from '../../shared/zonaHoraria.js';
import { verificarContrasena } from '../auth/contrasenas.js';
import { conContadorDeCuenta, type ServicioIntentos } from '../auth/intentos.js';
import type { ServicioTokens } from '../auth/tokens.js';
import { activarPlanEmpresa, type Periodo } from '../empresas/activacion.js';
import * as pqrsRepositorio from '../pqrs/pqrs.repositorio.js';
import type { EstadoPqrs, FilaPqrsSoporte, TipoPqrs } from '../pqrs/pqrs.repositorio.js';
import { descifrarSecreto, verificarTotp } from './totp.js';
import * as repositorio from './superadmin.repositorio.js';
import type { EstadoNegocio, FilaActividad, FilaDetalleNegocio, FilaNegocio } from './superadmin.repositorio.js';

export type SesionSuperadmin = { id: string; correo: string };

// intentos: contador de fallos por cuenta + IP (en la base de datos)
type Dependencias = { pool: pg.Pool; tokens: ServicioTokens; secreto: string; intentos: ServicioIntentos };
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

type GrupoActivos = { profesionales: number; periodo: 'mensual' | 'anual' | null; negocios: number };

// Ingreso mensual estimado de los negocios activos: precio de sus profesionales (el anual cuenta 1/12) y la
// comisión de la pasarela de una transacción mensual por negocio. Los activos de antes de los planes (sin periodo) no cuentan.
const ingresoMensualDe = (grupos: GrupoActivos[]) => {
  const detalle = grupos.flatMap((g) => {
    if (!g.periodo) return [];
    const porNegocio = g.periodo === 'mensual' ? precioMensualPara(g.profesionales) : precioPara(g.profesionales, 'anual') / 12;
    return [
      {
        profesionales: g.profesionales,
        periodo: g.periodo,
        negocios: g.negocios,
        ingreso: Math.round(porNegocio * g.negocios),
        comisionPasarela: comisionPasarela(porNegocio * g.negocios, g.negocios),
      },
    ];
  });
  return {
    detalle,
    bruto: detalle.reduce((suma, f) => suma + f.ingreso, 0),
    comision: detalle.reduce((suma, f) => suma + f.comisionPasarela, 0),
    negocios: detalle.reduce((suma, f) => suma + f.negocios, 0),
  };
};

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
    cupoUsado: n.cobrados,
    profesionales: n.cobrados,
    precioMensual: precioMensualPara(n.cobrados),
    municipio: n.ciudad,
    departamento: n.departamento,
    fechaRegistro: n.registro,
    zonaHoraria: n.zona_horaria,
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
  respondidaEn: aIsoEnZona(p.respondida_en, ZONA_PLATAFORMA),
  creadaEn: aIsoEnZona(p.creado_en, ZONA_PLATAFORMA),
  actualizadaEn: aIsoEnZona(p.actualizado_en, ZONA_PLATAFORMA),
  zonaHoraria: ZONA_PLATAFORMA,
});

const armarActividad = (a: FilaActividad) => ({
  id: a.id,
  superadmin: a.superadmin_correo,
  accion: a.accion,
  negocio: a.empresa_id ? { id: a.empresa_id, codigoAcceso: a.empresa_codigo, nombre: a.empresa_nombre } : null,
  referencia: a.referencia,
  detalle: a.detalle,
  motivo: a.motivo,
  fecha: aIsoEnZona(a.creado_en, ZONA_PLATAFORMA),
  zonaHoraria: ZONA_PLATAFORMA,
});

export const crearServicioSuperadmin = ({ pool, tokens, secreto, intentos }: Dependencias) => {
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
    // Los fallos se cuentan por cuenta + IP (existan o no): quien conozca el correo del dueño no puede dejarlo fuera
    // del panel, porque el bloqueo de sus intentos desde otra IP no afecta los intentos desde la IP del dueño.
    // El mensaje de bloqueo es el mismo exista o no la cuenta.
    iniciarSesion(entrada: { correo: string; clave: string; codigo: string }, ip: string | null) {
      const clave = intentos.claveDe('superadmin', `${entrada.correo}|${ip ?? ''}`);
      return conContadorDeCuenta(intentos, clave, { ruta: '/superadmin/login', ip }, () => this.entrar(entrada, ip), 'login_superadmin_fallido');
    },

    async entrar(entrada: { correo: string; clave: string; codigo: string }, ip: string | null) {
      const cuenta = await repositorio.buscarSuperadminPorCorreo(pool, entrada.correo);
      // Siempre se hace la comparación de la contraseña, exista o no la cuenta
      const { valida } = await verificarContrasena(entrada.clave, cuenta?.password_hash);
      const clave2 = cuenta && valida ? descifrarSecreto(cuenta.totp_secreto, secreto) : null;
      const paso = clave2 ? verificarTotp(clave2, entrada.codigo) : null;
      if (!cuenta || !valida || paso === null) throw errores.noAutenticado(INCORRECTOS);
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
      const ingreso = ingresoMensualDe(e.activosPorProfesionales);
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
          total: ingreso.bruto,
          comisionPasarela: ingreso.comision,
          neto: ingreso.bruto - ingreso.comision,
          detalle: ingreso.detalle,
          nota: 'Estimado con el precio por profesional de los negocios activos (el plan anual cuenta 1/12 por mes) y la comisión de la pasarela. No incluye pruebas ni suspendidos, y no son pagos reales.',
        },
      };
    },

    // Ingresos estimados: cada activación de plan y cada cargo proporcional pagado, menos la comisión estimada de
    // la pasarela (cada una es una transacción). No son pagos reales (todavía no hay pasarela): todo va marcado como estimado.
    async ingresos() {
      const [{ meses, mesActual }, activos, niveles, cargos] = await Promise.all([
        repositorio.ingresosPorMes(pool),
        repositorio.activosPorProfesionales(pool),
        repositorio.negociosPorNivel(pool),
        repositorio.cargosDelMes(pool),
      ]);
      type Cifras = { bruto: number; comisionPasarela: number; neto: number; activaciones: number; cargosPagados: number };
      const cifras = (bruto: number, activaciones: number, cargosPagados: number): Cifras => {
        const comision = comisionPasarela(bruto, activaciones + cargosPagados);
        return { bruto, comisionPasarela: comision, neto: bruto - comision, activaciones, cargosPagados };
      };
      const porMes = new Map(meses.map((m) => [m.mes, cifras(Number(m.total), m.activaciones, m.cargos)]));
      const vacio = cifras(0, 0, 0);
      // `total` repite el bruto (así lo leía la app antes de la comisión)
      const conTotal = <T extends Cifras>(c: T) => ({ ...c, total: c.bruto });

      // Los últimos 12 meses, el actual al final, con ceros donde no hubo movimiento
      const [anio, mes] = mesActual.split('-').map(Number);
      const ultimos12 = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(Date.UTC(anio, mes - 1 - (11 - i), 1));
        const clave = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        return { mes: clave, ...conTotal(porMes.get(clave) ?? vacio) };
      });

      // Por año: desde el primero con movimiento hasta el actual, sin huecos (la comisión es la suma de la de sus meses)
      const sumar = (filas: Cifras[]) =>
        filas.reduce<Cifras>(
          (t, f) => ({
            bruto: t.bruto + f.bruto,
            comisionPasarela: t.comisionPasarela + f.comisionPasarela,
            neto: t.neto + f.neto,
            activaciones: t.activaciones + f.activaciones,
            cargosPagados: t.cargosPagados + f.cargosPagados,
          }),
          vacio,
        );
      const primero = meses.length ? Number(meses[0].mes.slice(0, 4)) : anio;
      const porAnio = Array.from({ length: anio - primero + 1 }, (_, i) => {
        const a = primero + i;
        const delAnio = [...porMes].filter(([clave]) => clave.startsWith(`${a}-`)).map(([, c]) => c);
        return { anio: a, ...conTotal(sumar(delAnio)) };
      });

      // El mejor mes y el mejor año de todo el historial (si hay empate, el más reciente); null si no hay ingresos
      const mejor = <T extends { bruto: number }>(filas: T[]) =>
        filas.reduce<T | null>((m, f) => (f.bruto > 0 && (!m || f.bruto >= m.bruto) ? f : m), null);
      const todosLosMeses = [...porMes].map(([clave, c]) => ({ mes: clave, ...conTotal(c) }));
      const totales = sumar([...porMes.values()]);

      // Negocios activos: profesionales cobrados, ingreso promedio, nivel y periodo
      const mensual = ingresoMensualDe(activos);
      const conPeriodo = activos.filter((g) => g.periodo);
      const negociosActivos = conPeriodo.reduce((suma, g) => suma + g.negocios, 0);
      const profesionalesCobrados = activos.reduce((suma, g) => suma + g.cobrados_reales, 0);
      const totalActivos = activos.reduce((suma, g) => suma + g.negocios, 0);
      const porNivel = new Map(niveles.map((f) => [f.plan_equipo, f]));
      const delMes = new Map(cargos.map((c) => [c.estado, { cantidad: c.cantidad, total: Number(c.total) }]));

      return {
        estimado: true,
        moneda: 'COP',
        total: totales.bruto,
        ...totales,
        porMes: ultimos12,
        porAnio,
        mejorMes: mejor(todosLosMeses),
        mejorAnio: mejor(porAnio),
        // Negocios activos hoy (ingreso mensual estimado: el plan anual cuenta 1/12)
        profesionales: {
          cobradosEnTotal: profesionalesCobrados,
          promedioPorNegocio: totalActivos ? Math.round((profesionalesCobrados / totalActivos) * 10) / 10 : null,
        },
        ingresoPromedioPorNegocio: {
          bruto: negociosActivos ? Math.round(mensual.bruto / negociosActivos) : null,
          neto: negociosActivos ? Math.round((mensual.bruto - mensual.comision) / negociosActivos) : null,
        },
        negociosPorNivel: PLANES.map((p) => ({
          nivel: p.id,
          nombre: p.nombre,
          profesionalesDesde: p.personasDesde,
          profesionalesHasta: p.cupo,
          total: porNivel.get(p.id)?.total ?? 0,
          activos: porNivel.get(p.id)?.activos ?? 0,
        })),
        mensualVsAnual: {
          mensual: activos.filter((g) => g.periodo === 'mensual').reduce((suma, g) => suma + g.negocios, 0),
          anual: activos.filter((g) => g.periodo === 'anual').reduce((suma, g) => suma + g.negocios, 0),
        },
        cargosProporcionalesDelMes: {
          mes: mesActual,
          pendientes: delMes.get('pendiente') ?? { cantidad: 0, total: 0 },
          pagados: delMes.get('pagado') ?? { cantidad: 0, total: 0 },
        },
        nota: 'Estimado: suma el precio de cada activación de plan (el anual cuenta completo el mes en que se activa) y cada cargo proporcional pagado, menos la comisión estimada de la pasarela (2,65 % + $700 por transacción, más 19 % de IVA sobre la comisión). No son pagos reales. Las activaciones anteriores al historial solo incluyen la última de cada negocio.',
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
        suspension: n.suspendida_en ? { desde: aIsoEnZona(n.suspendida_en, n.zona_horaria), motivo: n.suspension_motivo } : null,
        equipo: {
          activos: n.equipo_activo,
          cobrados: n.cobrados,
          cupo: COBRO.maxProfesionales,
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

    // Activa o renueva el plan (misma regla que el comando dev:activar-plan): el precio y el nivel salen de los profesionales activos.
    async activarPlan(
      admin: SesionSuperadmin,
      id: string,
      d: { periodo: Periodo; motivo?: string },
    ) {
      await enTransaccion(pool, async (tx) => {
        const empresa = await empresaBloqueada(tx, id);
        if (empresa.estado_suscripcion === 'cancelada') {
          throw errores.conflicto('Este negocio está cancelado (su cuenta fue eliminada) y no se puede activar.');
        }
        const antes = (await repositorio.buscarNegocio(tx, id))!;
        await activarPlanEmpresa(tx, id, d.periodo, 'panel');
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
  finDePrueba: n.estado_suscripcion === 'trial' ? aIsoEnZona(n.trial_ends_at, n.zona_horaria) : null,
  diasPruebaSumados: n.dias_prueba_sumados,
});

export type ServicioSuperadmin = ReturnType<typeof crearServicioSuperadmin>;
