import { Router } from 'express';
import { loginBarbero } from '../controllers/authController.js';

const router = Router();

router.post('/login', loginBarbero);

export default router;