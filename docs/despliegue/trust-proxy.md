# TRUST_PROXY y la IP de quien consulta (hallazgo M-2)

La API usa la IP de cada conexión en tres sitios: los **límites de solicitudes**, el **bloqueo del superadmin** (cuenta + IP) y la
**prueba de las autorizaciones** (Ley 1581). Si la IP es falsa, los límites no sirven y la prueba legal queda con un dato inventado.

## Cómo decide la API

| Variable | Valor por defecto | Qué hace |
| --- | --- | --- |
| `TRUST_PROXY` | `0` | Cuántos proxies **de confianza** hay entre internet y la API. `0` = la conexión llega directo: se ignoran `X-Forwarded-For` y `CF-Connecting-IP`, porque cualquiera puede escribirlos. |
| `DETRAS_DE_CLOUDFLARE` | `false` | Solo con `true` (y `TRUST_PROXY` mayor que 0) se confía en `CF-Connecting-IP`. Sin esta declaración, detrás de otro proxy cualquiera podría escribir ese encabezado. |

El valor por defecto es el seguro: sin configurar nada, nunca se cree un encabezado que viene de internet.

## Qué valor poner (decídelo al publicar)

Cuenta los saltos que hay **entre el usuario y tu API**. Cada servicio que reenvía la solicitud (balanceador, Nginx, Cloudflare…) es un salto.

| Cómo se publica | `TRUST_PROXY` | `DETRAS_DE_CLOUDFLARE` |
| --- | --- | --- |
| Node expuesto directo a internet (sin Nginx ni balanceador) | `0` | `false` |
| Un solo intermediario: Nginx/Caddy/Traefik en el mismo servidor, o el balanceador de Render, Railway, Fly.io, Heroku, Google Cloud Run, DigitalOcean App Platform, AWS ALB, Azure App Service | `1` | `false` |
| Cloudflare directo a la API | `1` | `true` |
| Cloudflare → Nginx (o un balanceador) → API | `2` | `true` |
| Cloudflare → plataforma que ya trae su balanceador (por ejemplo Render con dominio detrás de Cloudflare) | `2` | `true` |

Regla de oro: **un número mayor al real es peor que uno menor**. Si pones más saltos de los que hay, un atacante puede escribir su propio
`X-Forwarded-For` y fingir cualquier IP. Si pones menos, todos los usuarios parecerán venir del proxy (los límites se vuelven globales y la IP
guardada como prueba legal es la del proxy): es molesto, pero no es un agujero.

## Cómo comprobarlo después de publicar

1. Haz una reserva de prueba desde tu celular con los datos móviles y consulta tu IP pública (por ejemplo en una página de "mi IP").
2. Revisa la última fila de `auditoria_autorizaciones` (columna `ip`): debe ser **esa** IP, no la del proxy ni una IP interna (`10.x`, `172.16.x`, `127.0.0.1`).
3. Prueba además enviando una solicitud con un `X-Forwarded-For: 1.2.3.4` inventado: la IP guardada no debe ser `1.2.3.4`.

Si ves la IP del proxy, sube `TRUST_PROXY` de uno en uno hasta que aparezca la IP real; si ves la inventada, bájalo.

Al arrancar con `NODE_ENV=production` y `TRUST_PROXY=0`, el servidor deja el aviso `trust_proxy_sin_configurar` en el registro como recordatorio.
