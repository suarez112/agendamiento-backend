import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export const verificarToken = (req: Request, res: Response, next: NextFunction): void => {
  const encabezado = req.headers.authorization;
  const token = encabezado?.startsWith('Bearer ') ? encabezado.slice(7) : null;
  const secreto = process.env.JWT_SECRET;

  if (!token || !secreto) {
    res.status(401).json({ error: 'Sesión no válida. Inicia sesión de nuevo.' });
    return;
  }

  try {
    // Si el token es falso o venció, verify falla y cae al catch
    res.locals.barbero = jwt.verify(token, secreto);
    next();
  } catch {
    res.status(401).json({ error: 'Sesión vencida. Inicia sesión de nuevo.' });
  }
};