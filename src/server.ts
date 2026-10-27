import dotenv from 'dotenv';
import { crearApp } from './app.js';
import { cargarEntorno } from './config/entorno.js';
import { crearPool } from './db/pool.js';
import { crearServicioNotificaciones } from './modules/notificaciones/notificaciones.servicio.js';
import { iniciarRecordatorios } from './modules/notificaciones/recordatorios.js';
import { crearEnviadorPush } from './shared/push.js';
import { registro } from './shared/registro.js';

dotenv.config({ quiet: true });

const entorno = cargarEntorno();
if (entorno.JWT_SECRET.length < 32) {
  registro.warn('jwt_secret_corto', { recomendacion: 'usa al menos 32 caracteres aleatorios' });
}

if (entorno.NODE_ENV === 'production' && entorno.TRUST_PROXY === 0) {
  registro.warn('trust_proxy_sin_configurar', {
    aviso: 'TRUST_PROXY=0: si hay un proxy o balanceador delante, todos los usuarios parecerán tener su IP. Ver docs/despliegue/trust-proxy.md',
  });
}

const pool = crearPool(entorno);
const servidor = crearApp({ pool, entorno }).listen(entorno.PORT, (error) => {
  if (error) {
    registro.error('servidor_no_inicio', { mensaje: error.message });
    process.exit(1);
  }
  registro.info('servidor_iniciado', { puerto: entorno.PORT, entorno: entorno.NODE_ENV });
});

// Recordatorios push de las citas que empiezan en ~24 h, cada 15 minutos
const detenerRecordatorios = iniciarRecordatorios(
  crearServicioNotificaciones({ pool, push: crearEnviadorPush(entorno.NODE_ENV, entorno.EXPO_ACCESS_TOKEN) }),
);

// Apagado ordenado: deja terminar las solicitudes en curso y cierra la base
const apagar = (senal: string) => {
  registro.info('servidor_apagando', { senal });
  detenerRecordatorios();
  servidor.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.once('SIGTERM', () => apagar('SIGTERM'));
process.once('SIGINT', () => apagar('SIGINT'));
