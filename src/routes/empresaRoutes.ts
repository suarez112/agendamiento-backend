import { Router } from 'express';
import { validarCodigoEmpresa } from '../controllers/empresaController.js';

const router = Router();

router.get('/validar/:codigo', validarCodigoEmpresa);

export default router;
