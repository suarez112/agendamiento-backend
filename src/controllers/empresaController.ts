import { Request, Response } from 'express';
import { pool } from '../config/db.js';

export const validarCodigoEmpresa = async (req: Request, res: Response): Promise<void> => {
  try {
    const { codigo } = req.params;
    
    // Asegurar que sea una cadena simple antes de aplicar trim()
    const codigoStr = Array.isArray(codigo) ? codigo[0] : codigo;
    const codLimpio = (codigoStr || '').trim().toUpperCase();

    // Buscar empresa
    const empresaRes = await pool.query(
      'SELECT * FROM empresas WHERE codigo_acceso = $1',
      [codLimpio]
    );

    if (empresaRes.rows.length === 0) {
      res.status(404).json({ error: 'Establecimiento no encontrado' });
      return;
    }

    const empresa = empresaRes.rows[0];

    // Cargar barberos de esa empresa
    const barberosRes = await pool.query(
      'SELECT id, nombre, usuario, es_admin, especialidad, porcentaje_ganancia, foto_url FROM barberos WHERE empresa_id = $1',
      [empresa.id]
    );

    // Cargar servicios de esa empresa
    const serviciosRes = await pool.query(
      'SELECT id, nombre, duracion_min, precio FROM servicios WHERE empresa_id = $1',
      [empresa.id]
    );
    
        res.json({
      empresa: {
        id: empresa.id,
        nombre: empresa.nombre,
        codigoAcceso: empresa.codigo_acceso,
        colorPrimario: empresa.color_primario,
        colorSecundario: empresa.color_secundario,
        // la base manda "08:00:00"; la app usa "08:00"
        horarioApertura: String(empresa.horario_apertura).slice(0, 5),
        horarioCierre: String(empresa.horario_cierre).slice(0, 5),
      },
      barberos: barberosRes.rows.map((b) => ({
        id: b.id,
        nombre: b.nombre,
        usuario: b.usuario,
        clave: '', // por seguridad, el servidor nunca envía contraseñas
        esAdmin: b.es_admin,
        especialidad: b.especialidad ?? '',
        equipo: `${empresa.nombre} TEAM`,
        porcentajeGanancia: Number(b.porcentaje_ganancia),
        foto: b.foto_url ?? undefined,
      })),
      servicios: serviciosRes.rows.map((s) => ({
        id: s.id,
        nombre: s.nombre,
        duracion: `${s.duracion_min} min`,
        precio: Number(s.precio),
      })),
    });
   } catch (error) {
    console.error('Error al validar empresa:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};