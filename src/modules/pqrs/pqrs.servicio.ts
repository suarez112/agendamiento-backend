import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import type { FilaUsuario } from '../cuentas/cuentas.repositorio.js';
import * as repositorio from './pqrs.repositorio.js';
import type { FilaPqrs, TipoPqrs } from './pqrs.repositorio.js';

export type EntradaPqrs = { tipo: TipoPqrs; mensaje: string; nombre?: string; contacto?: string };

export const armarPqrs = (p: FilaPqrs) => ({
  radicado: p.radicado,
  tipo: p.tipo,
  mensaje: p.mensaje,
  estado: p.estado,
  respuesta: p.respuesta,
  respondidaEn: p.respondida_en,
  creadaEn: p.creado_en,
});

export const crearServicioPqrs = ({ pool }: { pool: pg.Pool }) => ({
  // Con sesión, el nombre y el contacto son opcionales: se toman de la cuenta
  async radicar(entrada: EntradaPqrs, cuenta: FilaUsuario | null) {
    const nombre = entrada.nombre ?? cuenta?.nombre ?? undefined;
    const contacto = entrada.contacto ?? cuenta?.correo ?? cuenta?.telefono ?? undefined;
    if (!nombre) throw errores.solicitudInvalida('El campo "nombre" es obligatorio');
    if (!contacto) throw errores.solicitudInvalida('El campo "contacto" es obligatorio');
    const fila = await repositorio.insertarPqrs(pool, {
      tipo: entrada.tipo,
      mensaje: entrada.mensaje,
      nombre,
      contacto,
      usuarioId: cuenta?.id ?? null,
    });
    return {
      mensaje: `Recibimos tu ${entrada.tipo}. Guarda tu número de radicado: ${fila.radicado}.`,
      pqrs: armarPqrs(fila),
    };
  },

  async deUsuario(usuarioId: string) {
    return (await repositorio.listarPqrsDeUsuario(pool, usuarioId)).map(armarPqrs);
  },
});

export type ServicioPqrs = ReturnType<typeof crearServicioPqrs>;
