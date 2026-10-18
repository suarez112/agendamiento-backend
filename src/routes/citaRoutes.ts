import { Router } from 'express';
import {
  crearCita,
  listarHorasOcupadas,
  listarAgenda,
  marcarCompletada,
  cancelarCita,
} from '../controllers/citaController.js';
import { verificarToken } from '../middleware/verificarToken.js';

const router = Router();

router.post('/', crearCita);
router.get('/ocupadas', listarHorasOcupadas);
router.get('/agenda', verificarToken, listarAgenda);
router.patch('/:id/completar', verificarToken, marcarCompletada);
router.patch('/:id/cancelar', verificarToken, cancelarCita);

export default router;