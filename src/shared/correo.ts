import { registro } from './registro.js';

// Envío de correos detrás de una interfaz simple: el resto del código no sabe
// qué proveedor se usa. Para un proveedor real (SMTP, Resend, SendGrid…) basta
// con otra implementación de EnviadorCorreo creada en crearEnviadorCorreo.
export type Correo = { para: string; asunto: string; texto: string };

export type EnviadorCorreo = { enviar(correo: Correo): Promise<void> };

// Desarrollo y pruebas: no envía nada, imprime el correo en la consola del backend
export const crearEnviadorConsola = (): EnviadorCorreo => ({
  async enviar({ para, asunto, texto }) {
    console.log(`\n📧 Correo (no enviado, modo desarrollo)\nPara: ${para}\nAsunto: ${asunto}\n\n${texto}\n`);
  },
});

// Producción sin proveedor configurado: no envía ni muestra el contenido (puede
// llevar códigos de acceso), solo deja el aviso en el log.
const crearEnviadorSinConfigurar = (): EnviadorCorreo => ({
  async enviar({ asunto }) {
    registro.error('correo_sin_proveedor', { asunto });
  },
});

export const crearEnviadorCorreo = (nodeEnv: string): EnviadorCorreo =>
  nodeEnv === 'production' ? crearEnviadorSinConfigurar() : crearEnviadorConsola();
