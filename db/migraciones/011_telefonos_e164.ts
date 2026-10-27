import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type pg from 'pg';

// Teléfonos en formato E.164 (ej. +573162781393) en columnas varchar(16).
// - clientes: único por negocio (empresa_id, telefono), ya no por indicativo + teléfono.
// - usuarios: único entre las cuentas de cliente (no entre administradoras).
// - lista_negra y autorizaciones_datos: solo cambia el formato (lista_negra sigue
//   siendo única por negocio, como antes).
// Un teléfono que no se puede convertir (o que chocaría con otro ya convertido) NO se
// borra: queda con solo sus dígitos y se lista en la consola. Se reconocen porque no
// empiezan con "+": SELECT ... WHERE telefono !~ '^\+'.
//
// Esta migración no importa código de src/ a propósito: debe seguir haciendo lo
// mismo aunque la aplicación cambie después.

type Fila = { id: string; telefono: string; indicativo: string | null; grupo: string };
type Tabla = { nombre: string; sql: string; unicoPor: boolean };

const TABLAS: Tabla[] = [
  {
    nombre: 'clientes',
    sql: 'SELECT id, telefono, indicativo, empresa_id AS grupo FROM clientes ORDER BY created_at, id',
    unicoPor: true,
  },
  {
    nombre: 'lista_negra',
    sql: `SELECT id, telefono, NULL AS indicativo, empresa_id AS grupo FROM lista_negra ORDER BY created_at, id`,
    unicoPor: true,
  },
  {
    nombre: 'usuarios',
    sql: `SELECT id, telefono, indicativo, rol AS grupo FROM usuarios
          WHERE telefono IS NOT NULL ORDER BY created_at, id`,
    unicoPor: true,
  },
  {
    nombre: 'autorizaciones_datos',
    sql: `SELECT id, telefono, indicativo, '' AS grupo FROM autorizaciones_datos
          WHERE telefono IS NOT NULL ORDER BY aceptado_en, id`,
    unicoPor: false,
  },
];

const aE164 = (telefono: string, indicativo: string | null) => {
  const digitos = telefono.replace(/\D/g, '');
  const codigo = (indicativo ?? '').replace(/\D/g, '') || '57';
  if (!digitos) return null;
  const candidatos = telefono.trim().startsWith('+')
    ? [`+${digitos}`]
    : [`+${codigo}${digitos}`, ...(digitos.startsWith(codigo) ? [`+${digitos}`] : [])];
  for (const candidato of candidatos) {
    const numero = parsePhoneNumberFromString(candidato);
    if (numero?.isValid()) return { telefono: numero.number, indicativo: numero.countryCallingCode };
  }
  return null;
};

export default async (db: pg.PoolClient) => {
  // La unicidad vieja de clientes (negocio + indicativo + teléfono) se reemplaza al final
  await db.query('ALTER TABLE clientes DROP CONSTRAINT uq_cliente_empresa_tel');

  const pendientes: string[] = [];
  for (const tabla of TABLAS) {
    const { rows } = await db.query<Fila>(tabla.sql);
    const usados = new Set<string>();
    const convertidas: { fila: Fila; telefono: string; indicativo: string }[] = [];
    const sinConvertir: { fila: Fila; motivo: string }[] = [];

    for (const fila of rows) {
      const nuevo = aE164(fila.telefono, fila.indicativo);
      // Solo las cuentas de cliente tienen que ser únicas entre sí
      const llave = tabla.nombre === 'usuarios' && fila.grupo !== 'cliente' ? null : `${fila.grupo}|${nuevo?.telefono}`;
      if (!nuevo) sinConvertir.push({ fila, motivo: 'no es un número válido' });
      else if (tabla.unicoPor && llave && usados.has(llave)) {
        sinConvertir.push({ fila, motivo: `repetido: otro registro ya tiene ${nuevo.telefono}` });
      } else {
        if (llave) usados.add(llave);
        convertidas.push({ fila, ...nuevo });
      }
    }

    for (const { fila, telefono, indicativo } of convertidas) {
      const conIndicativo = tabla.nombre !== 'lista_negra';
      await db.query(
        conIndicativo
          ? `UPDATE ${tabla.nombre} SET telefono = $2, indicativo = $3 WHERE id = $1`
          : `UPDATE ${tabla.nombre} SET telefono = $2 WHERE id = $1`,
        conIndicativo ? [fila.id, telefono, indicativo] : [fila.id, telefono],
      );
    }
    for (const { fila, motivo } of sinConvertir) {
      const digitos = fila.telefono.replace(/\D/g, '');
      if (digitos.length > 16) {
        throw new Error(`El teléfono "${fila.telefono}" (${tabla.nombre} ${fila.id}) es demasiado largo para guardarlo`);
      }
      await db.query(`UPDATE ${tabla.nombre} SET telefono = $2 WHERE id = $1`, [fila.id, digitos]);
      pendientes.push(`${tabla.nombre} ${fila.id}: "${fila.telefono}" (indicativo ${fila.indicativo ?? '57'}) → ${motivo}`);
    }
  }

  await db.query(`
    ALTER TABLE clientes ALTER COLUMN telefono TYPE varchar(16);
    ALTER TABLE lista_negra ALTER COLUMN telefono TYPE varchar(16);
    ALTER TABLE usuarios ALTER COLUMN telefono TYPE varchar(16);
    ALTER TABLE autorizaciones_datos ALTER COLUMN telefono TYPE varchar(16);

    ALTER TABLE clientes ADD CONSTRAINT uq_cliente_empresa_tel UNIQUE (empresa_id, telefono);
    CREATE UNIQUE INDEX usuarios_telefono_cliente_key ON usuarios (telefono) WHERE rol = 'cliente';
  `);

  if (pendientes.length) {
    console.log(`  Teléfonos que no se pudieron pasar a E.164 (${pendientes.length}), se dejaron con sus dígitos:`);
    for (const p of pendientes) console.log(`  - ${p}`);
  } else {
    console.log('  Todos los teléfonos quedaron en E.164');
  }
};
