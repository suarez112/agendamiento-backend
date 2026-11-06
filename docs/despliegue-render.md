# Publicar la API en Render

Esta guía explica, paso a paso, cómo poner la API en internet con Render usando el archivo `render.yaml` (un "Blueprint":
una receta que le dice a Render qué crear). No necesitas saber de servidores.

**Qué crea el Blueprint**

| Pieza | Nombre en Render | Para qué |
| --- | --- | --- |
| Servicio web (Node, plan Starter, Virginia) | `agendality-api` | La API. Responde en `https://api.agendality.com` |
| Base de datos PostgreSQL (plan Basic 256 MB, Virginia) | `agendality-db` | Guarda todos los datos. Solo la ve tu servicio (red interna) |
| Disco de 1 GB | `subidas` | Guarda las fotos que suben los negocios. Sin disco se borrarían en cada despliegue |

**Qué pasa en cada despliegue** (solo cuando tú lo lanzas con **Manual Deploy**; unir a `main` no publica nada, ver la sección 5):

1. Render descarga el código y lo compila (`npm ci --include=dev && npm run build`).
2. Aplica las migraciones pendientes de la base (`npm run db:migrate`). Si una falla, el despliegue se detiene y **la versión anterior
   sigue funcionando**: no se pierde nada.
3. Arranca la versión nueva (`npm start`) y espera a que `GET /salud` responda `{ "estado": "ok" }` antes de enviarle usuarios.

---

## 1. Crear todo con el Blueprint

1. Sube a GitHub la rama `main` con el archivo `render.yaml`.
2. En [dashboard.render.com](https://dashboard.render.com): **New** → **Blueprint**.
3. Conecta tu cuenta de GitHub y elige el repositorio `agendamiento-backend`.
4. Render lee `render.yaml` y te muestra lo que va a crear. Te pedirá las variables marcadas para llenar a mano (ver la tabla de abajo).
5. Pulsa **Apply**. La primera vez tarda unos minutos: crea la base, compila, migra y arranca.

## 2. Variables de entorno

### Las que llenas tú

Render te las pide al crear el Blueprint. **Todas son opcionales**: si no tienes el dato, déjalas en blanco. Si el Blueprint ya
estaba creado, Render no las pide: agrégalas a mano en el servicio → **Environment** → **Add Environment Variable** y luego despliega.

| Variable | Qué es | De dónde sale |
| --- | --- | --- |
| `RESEND_API_KEY` | Clave secreta de [Resend](https://resend.com) para enviar los correos del sistema (recuperar la contraseña y avisos de la prueba gratuita). **Sin ella no se envía ningún correo** y el registro muestra `correo_sin_proveedor` | En resend.com: **API Keys** → **Create API Key** con permiso **Sending access** (solo enviar) y, si puedes, limitada al dominio `agendality.com`. Empieza con `re_`. Cópiala solo en Render: nunca en el código ni en el repositorio |
| `URL_PAGOS` | Página donde un administrador activa su plan. Aparece en los correos de la prueba gratuita ("Activa tu plan aquí"). Ej. `https://agendality.com/pagos` | Es una página de tu sitio web o de la app. Si aún no existe, déjala en blanco |
| `EXPO_ACCESS_TOKEN` | Token para enviar notificaciones push con Expo | En [expo.dev](https://expo.dev): tu cuenta → **Access Tokens** → **Create token**. Solo hace falta si activaste "Enhanced security for push notifications" en Expo; si no, déjala en blanco |

### Las que genera Render (no las toques)

| Variable | Qué es |
| --- | --- |
| `JWT_SECRET` | Firma las sesiones. Si la cambias, todos tienen que volver a iniciar sesión |
| `RECUPERACION_SECRET` | Protege los códigos para recuperar la contraseña |
| `TOTP_SECRET` | Cifra la verificación en dos pasos del superadmin. **Nunca la cambies ni la regeneres**: tu app autenticadora dejaría de servir para entrar. Si algún día hace falta cambiarla, lee "TOTP_SECRET" en `AGENTS.md` (`npm run db:recifrar-2fa`) |

### Correo (ya vienen en `render.yaml`)

| Variable | Valor | Qué es |
| --- | --- | --- |
| `CORREO_REMITENTE` | `Agendality <no-reply@agendality.com>` | Quién envía los correos. Es obligatoria cuando hay `RESEND_API_KEY` (sin ella el servidor no arranca) |
| `CORREO_RESPONDER_A` | `soporte@agendality.com` | A dónde llegan las respuestas de las personas (reply-to) |

**Antes de poner la clave, verifica el dominio en Resend**: **Domains** → **Add Domain** → `agendality.com`, y crea en tu DNS los
registros que Resend te muestre (SPF, DKIM y, recomendado, DMARC). Hasta que aparezca como **Verified**, Resend rechaza los
correos; el usuario sigue recibiendo la respuesta de siempre y el registro muestra `correo_no_enviado` con el código HTTP.

Render crea cada una una sola vez, al azar (44 caracteres), y las guarda. Puedes verlas en el servicio → **Environment**, pero no
las copies en ningún archivo ni las compartas.

### Las que salen de la base de datos (automáticas)

`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` y `DB_PASSWORD` se llenan solas con los datos de la **conexión interna** de
`agendality-db` (la misma de su "Internal Database URL"). La conexión interna va por la red privada de Render: es más rápida y la base
no queda expuesta a internet.

### Las que ya vienen escritas en `render.yaml`

| Variable | Valor | Por qué |
| --- | --- | --- |
| `NODE_ENV` | `production` | Activa las protecciones de producción |
| `NODE_VERSION` | `24` | Versión de Node con la que se probó |
| `TRUST_PROXY` | `1` | Render pone un balanceador delante de la API: así la API ve la IP real de cada persona |
| `DETRAS_DE_CLOUDFLARE` | `false` | Cámbiala solo si pones Cloudflare con la nube naranja (ver el paso 3) |
| `CORS_ORIGINS` | `https://agendality.com,https://www.agendality.com` | Las únicas páginas web que pueden usar la API. La app del celular no se ve afectada |
| `URL_PUBLICA` | `https://api.agendality.com` | Para armar las direcciones de las fotos |
| `ENLACE_PUBLICO_BASE` | `agendality.com` | Enlace que comparte cada negocio: `https://agendality.com/CODIGO` |
| `CARPETA_SUBIDAS` | `/var/data/uploads` | Carpeta de las fotos, dentro del disco |
| `PROVEEDOR_PAGO` | `manual` | Pagos por Nequi, llave Bre-B o QR, verificados por ti en el panel |
| `JWT_EXPIRA_EN` | `12h` | Cuánto dura una sesión |

Si cambias una variable en Render, el servicio se reinicia solo con el valor nuevo.

## 3. Conectar el dominio `api.agendality.com`

El Blueprint ya agrega `api.agendality.com` al servicio. Falta decirle a internet que ese nombre apunta a Render:

1. En Render: servicio `agendality-api` → **Settings** → **Custom Domains**. Verás `api.agendality.com` y la dirección a la que debe
   apuntar (algo como `agendality-api.onrender.com`).
2. Entra a donde compraste el dominio (GoDaddy, Namecheap, Hostinger, Cloudflare…) → **DNS** → agrega un registro:
   - Tipo: `CNAME`
   - Nombre / Host: `api`
   - Valor / Destino: `agendality-api.onrender.com` (el que te muestra Render)
3. Vuelve a Render y pulsa **Verify**. Puede tardar desde minutos hasta unas horas.
4. Render crea solo el certificado HTTPS (el candado). No tienes que hacer nada más: además, Render redirige `http://` a `https://`.

**Si tu DNS está en Cloudflare**: deja el registro en **DNS only** (nube gris). Si lo pones en **Proxied** (nube naranja), cambia en
Render `TRUST_PROXY` a `2` y `DETRAS_DE_CLOUDFLARE` a `true` (ver `docs/despliegue/trust-proxy.md`).

**Comprobar**: abre `https://api.agendality.com/salud` en el navegador. Debe mostrar `{"estado":"ok"}`.

## 4. Crear tu superadmin (con verificación en dos pasos)

El superadmin no se crea desde la app: solo con un comando, que genera la contraseña y la clave del segundo paso al azar (nada queda
escrito en el código).

1. Ten a mano tu celular con Google Authenticator (o Authy, Microsoft Authenticator…).
2. En Render: servicio `agendality-api` → **Shell**.
3. Escribe (con tu correo):

   ```bash
   NODE_ENV=development npm run dev:crear-superadmin -- tu-correo@agendality.com
   ```

   `NODE_ENV=development` solo vale para este comando: el servidor sigue en producción. Hace falta porque los comandos que crean
   accesos se niegan a correr en producción por accidente; aquí lo haces a propósito y queda anotado en el registro de actividad.
4. El comando muestra **una sola vez**:
   - un código QR: escanéalo con tu app autenticadora (si no se ve bien en la Shell, escribe a mano la clave que aparece debajo,
     `F7DO BPG2 …`, en la opción "Introducir una clave de configuración");
   - la contraseña: guárdala en un gestor de contraseñas.
5. Borra la imagen del QR que el comando guardó en el servidor:

   ```bash
   rm -rf secretos-superadmin
   ```

6. Entra al panel con tu correo, la contraseña y el código de 6 dígitos de la app.

Si pierdes la contraseña o el celular: `NODE_ENV=development npm run dev:restablecer-superadmin -- tu-correo@agendality.com`
(agrega `--totp` para una clave nueva del segundo paso) y otra vez `rm -rf secretos-superadmin`.

## 5. Desplegar a mano y revertir

El despliegue automático está apagado (`autoDeployTrigger: "off"` en `render.yaml`): unir un Pull Request a `main` **no publica
nada**. Tú decides cuándo.

**Antes de desplegar migraciones nuevas** (archivos nuevos en `db/migraciones/`), saca una copia de la base:

1. Base `agendality-db` → **Recovery** → **Create export**. Cuando termine, descarga el archivo (`.dir.tar.gz`) desde la tabla de esa
   página. Render lo guarda 7 días; guárdalo tú también.
2. Anota la hora: con **Point-in-Time Recovery** (misma página, **Restore Database**) puedes crear una base **nueva** con los datos de
   ese momento (de los últimos días, nunca de los últimos 10 minutos).

**Desplegar**: servicio `agendality-api` → **Manual Deploy** → **Deploy latest commit**. Sigue el avance en **Events** y, al terminar,
comprueba `https://api.agendality.com/salud`.

**Revertir (Rollback)**: servicio → **Deploys** (o **Events**) → en un despliegue anterior que funcionaba, **Rollback** → **Rollback
to this deploy**. Vuelve el código, pero **no deshace las migraciones** ni las fotos del disco: si una migración dañó datos, restaura
con la copia del paso anterior. Un Rollback desde el panel deja el despliegue automático apagado (aquí ya lo está); no lo actives en
**Settings**.

## 6. Si algo falla: ver los registros

| Qué pasó | Dónde mirar |
| --- | --- |
| El despliegue falló | Servicio → **Events** → abre el despliegue fallido. Dice en qué paso falló: compilación (`build`), migraciones (`pre-deploy`) o arranque |
| La API responde errores | Servicio → **Logs**. Cada línea es un JSON con un `evento` (ej. `servidor_iniciado`, `push_fallo`). Usa el buscador de arriba |
| No arranca | En **Logs**, busca `Configuración inválida en las variables de entorno`: debajo dice qué variable revisar (nunca muestra su valor) |
| Problemas con la base | Base `agendality-db` → **Logs** y **Metrics** (conexiones, espacio usado) |

Mensajes comunes:

- `Configuración inválida … TOTP_SECRET` o `JWT_SECRET`: alguien cambió o borró un secreto. Vuelve a ponerlo o regenéralo (salvo
  `TOTP_SECRET`, ver arriba).
- `trust_proxy_sin_configurar`: `TRUST_PROXY` quedó en `0`; ponlo en `1`.
- `salud_sin_base`: la API no llega a la base. Revisa que `agendality-db` esté encendida (**Available**).
- Una migración falló: el mensaje dice cuál. La versión anterior sigue funcionando; corrige la migración en una rama nueva y vuelve a
  desplegar.

## Bueno saber

- **Copias de seguridad**: el plan Basic de PostgreSQL guarda copias para restaurar a un momento anterior (base → **Recovery**).
- **Disco**: con disco, cada despliegue tiene unos segundos sin servicio (Render apaga la versión vieja antes de encender la nueva) y
  el servicio no puede tener más de una instancia.
- **Usuario de la base**: Render da un solo usuario (el dueño de la base), que usan la app y las migraciones. Para más seguridad puedes
  crear después el rol limitado `agendamiento_app` con `db/mantenimiento/crear-rol-aplicacion.sql` y usarlo como `DB_USER` (el de
  Render pasaría a `DB_MIGRACION_USER`).
- **Correos**: se envían por Resend cuando `RESEND_API_KEY` está definida (ver "Correo" arriba y "Recuperar contraseña" en
  `AGENTS.md`). Para comprobarlo, pide un código en la app con tu correo: debe llegar desde `no-reply@agendality.com`. Si no
  llega, busca `correo_no_enviado` en **Logs** (trae el código HTTP de Resend; nunca el correo ni el código de 6 dígitos).
