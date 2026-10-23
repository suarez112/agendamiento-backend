import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type pg from 'pg';
import { errores } from '../../shared/errores.js';
import type { Sesion } from '../auth/auth.servicio.js';
import type { ConsultaPeriodo, ServicioCartera } from '../cartera/cartera.servicio.js';
import { neutralizarFormula } from './csv.js';
import type { ServicioReportes } from './reportes.servicio.js';

type Valor = string | number | null;
type Tabla = { titulo: string; columnas: string[]; filas: Valor[][] };
type Informe = { negocio: string; desde: string; hasta: string; resumen: [string, Valor][]; tablas: Tabla[] };

export type FormatoReporte = 'xlsx' | 'pdf';

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const pct = (n: number | null | undefined) => (n === null || n === undefined ? 'n/d' : `${n} %`);

// Reporte del período elegido en Excel o PDF, con los datos de la cartera y de los reportes. Lo arma
// con los mismos servicios que sus endpoints, así las cifras coinciden con lo que ve la app.
export const crearServicioExportacion = ({
  pool,
  reportes,
  cartera,
}: {
  pool: pg.Pool;
  reportes: ServicioReportes;
  cartera: ServicioCartera;
}) => {
  const armarInforme = async (sesion: Sesion, consulta: ConsultaPeriodo): Promise<Informe> => {
    const e = sesion.empresaId;
    const [negocio, resumen, ocupacion, rentables, demanda, mejores, retencion, tendencia] = await Promise.all([
      pool.query<{ nombre: string }>('SELECT nombre FROM empresas WHERE id = $1', [e]),
      cartera.resumenPeriodo(sesion, consulta),
      reportes.ocupacion(e, consulta),
      reportes.serviciosRentables(e, consulta),
      reportes.demanda(e, consulta),
      reportes.mejoresClientes(e, consulta),
      reportes.retencionClientes(e, consulta),
      reportes.tendencia(e, consulta),
    ]);
    if (!negocio.rows[0]) throw errores.noEncontrado('Establecimiento no encontrado');

    const comparacion = resumen.comparacion;
    const tablas: Tabla[] = [
      {
        titulo: 'Profesionales',
        columnas: ['Profesional', 'Citas', 'Ventas', 'Ganancia'],
        filas: resumen.porProfesional.map((p) => [p.nombre, p.citas, p.ventas, 'ganancia' in p ? (p.ganancia as number) : null]),
      },
      {
        titulo: 'Pago a profesionales',
        columnas: ['Profesional', '% de ganancia', 'Citas', 'Ventas', 'A pagar'],
        filas: (resumen.pagoProfesionales?.detalle ?? []).map((p) => [p.nombre, p.porcentajeGanancia, p.citas, p.ventas, p.aPagar]),
      },
      {
        titulo: 'Ventas por día',
        columnas: ['Fecha', 'Citas', 'Ventas'],
        filas: resumen.ventasPorDia.map((d) => [d.fecha, d.citas, d.ventas]),
      },
      {
        titulo: 'Servicios más vendidos',
        columnas: ['Servicio', 'Cantidad', 'Ventas'],
        filas: resumen.serviciosMasVendidos.map((s) => [s.nombre, s.cantidad, s.ventas]),
      },
      {
        titulo: 'Servicios rentables',
        columnas: ['Servicio', 'Citas', 'Ingresos', 'Horas trabajadas', 'Ingreso por hora', 'Ticket promedio'],
        filas: rentables.servicios.map((s) => [s.nombre, s.citas, s.ingresos, s.horasTrabajadas, s.ingresoPorHora, s.ticketPromedio]),
      },
      {
        titulo: 'Ocupación por profesional',
        columnas: ['Profesional', 'Horas disponibles', 'Horas ocupadas', 'Ocupación (%)'],
        filas: ocupacion.porProfesional.map((p) => [p.nombre, p.horasDisponibles, p.horasOcupadas, p.porcentajeOcupacion]),
      },
      {
        titulo: 'Demanda por día de la semana',
        columnas: ['Día', 'Citas'],
        filas: demanda.porDiaSemana.map((d) => [DIAS[d.dia], d.citas]),
      },
      {
        titulo: 'Clientes que más gastan',
        columnas: ['Cliente', 'Visitas', 'Gasto', 'Ticket promedio', 'Última visita'],
        filas: mejores.masGastan.map((c) => [c.nombre, c.visitas, c.gasto, c.ticketPromedio, c.ultimaVisita]),
      },
      {
        titulo: 'Clientes que más vienen',
        columnas: ['Cliente', 'Visitas', 'Gasto', 'Ticket promedio', 'Última visita'],
        filas: mejores.masVienen.map((c) => [c.nombre, c.visitas, c.gasto, c.ticketPromedio, c.ultimaVisita]),
      },
      {
        titulo: 'Clientes que volvieron',
        columnas: ['Grupo', 'Clientes', 'Porcentaje'],
        filas: [
          ['Volvieron (2 o más citas)', retencion.volvieron, retencion.porcentajeVolvieron],
          ['Una sola vez', retencion.unaSolaVez, retencion.porcentajeUnaSolaVez],
        ],
      },
      {
        titulo: 'Tendencia mes a mes',
        columnas: ['Mes', 'Ventas', 'Citas', 'Completadas', 'Canceladas', 'Variación ventas (%)', 'Variación citas (%)'],
        filas: tendencia.meses.map((m) => [m.mes, m.ventas, m.citas, m.completadas, m.canceladas, m.variacionVentas, m.variacionCitas]),
      },
    ];

    const resumenClave: [string, Valor][] = [
      ['Ventas totales', resumen.totalVentas],
      ['Ganancia del negocio', resumen.gananciaNegocio],
      ['Citas completadas', resumen.citasCompletadas],
      ['Ticket promedio', resumen.ticketPromedio],
      ['Citas canceladas', `${resumen.cancelaciones.canceladas} de ${resumen.cancelaciones.totalCitas} (${pct(resumen.cancelaciones.tasaPorcentaje)})`],
      ['Clientes nuevos', resumen.clientes.nuevos],
      ['Clientes recurrentes', resumen.clientes.recurrentes],
      ['Ocupación del equipo', pct(ocupacion.total.porcentajeOcupacion)],
    ];
    if (comparacion) {
      resumenClave.push(
        [`Ventas frente a ${comparacion.periodoAnterior.desde} a ${comparacion.periodoAnterior.hasta}`, pct(comparacion.variacionPorcentaje.ventas)],
        ['Citas frente al período anterior', pct(comparacion.variacionPorcentaje.citas)],
      );
    }

    return {
      negocio: negocio.rows[0].nombre,
      desde: resumen.desde,
      hasta: resumen.hasta,
      resumen: resumenClave,
      tablas: tablas.filter((t) => t.filas.length > 0),
    };
  };

  // Un texto que empieza con = + - @ lo ejecutaría Excel como fórmula (los nombres de clientes los escribe
  // cualquiera): se neutraliza igual que en el CSV
  const aCelda = (v: Valor) => (typeof v === 'string' ? neutralizarFormula(v) : v);

  const aExcel = async (i: Informe) => {
    const libro = new ExcelJS.Workbook();
    libro.creator = 'AgendaYa';
    const hoja = libro.addWorksheet('Resumen');
    hoja.addRow([`Reporte de ${neutralizarFormula(i.negocio)}`]).font = { bold: true, size: 14 };
    hoja.addRow([`Período: ${i.desde} a ${i.hasta}`]);
    hoja.addRow([]);
    for (const [clave, valor] of i.resumen) hoja.addRow([clave, aCelda(valor)]).getCell(1).font = { bold: true };
    hoja.getColumn(1).width = 52;
    hoja.getColumn(2).width = 22;
    for (const t of i.tablas) {
      const h = libro.addWorksheet(t.titulo.slice(0, 31));
      h.addRow(t.columnas).font = { bold: true };
      for (const fila of t.filas) h.addRow(fila.map(aCelda));
      t.columnas.forEach((c, n) => {
        h.getColumn(n + 1).width = Math.max(14, Math.min(40, c.length + 4));
      });
      h.getColumn(1).width = 30;
    }
    return Buffer.from(await libro.xlsx.writeBuffer());
  };

  const aPdf = (i: Informe) =>
    new Promise<Buffer>((resolver, rechazar) => {
      const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Reporte de ${i.negocio}`, Author: 'AgendaYa' } });
      const trozos: Buffer[] = [];
      doc.on('data', (t: Buffer) => trozos.push(t));
      doc.on('end', () => resolver(Buffer.concat(trozos)));
      doc.on('error', rechazar);

      const ancho = doc.page.width - 80;
      const texto = (v: Valor) => (v === null ? '' : String(v));
      const asegurarEspacio = (alto: number) => {
        if (doc.y + alto > doc.page.height - 50) doc.addPage();
      };

      doc.font('Helvetica-Bold').fontSize(18).text(`Reporte de ${i.negocio}`);
      doc.font('Helvetica').fontSize(11).text(`Período: ${i.desde} a ${i.hasta}`).moveDown();
      doc.font('Helvetica-Bold').fontSize(13).text('Resumen').moveDown(0.3);
      doc.fontSize(10);
      for (const [clave, valor] of i.resumen) {
        asegurarEspacio(16);
        const y = doc.y;
        doc.font('Helvetica').text(clave, 40, y, { width: ancho * 0.65, lineBreak: false, ellipsis: true });
        doc.font('Helvetica-Bold').text(texto(valor), 40 + ancho * 0.65, y, { width: ancho * 0.35, lineBreak: false, ellipsis: true });
        doc.y = y + 15;
      }

      for (const t of i.tablas) {
        asegurarEspacio(60);
        doc.moveDown().font('Helvetica-Bold').fontSize(13).text(t.titulo, 40).moveDown(0.3);
        const col = ancho / t.columnas.length;
        const fila = (valores: string[], negrita: boolean) => {
          asegurarEspacio(16);
          const y = doc.y;
          doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
          valores.forEach((v, n) => doc.text(v, 40 + n * col, y, { width: col - 6, lineBreak: false, ellipsis: true }));
          doc.y = y + 14;
        };
        fila(t.columnas, true);
        for (const f of t.filas) fila(f.map(texto), false);
      }
      doc.end();
    });

  return {
    async exportar(sesion: Sesion, consulta: ConsultaPeriodo, formato: FormatoReporte) {
      const informe = await armarInforme(sesion, consulta);
      return {
        archivo: `reporte-${informe.desde}-a-${informe.hasta}.${formato}`,
        tipo: formato === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf',
        contenido: formato === 'xlsx' ? await aExcel(informe) : await aPdf(informe),
      };
    },
  };
};

export type ServicioExportacion = ReturnType<typeof crearServicioExportacion>;
