import dotenv from 'dotenv';
import { cargarEntornoBaseDeDatos } from '../config/entorno.js';
import {
  carpetaRespaldoPorDefecto,
  convertirFotos,
  type EstadoFoto,
  respaldoDentroDeSubidas,
  revisarFotos,
} from '../modules/empresas/optimizacionFotos.js';
import { confirmar, registrarComandoSinFallar } from './comandos.js';
import { crearPool } from './pool.js';

// npm run fotos:optimizar [-- --simulacro] [--respaldo=CARPETA]
// Convierte a WebP y reduce al tamaño de pantalla las fotos ya guardadas (negocios, equipo y productos) y actualiza su
// ruta en la base. Primero muestra cuántas hay por convertir y pide confirmación; antes de tocar cada foto copia la
// original a la carpeta de respaldo (por defecto <CARPETA_SUBIDAS>-respaldo/<fecha y hora>, fuera de la carpeta
// pública). Se puede correr varias veces: lo que ya está optimizado no se toca. Nunca se ejecuta solo (no lo llaman
// el arranque, el build ni las migraciones). Funciona también en producción, siempre con confirmación, y queda en la
// actividad del superadmin (B-6). Con --simulacro solo muestra qué fotos convertiría, sin preguntar ni cambiar nada.
dotenv.config({ quiet: true });

const USO = `Uso: npm run fotos:optimizar [-- --simulacro] [--respaldo=CARPETA]

  --simulacro         solo muestra qué fotos convertiría; no pregunta ni cambia nada
  --respaldo=CARPETA  dónde guardar la copia de las originales
                      (por defecto <CARPETA_SUBIDAS>-respaldo/<fecha y hora>)`;

const argumentos = process.argv.slice(2);
const opcionesRespaldo = argumentos.filter((a) => a.startsWith('--respaldo='));
const opcionRespaldo = opcionesRespaldo[0]?.slice('--respaldo='.length).trim();
const simulacro = argumentos.includes('--simulacro');
const valido =
  argumentos.every((a) => a === '--simulacro' || a.startsWith('--respaldo=')) &&
  argumentos.filter((a) => a === '--simulacro').length <= 1 &&
  opcionesRespaldo.length <= 1 &&
  (opcionesRespaldo.length === 0 || !!opcionRespaldo);
if (!valido) {
  console.error(USO);
  process.exit(1);
}

const carpetaSubidas = process.env.CARPETA_SUBIDAS?.trim() || 'uploads';
const carpetaRespaldo = opcionRespaldo || carpetaRespaldoPorDefecto(carpetaSubidas);
if (respaldoDentroDeSubidas(carpetaSubidas, carpetaRespaldo)) {
  console.error(`✖ La carpeta de respaldo no puede estar dentro de la carpeta de fotos (${carpetaSubidas}): se publicaría en /uploads.`);
  process.exit(1);
}

const NOMBRES: Record<EstadoFoto, string> = {
  pendiente: 'por convertir',
  ya_optimizada: 'ya optimizadas',
  externa: 'direcciones web externas (no se tocan)',
  sin_archivo: 'sin archivo en el disco (no se tocan)',
  ilegible: 'archivos que no se pueden leer como imagen (no se tocan)',
};
const megas = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

const pool = crearPool(cargarEntornoBaseDeDatos());

try {
  const { fotos, pendientes } = await revisarFotos(pool, carpetaSubidas);
  console.log(`Fotos revisadas en ${carpetaSubidas}: ${fotos.length}`);
  for (const estado of Object.keys(NOMBRES) as EstadoFoto[]) {
    const n = fotos.filter((f) => f.estado === estado).length;
    if (n) console.log(`  ${NOMBRES[estado]}: ${n}`);
  }

  if (!pendientes.length) {
    console.log('✔ No hay fotos por convertir. No se cambió nada.');
  } else {
    const peso = pendientes.reduce((total, f) => total + f.bytes, 0);
    if (simulacro) {
      // Solo muestra qué haría: nunca pregunta ni convierte
      for (const f of pendientes) console.log(`  ${f.tipo} ${f.id} ${f.ruta} (${megas(f.bytes)})`);
      console.log(
        `Simulacro: se convertirían ${pendientes.length} foto(s) (${megas(peso)}) a WebP, con copia de las originales en ` +
          `${carpetaRespaldo}. No se cambió nada.`,
      );
    } else if (
      !(await confirmar(
        `¿Convertir ${pendientes.length} foto(s) (${megas(peso)}) a WebP y reducirlas al tamaño de pantalla? ` +
          `Antes se copiarán las originales a ${carpetaRespaldo}.`,
      ))
    ) {
      console.log('Cancelado: no se cambió nada.');
    } else {
      const r = await convertirFotos(pool, pendientes, { carpetaSubidas, carpetaRespaldo });
      console.log(`✔ Convertidas: ${r.convertidas} de ${pendientes.length}. Espacio: ${megas(r.bytesAntes)} → ${megas(r.bytesDespues)}.`);
      if (r.cambiadas) console.log(`  ${r.cambiadas} cambiaron mientras tanto (alguien subió otra foto) y se dejaron como estaban.`);
      if (r.fallidas) {
        console.error(`  ⚠ ${r.fallidas} no se pudieron convertir y quedaron como estaban.`);
        process.exitCode = 1;
      }
      console.log(`  Copia de las originales: ${r.carpetaRespaldo}`);
      if (r.convertidas || r.cambiadas || r.fallidas) {
        await registrarComandoSinFallar(pool, {
          comando: 'fotos:optimizar',
          accion: 'optimizar_fotos',
          detalle: {
            convertidas: r.convertidas,
            cambiadas: r.cambiadas,
            fallidas: r.fallidas,
            bytesAntes: r.bytesAntes,
            bytesDespues: r.bytesDespues,
          },
        });
      }
    }
  }
} catch (error) {
  console.error(`✖ ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
