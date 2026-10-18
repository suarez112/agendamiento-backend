import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './config/db.js';
import empresaRoutes from './routes/empresaRoutes.js';
import authRoutes from './routes/authRoutes.js';
import citaRoutes from './routes/citaRoutes.js';


dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Middlewares
app.use(cors());
app.use(express.json());

// Rutas de la API
app.use('/api/v1/empresas', empresaRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/citas', citaRoutes);

// Ruta de comprobación
app.get('/api/saludo', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      mensaje: '¡Servidor Backend funcionando correctamente! 🚀',
      horaBaseDatos: result.rows[0].now,
    });
  } catch (error) {
    console.error('❌ ERROR DETALLADO:', error);
    res.status(500).json({ error: 'Error de conexión con la base de datos' });
  }
});

// Arrancar servidor
app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`🚀 Servidor corriendo en puerto: ${PORT}`);
  console.log(`=================================`);
});