import { z } from 'zod';
import type { Consultable } from '../../db/pool.js';

// Horario de atención por día de la semana (tabla horarios_empresa, migración 007).
// La API siempre recibe y devuelve los 7 días, de domingo (0) a sábado (6).

export const NOMBRES_DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const MENSAJE_DIA = 'Cada día del horario debe tener "dia" del 0 (domingo) al 6 (sábado)';
const MENSAJE_SIETE = 'El horario debe traer los 7 días de la semana (0 = domingo … 6 = sábado), cada uno una sola vez';

const horaOpcional = z
  .union([z.string().regex(HORA, 'Las horas del horario deben tener el formato HH:MM (24 horas)'), z.null()])
  .optional();

const esquemaDia = z.object(
  {
    dia: z.number({ error: MENSAJE_DIA }).int(MENSAJE_DIA).min(0, MENSAJE_DIA).max(6, MENSAJE_DIA),
    abierto: z.boolean({ error: 'Indica en cada día del horario si está abierto ("abierto": true o false)' }),
    apertura: horaOpcional,
    cierre: horaOpcional,
  },
  { error: MENSAJE_SIETE },
);

export type DiaHorario = { dia: number; abierto: boolean; apertura: string | null; cierre: string | null };

export const esquemaHorario = z
  .array(esquemaDia, { error: 'El campo "horario" es obligatorio' })
  .superRefine((dias, ctx) => {
    if (dias.length !== 7 || new Set(dias.map((d) => d.dia)).size !== 7) {
      ctx.addIssue({ code: 'custom', message: MENSAJE_SIETE });
      return;
    }
    for (const d of dias) {
      if (!d.abierto) continue;
      const nombre = NOMBRES_DIAS[d.dia];
      if (!d.apertura || !d.cierre) {
        ctx.addIssue({ code: 'custom', message: `El ${nombre} está abierto: indica su hora de apertura y de cierre` });
      } else if (d.cierre <= d.apertura) {
        ctx.addIssue({ code: 'custom', message: `El ${nombre}, la hora de cierre debe ser posterior a la de apertura` });
      }
    }
    if (!dias.some((d) => d.abierto)) ctx.addIssue({ code: 'custom', message: 'El negocio debe abrir al menos un día' });
  })
  // Ordenado de domingo a sábado; los días cerrados no guardan horas
  .transform((dias): DiaHorario[] =>
    [...dias]
      .sort((a, b) => a.dia - b.dia)
      .map((d) => ({
        dia: d.dia,
        abierto: d.abierto,
        apertura: d.abierto ? d.apertura! : null,
        cierre: d.abierto ? d.cierre! : null,
      })),
  );

type FilaHorario = { empresa_id: string; dia_semana: number; hora_apertura: string; hora_cierre: string };

// Días abiertos de una o varias empresas
export const listarHorarios = async (db: Consultable, empresaIds: string[]) =>
  (
    await db.query<FilaHorario>(
      `SELECT empresa_id, dia_semana, to_char(hora_apertura, 'HH24:MI') AS hora_apertura,
              to_char(hora_cierre, 'HH24:MI') AS hora_cierre
       FROM horarios_empresa WHERE empresa_id = ANY($1::varchar[])
       ORDER BY dia_semana`,
      [empresaIds],
    )
  ).rows;

// Reemplaza el horario completo. Llamar dentro de una transacción.
export const guardarHorario = async (db: Consultable, empresaId: string, horario: DiaHorario[]) => {
  await db.query('DELETE FROM horarios_empresa WHERE empresa_id = $1', [empresaId]);
  const abiertos = horario.filter((d) => d.abierto);
  await db.query(
    `INSERT INTO horarios_empresa (empresa_id, dia_semana, hora_apertura, hora_cierre)
     SELECT $1, dia, apertura, cierre
     FROM unnest($2::smallint[], $3::time[], $4::time[]) AS h (dia, apertura, cierre)`,
    [empresaId, abiertos.map((d) => d.dia), abiertos.map((d) => d.apertura), abiertos.map((d) => d.cierre)],
  );
};

// Los 7 días para la API, más los campos de antes (calculados) para que la app
// actual siga funcionando: días abiertos, la apertura más temprana y el cierre más tardío.
export const armarHorario = (filas: Pick<FilaHorario, 'dia_semana' | 'hora_apertura' | 'hora_cierre'>[]) => {
  const horario: DiaHorario[] = NOMBRES_DIAS.map((_, dia) => {
    const fila = filas.find((f) => f.dia_semana === dia);
    return { dia, abierto: !!fila, apertura: fila?.hora_apertura ?? null, cierre: fila?.hora_cierre ?? null };
  });
  const abiertos = filas.length ? filas : null;
  return {
    horario,
    diasAtencion: filas.map((f) => f.dia_semana),
    horarioApertura: abiertos ? abiertos.map((f) => f.hora_apertura).sort()[0] : null,
    horarioCierre: abiertos ? abiertos.map((f) => f.hora_cierre).sort().at(-1)! : null,
  };
};
