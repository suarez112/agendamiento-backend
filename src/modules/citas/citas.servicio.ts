import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { CODIGO_PG, type Consultable, enTransaccion, esErrorPg } from '../../db/pool.js';
import { errores } from '../../shared/errores.js';
import { aIsoEnZona } from '../../shared/zonaHoraria.js';
import { esE164 } from '../../shared/telefonos.js';
import type { Sesion } from '../auth/auth.servicio.js';
import type { FilaUsuario } from '../cuentas/cuentas.repositorio.js';
import { buscarSuscripcion } from '../empresas/empresas.repositorio.js';
import { SIN_RESERVAS } from '../empresas/suscripcion.js';
import type { Avisos } from '../notificaciones/notificaciones.servicio.js';
import { aceptoAmbos, type ContextoPeticion, DEBE_ACEPTAR, NUEVA_VERSION, registrarAutorizacion, tieneAutorizacionVigente } from '../legal/legal.js';
import type { DatosCitaPanel, DatosNuevaCita } from './citas.esquemas.js';
import * as repositorio from './citas.repositorio.js';
import { DIAS_RESERVA } from './citas.repositorio.js';
import { MAX_CITAS_PENDIENTES_POR_TELEFONO, mensajeTopeCitasPendientes } from '../../config/reservas.js';
import { esDiaCompleto } from '../bloqueos/bloqueos.servicio.js';
import { calcularHoras } from './disponibilidad.js';
import { mensajeFueraDePlazo } from './politica.js';
import { hora12AMinutos, hora24AMinutos, minutosAHHMM, minutosAHora12 } from './horas.js';

const HORA_OCUPADA = 'Esa hora ya está ocupada. Por favor elige otra.';
const HORA_BLOQUEADA = 'El profesional no atiende en ese horario. Por favor elige otra hora.';
const FALTAN_DATOS = 'Faltan datos para agendar la cita';

// Solo desde hoy hasta 14 días después, en la zona horaria del negocio ("AAAA-MM-DD" se compara bien como texto)
const validarFecha = (fecha: string, { hoy, ultimo_dia }: { hoy: string; ultimo_dia: string }) => {
  if (fecha < hoy) throw errores.solicitudInvalida('No se pueden agendar citas en fechas pasadas');
  if (fecha > ultimo_dia) {
    throw errores.solicitudInvalida(
      `Solo puedes reservar desde hoy hasta ${DIAS_RESERVA} días después (hasta el ${ultimo_dia}).`,
    );
  }
};

// Horas libres del profesional ese día para la duración del servicio. Es el cálculo que ve el cliente al reservar
// y el que usa el panel; vacío si el negocio no atiende ese día. panel = true (el negocio agenda): se ofrecen todas
// las horas del intervalo, también las que dejarían un hueco corto; las "pegadas" siguen marcadas como recomendadas.
const horasLibres = async (
  db: Consultable,
  datos: repositorio.DatosReserva,
  p: { barberoId: string; fecha: string },
  panel = false,
) =>
  datos.horario_apertura !== null && datos.horario_cierre !== null
    ? calcularHoras({
        apertura: hora24AMinutos(datos.horario_apertura),
        cierre: hora24AMinutos(datos.horario_cierre),
        ocupados: await repositorio.listarTramosOcupados(db, p),
        duracion: datos.duracion_min,
        intervalo: datos.intervalo_minutos,
        servicioMasCorto: Math.min(datos.servicio_mas_corto, datos.duracion_min),
        ocultarHuecosCortos: !panel,
        // Hoy no se ofrecen las horas que ya pasaron (la hora actual, al siguiente múltiplo de 10)
        desde: p.fecha === datos.hoy ? Math.ceil(datos.minutos_ahora / 10) * 10 : undefined,
      })
    : [];

// Profesional para quien agenda el personal: un empleado solo para sí mismo; un administrador, para quien elija
// (o para él, si es integrante y no envía barberoId)
const profesionalDelPanel = (sesion: Sesion, barberoId?: string) => {
  if (!sesion.esAdmin && barberoId && barberoId !== sesion.barberoId) {
    throw errores.prohibido('Solo puedes agendar citas para ti. Un administrador puede agendar para cualquier profesional.');
  }
  const elegido = sesion.esAdmin ? (barberoId ?? sesion.barberoId) : sesion.barberoId;
  if (!elegido) throw errores.solicitudInvalida('Elige el profesional en "barberoId"');
  return elegido;
};

// notificaciones: avisos push opcionales (nunca hacen fallar la reserva ni la cancelación)
export const crearServicioCitas = ({
  pool,
  notificaciones,
  maxPendientes = MAX_CITAS_PENDIENTES_POR_TELEFONO,
}: {
  pool: pg.Pool;
  notificaciones?: Avisos;
  // Citas pendientes que puede tener un teléfono en un negocio
  maxPendientes?: number;
}) => ({
  // cuenta: cliente con sesión (usa su nombre y teléfono); null = reserva como invitado
  async crear(datos: DatosNuevaCita, cuenta: FilaUsuario | null, contexto: ContextoPeticion) {
    const { empresaId, barberoId, servicioId, fecha, hora } = datos;
    // Los datos de la cuenta mandan; una cuenta antigua sin nombre o teléfono (o con un
    // teléfono que no se pudo pasar a E.164) usa los del cuerpo, ya normalizados
    const nombre = cuenta?.nombre ?? datos.nombre;
    const telefonoCuenta = cuenta && esE164(cuenta.telefono) ? cuenta.telefono : null;
    const telefono = telefonoCuenta ?? datos.telefono;
    const indicativo = (telefonoCuenta && cuenta?.indicativo) || datos.indicativo;
    if (!nombre || !telefono) throw errores.solicitudInvalida(FALTAN_DATOS);

    // Autorización de tratamiento de datos: el invitado acepta en cada reserva;
    // un cliente con cuenta solo si se publicó una versión nueva desde que aceptó
    const debeAceptar = !cuenta || !(await tieneAutorizacionVigente(pool, cuenta.id));
    if (debeAceptar && !aceptoAmbos(datos)) throw errores.solicitudInvalida(cuenta ? NUEVA_VERSION : DEBE_ACEPTAR);

    // Un negocio con la suscripción vencida no recibe reservas
    const suscripcion = await buscarSuscripcion(pool, empresaId);
    if (suscripcion && !suscripcion.habilitada) throw errores.prohibido(SIN_RESERVAS);

    // 1. El servicio y el profesional deben ser de ese negocio
    const reserva = await repositorio.buscarDatosReserva(pool, { empresaId, barberoId, servicioId, fecha });
    if (!reserva) throw errores.noEncontrado('Servicio o profesional no encontrado');

    // 2. Solo desde hoy hasta 14 días después, en la zona horaria del negocio
    validarFecha(fecha, reserva);

    // 3. El negocio debe atender ese día, y la cita caber dentro de su horario de ese día
    if (!reserva.horario_apertura || !reserva.horario_cierre) {
      throw errores.solicitudInvalida('El negocio no atiende ese día. Por favor elige otra fecha.');
    }
    const inicio = hora12AMinutos(hora) as number; // el esquema ya validó el formato
    const fin = inicio + reserva.duracion_min;
    if (inicio < hora24AMinutos(reserva.horario_apertura) || fin > hora24AMinutos(reserva.horario_cierre)) {
      throw errores.solicitudInvalida('La hora elegida está fuera del horario del negocio');
    }

    // 4. Ningún número de la lista negra del negocio
    if (await repositorio.telefonoEnListaNegra(pool, empresaId, telefono)) {
      throw errores.prohibido('No es posible agendar con este número. Comunícate con el negocio.');
    }
    const horario = { horaInicio: minutosAHHMM(inicio), horaFin: minutosAHHMM(fin) };

    // 5. Revisión de la hora, cliente y cita juntos, en una sola transacción: o se guarda
    //    todo, o nada. Las reservas de un mismo profesional se hacen de una en una, así que
    //    la hora no puede quedar tomada ni bloqueada entre la revisión y el guardado. La
    //    restricción citas_sin_solapamiento queda como última defensa.
    const citaId = randomUUID();
    try {
      await enTransaccion(pool, async (tx) => {
        if (!(await repositorio.bloquearProfesional(tx, empresaId, barberoId))) {
          throw errores.noEncontrado('Servicio o profesional no encontrado');
        }
        // Tope de citas pendientes por teléfono en este negocio (invitados y clientes con cuenta)
        await repositorio.bloquearTelefono(tx, empresaId, telefono);
        if ((await repositorio.contarCitasPendientesDeTelefono(tx, empresaId, telefono)) >= maxPendientes) {
          throw errores.conflicto(mensajeTopeCitasPendientes(maxPendientes));
        }
        if (await repositorio.chocaConBloqueo(tx, { barberoId, fecha, ...horario })) {
          throw errores.conflicto(HORA_BLOQUEADA);
        }
        if (await repositorio.chocaConCita(tx, { barberoId, fecha, ...horario })) {
          throw errores.conflicto(HORA_OCUPADA);
        }
        const clienteId = await repositorio.registrarCliente(tx, {
          id: randomUUID(),
          empresaId,
          telefono,
          indicativo,
          nombre,
          fecha,
        });
        await repositorio.insertarCita(tx, {
          id: citaId,
          empresaId,
          barberoId,
          servicioId,
          clienteId,
          fecha,
          ...horario,
          precio: reserva.precio,
          usuarioId: cuenta?.id ?? null,
        });
        // Prueba de la autorización, junto con la cita
        if (debeAceptar) {
          await registrarAutorizacion(tx, {
            canal: cuenta ? 'nueva_version' : 'reserva_invitado',
            contexto,
            usuarioId: cuenta?.id ?? null,
            telefono: cuenta ? null : telefono,
            indicativo: cuenta ? null : indicativo,
            empresaId,
            citaId,
          });
        }
      });
    } catch (error) {
      if (esErrorPg(error, CODIGO_PG.violacionExclusion)) throw errores.conflicto(HORA_OCUPADA);
      // El profesional o el servicio se eliminó mientras se reservaba
      if (esErrorPg(error, CODIGO_PG.violacionLlaveForanea)) {
        throw errores.noEncontrado('Servicio o profesional no encontrado');
      }
      throw error;
    }

    // Aviso al profesional y a los administradores, sin esperar a que termine el envío
    void notificaciones?.avisarCitaNueva(citaId);

    return {
      mensaje: 'Cita agendada',
      cita: {
        id: citaId,
        cliente: nombre,
        telefono,
        indicativo,
        servicio: reserva.servicio,
        barberoId,
        barberoNombre: reserva.barbero,
        empresaId,
        fecha,
        hora,
        precio: Number(reserva.precio),
        duracionMin: reserva.duracion_min,
        estado: 'CONFIRMADA',
        zonaHoraria: reserva.zona_horaria,
      },
    };
  },

  // Horas en que el profesional puede recibir el servicio elegido ese día, según el horario
  // del negocio, sus citas y bloqueos y la duración del servicio. Pública.
  async horasDisponibles(p: { empresaId: string; barberoId: string; servicioId: string; fecha: string }) {
    const suscripcion = await buscarSuscripcion(pool, p.empresaId);
    if (suscripcion && !suscripcion.habilitada) throw errores.prohibido(SIN_RESERVAS);

    const datos = await repositorio.buscarDatosReserva(pool, p);
    if (!datos) throw errores.noEncontrado('Servicio o profesional no encontrado');
    validarFecha(p.fecha, datos);

    const horas = await horasLibres(pool, datos, p);

    return {
      empresaId: p.empresaId,
      barberoId: p.barberoId,
      servicioId: p.servicioId,
      fecha: p.fecha,
      zonaHoraria: datos.zona_horaria,
      duracionMin: datos.duracion_min,
      intervaloMinutos: datos.intervalo_minutos,
      horas: horas.map((h) => ({ inicio: minutosAHHMM(h.inicio), hora: minutosAHora12(h.inicio), pegada: h.pegada })),
    };
  },

  // El personal agenda una cita desde el panel: un empleado solo para sí mismo y un administrador para cualquier
  // profesional del negocio. Usa las mismas horas libres y la misma revisión contra choques que las reservas, pero
  // no aplica el tope de citas pendientes por teléfono. Cliente existente o nuevo; el negocio confirma que el
  // cliente autorizó el tratamiento de sus datos y eso queda como prueba (canal registro_negocio).
  async crearDesdePanel(sesion: Sesion, datos: DatosCitaPanel, contexto: ContextoPeticion) {
    const { empresaId } = sesion;
    const barberoId = profesionalDelPanel(sesion, datos.barberoId);
    const { servicioId, fecha, hora } = datos;

    // Cliente: uno existente del negocio, o uno nuevo con nombre y teléfono
    const nuevo = datos.nombre !== undefined || datos.telefono !== undefined;
    if (datos.clienteId && nuevo) {
      throw errores.solicitudInvalida('Envía "clienteId" o el nombre y el teléfono del cliente, no los dos');
    }
    let cliente: { nombre: string; telefono: string; indicativo: string };
    if (datos.clienteId) {
      const existente = await repositorio.buscarClienteDelNegocio(pool, empresaId, datos.clienteId);
      if (!existente) throw errores.noEncontrado('Cliente no encontrado');
      cliente = existente;
    } else {
      if (!datos.nombre || !datos.telefono) {
        throw errores.solicitudInvalida('Elige un cliente existente en "clienteId" o envía su nombre y teléfono');
      }
      cliente = { nombre: datos.nombre, telefono: datos.telefono, indicativo: datos.indicativo };
    }

    const reserva = await repositorio.buscarDatosReserva(pool, { empresaId, barberoId, servicioId, fecha });
    if (!reserva) throw errores.noEncontrado('Servicio o profesional no encontrado');
    validarFecha(fecha, reserva);
    if (!reserva.horario_apertura || !reserva.horario_cierre) {
      throw errores.solicitudInvalida('El negocio no atiende ese día. Por favor elige otra fecha.');
    }
    const inicio = hora12AMinutos(hora) as number; // el esquema ya validó el formato
    const fin = inicio + reserva.duracion_min;
    if (inicio < hora24AMinutos(reserva.horario_apertura) || fin > hora24AMinutos(reserva.horario_cierre)) {
      throw errores.solicitudInvalida('La hora elegida está fuera del horario del negocio');
    }
    // Solo horas que el panel ofrece (del intervalo del negocio, no pasadas, dentro del horario y sin choques)
    if (!(await horasLibres(pool, reserva, { barberoId, fecha }, true)).some((h) => h.inicio === inicio)) {
      throw errores.conflicto('Esa hora no está disponible para este profesional y servicio. Elige una de las horas libres.');
    }
    if (await repositorio.telefonoEnListaNegra(pool, empresaId, cliente.telefono)) {
      throw errores.prohibido('Este cliente está en la lista negra del negocio.');
    }
    const horario = { horaInicio: minutosAHHMM(inicio), horaFin: minutosAHHMM(fin) };
    // Si el cliente tiene cuenta Y ya tiene relación con este negocio (lo guardó o tuvo citas), la cita queda en su
    // "Mis citas" y se le avisa. Si no, queda como de invitado y no se notifica a ninguna cuenta.
    const cuentaId = await repositorio.buscarCuentaDeClienteDelNegocio(pool, empresaId, cliente.telefono);

    // Misma revisión segura que las reservas: el profesional se bloquea y la hora se comprueba dentro de la transacción
    const citaId = randomUUID();
    try {
      await enTransaccion(pool, async (tx) => {
        if (!(await repositorio.bloquearProfesional(tx, empresaId, barberoId))) {
          throw errores.noEncontrado('Servicio o profesional no encontrado');
        }
        if (await repositorio.chocaConBloqueo(tx, { barberoId, fecha, ...horario })) throw errores.conflicto(HORA_BLOQUEADA);
        if (await repositorio.chocaConCita(tx, { barberoId, fecha, ...horario })) throw errores.conflicto(HORA_OCUPADA);
        const clienteId = await repositorio.registrarCliente(tx, { id: randomUUID(), empresaId, ...cliente, fecha });
        await repositorio.insertarCita(tx, {
          id: citaId,
          empresaId,
          barberoId,
          servicioId,
          clienteId,
          fecha,
          ...horario,
          precio: reserva.precio,
          usuarioId: cuentaId,
        });
        // Prueba de la autorización, a nombre del teléfono del cliente (no de su cuenta: esa aceptación no la dio él en la app)
        await registrarAutorizacion(tx, {
          canal: 'registro_negocio',
          contexto,
          telefono: cliente.telefono,
          indicativo: cliente.indicativo,
          empresaId,
          citaId,
          registradaPor: { barberoId: sesion.barberoId, usuarioId: sesion.usuarioId },
        });
      });
    } catch (error) {
      if (esErrorPg(error, CODIGO_PG.violacionExclusion)) throw errores.conflicto(HORA_OCUPADA);
      if (esErrorPg(error, CODIGO_PG.violacionLlaveForanea)) {
        throw errores.noEncontrado('Servicio o profesional no encontrado');
      }
      throw error;
    }

    void notificaciones?.avisarCitaNueva(citaId);
    void notificaciones?.avisarCitaCreadaPorNegocio(citaId);

    return {
      mensaje: 'Cita agendada',
      cita: {
        id: citaId,
        cliente: cliente.nombre,
        telefono: cliente.telefono,
        indicativo: cliente.indicativo,
        servicio: reserva.servicio,
        barberoId,
        barberoNombre: reserva.barbero,
        empresaId,
        fecha,
        hora,
        precio: Number(reserva.precio),
        duracionMin: reserva.duracion_min,
        estado: 'CONFIRMADA',
        zonaHoraria: reserva.zona_horaria,
      },
    };
  },

  // Horas que el personal puede ofrecer al agendar desde el panel: las del intervalo del negocio dentro del horario de
  // ese día y sin choques con citas ni bloqueos. A diferencia de la reserva del cliente no se ocultan las que dejan
  // un hueco corto; las "pegadas" siguen marcadas como recomendadas. Un empleado solo consulta las suyas.
  async horasDisponiblesPanel(sesion: Sesion, p: { barberoId?: string; servicioId: string; fecha: string }) {
    const barberoId = profesionalDelPanel(sesion, p.barberoId);
    const datos = await repositorio.buscarDatosReserva(pool, { empresaId: sesion.empresaId, barberoId, servicioId: p.servicioId, fecha: p.fecha });
    if (!datos) throw errores.noEncontrado('Servicio o profesional no encontrado');
    validarFecha(p.fecha, datos);
    const horas = await horasLibres(pool, datos, { barberoId, fecha: p.fecha }, true);
    return {
      empresaId: sesion.empresaId,
      barberoId,
      servicioId: p.servicioId,
      fecha: p.fecha,
      zonaHoraria: datos.zona_horaria,
      duracionMin: datos.duracion_min,
      intervaloMinutos: datos.intervalo_minutos,
      horas: horas.map((h) => ({ inicio: minutosAHHMM(h.inicio), hora: minutosAHora12(h.inicio), pegada: h.pegada })),
    };
  },

  // Horas tomadas de un negocio. No incluye nombres ni teléfonos de clientes.
  async horasOcupadas(empresaId: string) {
    const filas = await repositorio.listarOcupadas(pool, empresaId);
    return filas.map((r) => ({
      barberoId: r.barbero_id,
      fecha: r.fecha,
      hora: r.hora,
      duracionMin: r.duracion_min,
      estado: r.estado,
    }));
  },

  // Horarios bloqueados del equipo (semanales o de una fecha), sin el motivo
  async bloqueosPublicos(empresaId: string) {
    const filas = await repositorio.listarBloqueosPublicos(pool, empresaId);
    return filas.map((r) => ({
      barberoId: r.barbero_id,
      tipo: r.dia_semana !== null ? 'semanal' : 'fecha',
      diaSemana: r.dia_semana,
      fecha: r.fecha,
      todoElDia: esDiaCompleto(r),
      horaInicio: r.hora_inicio,
      horaFin: r.hora_fin,
    }));
  },

  // El administrador ve a todo su equipo; un barbero solo ve sus propias citas
  async agenda({ empresaId, barberoId, esAdmin }: Sesion) {
    const filas = await repositorio.listarAgenda(pool, empresaId, esAdmin ? null : barberoId);
    return filas.map((r) => ({
      id: r.id,
      cliente: r.cliente,
      telefono: r.telefono,
      servicio: r.servicio,
      barberoId: r.barbero_id,
      barberoNombre: r.barbero_nombre,
      empresaId: r.empresa_id,
      fecha: r.fecha,
      hora: r.hora,
      precio: Number(r.precio),
      duracionMin: r.duracion_min,
      estado: r.estado,
      zonaHoraria: r.zona_horaria,
      vecesReprogramada: r.veces_reprogramada,
      completadaEn: aIsoEnZona(r.completada_en, r.zona_horaria) ?? undefined,
      completadaPor: r.completada_por ?? undefined,
      canceladaEn: aIsoEnZona(r.cancelada_en, r.zona_horaria) ?? undefined,
      canceladaPor: r.cancelada_por ?? undefined,
    }));
  },

  async completar({ empresaId, barberoId, usuarioId }: Sesion, id: string) {
    const r = await repositorio.completarCita(pool, { id, empresaId, barberoId, usuarioId });
    if (!r) {
      throw errores.conflicto(
        'No se pudo completar: la cita no existe, ya fue atendida o cancelada, o no es tuya.',
      );
    }
    return {
      estado: r.estado,
      completadaEn: aIsoEnZona(r.completada_en, r.zona_horaria),
      completadaPor: r.completada_por,
      zonaHoraria: r.zona_horaria,
    };
  },

  // Un cliente con cuenta cambia la fecha u hora de su cita pendiente: mismo servicio y profesional,
  // misma duración y precio, con las reglas de las reservas (días, horario, bloqueos, otras citas) y la
  // anticipación mínima del negocio. Guarda el cambio en el historial y avisa al negocio.
  async reprogramar(usuarioId: string, citaId: string, { fecha, hora }: { fecha: string; hora: string }) {
    try {
      const r = await enTransaccion(pool, async (tx) => {
        const cita = await repositorio.buscarCitaDeCliente(tx, citaId, usuarioId, true);
        if (!cita) throw errores.noEncontrado('Cita no encontrada');
        if (cita.estado !== 'CONFIRMADA') {
          throw errores.conflicto('Solo puedes reprogramar una cita pendiente: esta ya fue atendida o cancelada.');
        }
        if (cita.empezo) throw errores.conflicto('Esta cita ya empezó y no se puede reprogramar.');
        if (cita.fuera_de_plazo) throw errores.conflicto(mensajeFueraDePlazo('reprogramar', cita.anticipacion_horas));

        const suscripcion = await buscarSuscripcion(tx, cita.empresa_id);
        if (suscripcion && !suscripcion.habilitada) throw errores.prohibido(SIN_RESERVAS);

        // El servicio y el profesional deben seguir disponibles; la cita conserva su duración y precio
        const reserva = await repositorio.buscarDatosReserva(tx, {
          empresaId: cita.empresa_id,
          barberoId: cita.barbero_id,
          servicioId: cita.servicio_id,
          fecha,
        });
        if (!reserva) {
          throw errores.conflicto('El servicio o el profesional de esta cita ya no está disponible. Comunícate con el negocio.');
        }
        validarFecha(fecha, reserva);
        if (!reserva.horario_apertura || !reserva.horario_cierre) {
          throw errores.solicitudInvalida('El negocio no atiende ese día. Por favor elige otra fecha.');
        }
        const inicio = hora12AMinutos(hora) as number; // el esquema ya validó el formato
        const fin = inicio + cita.duracion_min;
        if (inicio < hora24AMinutos(reserva.horario_apertura) || fin > hora24AMinutos(reserva.horario_cierre)) {
          throw errores.solicitudInvalida('La hora elegida está fuera del horario del negocio');
        }
        if (fecha === reserva.hoy && inicio < reserva.minutos_ahora) {
          throw errores.solicitudInvalida('La hora elegida ya pasó. Elige una hora posterior.');
        }
        const nueva = { fecha, horaInicio: minutosAHHMM(inicio), horaFin: minutosAHHMM(fin) };
        const anterior = { fecha: cita.fecha, horaInicio: cita.hora_inicio, horaFin: cita.hora_fin };
        if (nueva.fecha === anterior.fecha && nueva.horaInicio === anterior.horaInicio) {
          throw errores.solicitudInvalida('Tu cita ya está en esa fecha y hora. Elige otra.');
        }

        // Igual que al reservar: el profesional se bloquea y se revisa la hora dentro de la misma transacción
        if (!(await repositorio.bloquearProfesional(tx, cita.empresa_id, cita.barbero_id))) {
          throw errores.conflicto('El servicio o el profesional de esta cita ya no está disponible. Comunícate con el negocio.');
        }
        const franja = { barberoId: cita.barbero_id, ...nueva };
        if (await repositorio.chocaConBloqueo(tx, franja)) throw errores.conflicto(HORA_BLOQUEADA);
        if (await repositorio.chocaConCita(tx, { ...franja, excluirCitaId: cita.id })) throw errores.conflicto(HORA_OCUPADA);

        await repositorio.moverCita(tx, { id: cita.id, empresaId: cita.empresa_id, ...nueva });
        await repositorio.avanzarUltimaCita(tx, cita.empresa_id, cita.cliente_id, fecha);
        await repositorio.insertarReprogramacion(tx, { citaId: cita.id, usuarioId, anterior, nueva });
        return { cita, reserva, nueva };
      });

      // Aviso al profesional y a los administradores, sin esperar a que termine el envío
      void notificaciones?.avisarReprogramacion(citaId, { fecha: r.cita.fecha_aviso, hora: r.cita.hora_aviso });

      return {
        mensaje: 'Cita reprogramada',
        cita: {
          id: citaId,
          servicio: r.reserva.servicio,
          barberoId: r.cita.barbero_id,
          barberoNombre: r.reserva.barbero,
          empresaId: r.cita.empresa_id,
          fecha: r.nueva.fecha,
          hora: hora,
          duracionMin: r.cita.duracion_min,
          estado: 'CONFIRMADA',
          zonaHoraria: r.reserva.zona_horaria,
        },
      };
    } catch (error) {
      if (esErrorPg(error, CODIGO_PG.violacionExclusion)) throw errores.conflicto(HORA_OCUPADA);
      throw error;
    }
  },

  // 404 si la cita no existe o es de otro negocio. Se revisa antes que la suscripción.
  async exigirCita({ empresaId }: Sesion, id: string) {
    if (!(await repositorio.existeCitaDelNegocio(pool, id, empresaId))) throw errores.noEncontrado('Cita no encontrada');
  },

  async cancelar({ empresaId, barberoId, usuarioId }: Sesion, id: string) {
    const r = await repositorio.cancelarCita(pool, { id, empresaId, barberoId, usuarioId });
    // La cita existe (la ruta ya lo comprobó): solo falla si ya estaba atendida o cancelada
    if (!r) throw errores.conflicto('No se pudo cancelar: la cita ya fue atendida o cancelada.');
    // Si la cita era de un cliente con cuenta, se le avisa que el negocio la canceló
    void notificaciones?.avisarCancelacionPorNegocio(id);
    return {
      estado: r.estado,
      canceladaEn: aIsoEnZona(r.cancelada_en, r.zona_horaria),
      canceladaPor: r.cancelada_por,
      zonaHoraria: r.zona_horaria,
    };
  },
});

export type ServicioCitas = ReturnType<typeof crearServicioCitas>;
