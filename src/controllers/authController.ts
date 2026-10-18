import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';

export const loginBarbero = async (req: Request, res: Response): Promise<void> => {
  try {
    const { usuario, clave } = req.body;

    if (!usuario || !clave) {
      res.status(400).json({ error: 'Debes enviar usuario y contraseña' });
      return;
    }

    // Buscar barbero por usuario
    const userRes = await pool.query(
      'SELECT b.*, e.nombre as empresa_nombre, e.codigo_acceso as empresa_codigo FROM barberos b JOIN empresas e ON b.empresa_id = e.id WHERE LOWER(b.usuario) = LOWER($1)',
      [usuario.trim()]
    );

    if (userRes.rows.length === 0) {
      res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      return;
    }

    const barbero = userRes.rows[0];

    // Validación básica de clave (en producción se usa bcrypt)
    if (barbero.password_hash !== clave.trim()) {
      res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      return;
    }

    const secreto = process.env.JWT_SECRET;
    if (!secreto) {
      console.error('Falta JWT_SECRET en el archivo .env');
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    // El token guarda quién es el barbero y de qué negocio. Vence en 12 horas.
    const token = jwt.sign(
      { barberoId: barbero.id, empresaId: barbero.empresa_id, esAdmin: barbero.es_admin },
      secreto,
      { expiresIn: '12h' }
    );

    res.json({
      mensaje: 'Autenticación exitosa',
      token,
      barbero: {
        id: barbero.id,
        empresaId: barbero.empresa_id,
        empresaNombre: barbero.empresa_nombre,
        empresaCodigo: barbero.empresa_codigo,
        nombre: barbero.nombre,
        usuario: barbero.usuario,
        esAdmin: barbero.es_admin,
        especialidad: barbero.especialidad,
        porcentajeGanancia: parseFloat(barbero.porcentaje_ganancia),
        foto: barbero.foto_url,
      },
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};