import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { pool } from '../config/db.js';

const FORMATO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const FORMATO_HORA = /^\d{1,2}:\d{2} (AM|PM)$/;

// "09:40 AM" -> 580 (minutos desde la medianoche)
const horaAMinutos = (hora: string): number => {
  const [h12, resto] = hora.split(':');
  const [min, ampm] = resto.split(' ');
  let h = parseInt(h12) % 12;
  if (ampm === 'PM') h += 12;
  return h * 60 + parseInt(min);
};

// 580 -> "09:40" (formato que entiende la base de datos)
const minutosAHHMM = (total: number): string =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

export const crearCita = async (req: Request, res: Response): Promise<void> => {
  const { empresaId, barberoId, servicioId, fecha, hora, nombre, telefono } = req.body;
  // Indicativo del país (solo dígitos). Si no llega, se asume Colombia (57)
  const indicativo = String(req.body.indicativo ?? '57').replace(/\D/g, '');

  // 1. Revisamos que lleguen todos los datos
  if (!empresaId || !barberoId || !servicioId || !fecha || !hora || !nombre?.trim() || !telefono?.trim()) {
    res.status(400).json({ error: 'Faltan datos para agendar la cita' });
    return;
  }
  if (!/^\d{1,4}$/.test(indicativo)) {
    res.status(400).json({ error: 'El indicativo del país no es válido' });
    return;
  }
  if (!FORMATO_FECHA.test(fecha) || !FORMATO_HORA.test(hora)) {
    res.status(400).json({ error: 'La fecha o la hora tienen un formato incorrecto' });
    return;
  }

  try {
    // 2. El servicio y el profesional deben ser de ese negocio
    const servRes = await pool.query(
      'SELECT nombre, duracion_min, precio FROM servicios WHERE id = $1 AND empresa_id = $2',
      [servicioId, empresaId]
    );
    const barbRes = await pool.query(
      'SELECT nombre FROM barberos WHERE id = $1 AND empresa_id = $2',
      [barberoId, empresaId]
    );
    if (servRes.rows.length === 0 || barbRes.rows.length === 0) {
      res.status(404).json({ error: 'Servicio o profesional no encontrado' });
      return;
    }
    const servicio = servRes.rows[0];
    const barbero = barbRes.rows[0];

    // 3. Calculamos cuándo empieza y cuándo termina la cita
    const duracion: number = servicio.duracion_min;
    const inicioMin = horaAMinutos(hora);
    const horaInicio = minutosAHHMM(inicioMin);
    const horaFin = minutosAHHMM(inicioMin + duracion);

    // 4. ¿Esa hora ya está ocupada para ese profesional?
    const ocupado = await pool.query(
      `SELECT 1 FROM citas
       WHERE barbero_id = $1 AND fecha = $2 AND estado <> 'CANCELADA'
         AND hora_inicio < $4::time AND $3::time < hora_fin`,
      [barberoId, fecha, horaInicio, horaFin]
    );
    if (ocupado.rows.length > 0) {
      res.status(409).json({ error: 'Esa hora ya está ocupada. Por favor elige otra.' });
      return;
    }

    // 5. Guardamos cliente y cita juntos: o se guardan los dos, o ninguno
    const nom = nombre.trim();
    const tel = telefono.trim();
    const citaId = randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const clienteRes = await client.query(
        'SELECT id FROM clientes WHERE empresa_id = $1 AND telefono = $2 AND indicativo = $3',
        [empresaId, tel, indicativo]
      );
      let clienteId: string;
      if (clienteRes.rows.length === 0) {
        clienteId = randomUUID();
        await client.query(
          'INSERT INTO clientes (id, empresa_id, telefono, indicativo, nombre, total_citas, fecha_ultima_cita) VALUES ($1, $2, $3, $4, $5, 1, $6)',
          [clienteId, empresaId, tel, indicativo, nom, fecha]
        );
      } else {
        clienteId = clienteRes.rows[0].id;
        await client.query(
          'UPDATE clientes SET total_citas = total_citas + 1, fecha_ultima_cita = $1 WHERE id = $2',
          [fecha, clienteId]
        );
      }

      await client.query(
        `INSERT INTO citas (id, empresa_id, barbero_id, servicio_id, cliente_id, fecha, hora_inicio, hora_fin, precio, estado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CONFIRMADA')`,
        [citaId, empresaId, barberoId, servicioId, clienteId, fecha, horaInicio, horaFin, servicio.precio]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // 6. Respondemos con la cita en el formato que usa la app
    res.status(201).json({
      mensaje: 'Cita agendada',
      cita: {
        id: citaId,
        cliente: nom,
        telefono: tel,
        indicativo,
        servicio: servicio.nombre,
        barberoId,
        barberoNombre: barbero.nombre,
        empresaId,
        fecha,
        hora,
        precio: Number(servicio.precio),
        duracionMin: duracion,
        estado: 'CONFIRMADA',
      },
    });
  } catch (error) {
    console.error('Error al crear cita:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
  
};
// Horas ocupadas de un negocio. No incluye nombres ni teléfonos de clientes.
export const listarHorasOcupadas = async (req: Request, res: Response): Promise<void> => {
  try {
    const empresaId = req.query.empresaId;
    if (typeof empresaId !== 'string' || !empresaId) {
      res.status(400).json({ error: 'Falta el identificador del negocio' });
      return;
    }

    // "fecha >= CURRENT_DATE - 1" trae desde ayer, para no perder las citas de hoy
    // si el reloj del servidor y el de tu país no coinciden
    const result = await pool.query(
      `SELECT barbero_id,
              estado,
              to_char(fecha, 'YYYY-MM-DD') AS fecha,
              to_char(hora_inicio, 'HH12:MI AM') AS hora,
              (EXTRACT(EPOCH FROM (hora_fin - hora_inicio)) / 60)::int AS duracion_min
       FROM citas
       WHERE empresa_id = $1 AND estado <> 'CANCELADA' AND fecha >= CURRENT_DATE - 1`,
      [empresaId]
    );

    res.json(
      result.rows.map((r) => ({
        barberoId: r.barbero_id,
        fecha: r.fecha,
        hora: r.hora,
        duracionMin: r.duracion_min,
        estado: r.estado,
      }))
    );
  } catch (error) {
    console.error('Error al listar horas ocupadas:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};
// Agenda con datos completos. Solo para barberos con sesión iniciada.
export const listarAgenda = async (req: Request, res: Response): Promise<void> => {
  try {
    // El negocio sale del token, no de lo que pida la app
    const { empresaId, barberoId, esAdmin } = res.locals.barbero;

    // El administrador ve a todo su equipo; un barbero solo ve sus propias citas
    const filtroBarbero = esAdmin ? '' : 'AND c.barbero_id = $2';
    const parametros = esAdmin ? [empresaId] : [empresaId, barberoId];

    const result = await pool.query(
      `SELECT c.id, c.empresa_id, c.barbero_id, c.estado, c.precio,
              to_char(c.fecha, 'YYYY-MM-DD') AS fecha,
              to_char(c.hora_inicio, 'HH12:MI AM') AS hora,
              (EXTRACT(EPOCH FROM (c.hora_fin - c.hora_inicio)) / 60)::int AS duracion_min,
                            bc.nombre AS completada_por, c.completada_en, bx.nombre AS cancelada_por, c.cancelada_en,
              cl.nombre AS cliente, cl.telefono AS telefono,
              s.nombre AS servicio, b.nombre AS barbero_nombre
       FROM citas c
       JOIN clientes cl ON cl.id = c.cliente_id
       JOIN servicios s ON s.id = c.servicio_id
       JOIN barberos b ON b.id = c.barbero_id
              LEFT JOIN barberos bc ON bc.id = c.completada_por
       LEFT JOIN barberos bx ON bx.id = c.cancelada_por
       WHERE c.empresa_id = $1 ${filtroBarbero}
       ORDER BY c.fecha, c.hora_inicio`,
      parametros
    );

    res.json(
      result.rows.map((r) => ({
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
        completadaEn: r.completada_en ?? undefined,
        completadaPor: r.completada_por ?? undefined,
        canceladaEn: r.cancelada_en ?? undefined,
        canceladaPor: r.cancelada_por ?? undefined,
      }))
    );
  } catch (error) {
    console.error('Error al listar la agenda:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};
// Completar una cita: solo el profesional dueño de la cita
export const marcarCompletada = async (req: Request, res: Response): Promise<void> => {
  try {
    const { empresaId, barberoId } = res.locals.barbero;
    const id = String(req.params.id);

    // Se guarda el identificador del barbero; al responder se busca su nombre
    const result = await pool.query(
      `WITH actualizada AS (
         UPDATE citas
         SET estado = 'COMPLETADA',
             completada_en = NOW(),
             completada_por = $3
         WHERE id = $1 AND empresa_id = $2 AND barbero_id = $3 AND estado = 'CONFIRMADA'
         RETURNING estado, completada_en, completada_por
       )
       SELECT a.estado, a.completada_en, b.nombre AS completada_por
       FROM actualizada a
       JOIN barberos b ON b.id = a.completada_por`,
      [id, empresaId, barberoId]
    );

    if (result.rows.length === 0) {
      res.status(409).json({
        error: 'No se pudo completar: la cita no existe, ya fue atendida o cancelada, o no es tuya.',
      });
      return;
    }

    const r = result.rows[0];
    res.json({ estado: r.estado, completadaEn: r.completada_en, completadaPor: r.completada_por });
  } catch (error) {
    console.error('Error al completar la cita:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Cancelar una cita: solo el administrador del negocio
export const cancelarCita = async (req: Request, res: Response): Promise<void> => {
  try {
    const { empresaId, barberoId, esAdmin } = res.locals.barbero;
    const id = String(req.params.id);

    if (!esAdmin) {
      res.status(403).json({ error: 'Solo el administrador puede cancelar citas.' });
      return;
    }

    const result = await pool.query(
      `WITH actualizada AS (
         UPDATE citas
         SET estado = 'CANCELADA',
             cancelada_en = NOW(),
             cancelada_por = $3
         WHERE id = $1 AND empresa_id = $2 AND estado = 'CONFIRMADA'
         RETURNING estado, cancelada_en, cancelada_por
       )
       SELECT a.estado, a.cancelada_en, b.nombre AS cancelada_por
       FROM actualizada a
       JOIN barberos b ON b.id = a.cancelada_por`,
      [id, empresaId, barberoId]
    );

    if (result.rows.length === 0) {
      res.status(409).json({
        error: 'No se pudo cancelar: la cita no existe o ya fue atendida o cancelada.',
      });
      return;
    }

    const r = result.rows[0];
    res.json({ estado: r.estado, canceladaEn: r.cancelada_en, canceladaPor: r.cancelada_por });
  } catch (error) {
    console.error('Error al cancelar la cita:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};