# Auditoría y funciones nuevas del backend

Este Pull Request lleva `auditoria` a `main`. Reúne **todo el trabajo del backend desde `main`** (65 commits): las funciones nuevas de la API y las correcciones de la auditoría de seguridad y calidad (`docs/auditoria/informe-backend.md`).

> Se recomienda unirlo con **Squash and merge**, para dejar un solo commit en `main`.

## Qué trae de nuevo (funciones)

**Negocios y equipo**
- Registro de negocio con código propio, horario por día, departamento y ciudad (lista oficial DIVIPOLA del DANE), zona horaria por país y enlace público para compartir.
- Foto del negocio, del equipo y de los productos: se valida, se reduce a 1080 px, se convierte a WebP y se le quitan los metadatos.
- Equipo con roles (Administrador y Empleado), comisiones por profesional y la opción «Yo también atiendo clientes» para la administradora.
- Servicios (duración de 10 a 150 minutos), productos y catálogo público.
- Guía inicial de tres pasos y ubicación en el mapa con enlace a Google Maps.
- Categorías de negocio administradas por el superadmin y WhatsApp de contacto del negocio.

**Reservas y clientes**
- Cuentas de cliente y login único con correo o usuario.
- Horas disponibles según la duración del servicio y el intervalo del negocio, con reserva segura contra bloqueos y citas simultáneas (todo en una transacción).
- Bloqueos de horario semanales o de un día, que no pueden pisar una cita.
- Cancelación y reprogramación por el cliente, con anticipación mínima por negocio e historial de cambios.
- Lista negra, clientes con estado (activo o inactivo) e historial de citas.
- Teléfonos validados y guardados en formato E.164.

**Planes y cobro**
- Planes Emprendedor, Equipo y Pro con nivel automático según los profesionales que atienden, funciones por plan y cargos proporcionales al agregar profesionales.
- Prueba gratuita de 15 días y activación de plan por comando (todavía no hay pagos reales).

**Cartera y reportes**
- Cartera con resumen por período y comparación (período anterior, mes pasado, año pasado o rango propio).
- Reportes de ocupación, servicios rentables y demanda; en Pro, mejores clientes, retención y tendencia, con exportación a CSV, Excel y PDF.

**Notificaciones**
- Notificaciones push con Expo y centro de notificaciones dentro de la app.
- Recordatorios de 24 y 2 horas, y avisos de resumen de la prueba (días 10 y 14).

**Legal y atención**
- Políticas y términos versionados (1.0) con prueba de cada aceptación, que no se puede modificar ni borrar (Ley 1581).
- Eliminación de la cuenta con anonimización de los datos personales.
- PQRS con radicado, estados y plazos según el plan.

**Panel del superadmin**
- Login con verificación en dos pasos (TOTP), cierre automático por inactividad y cierre de sesión en el servidor.
- Gestión de negocios (plan, prueba, suspensión), PQRS, categorías, estadísticas, ingresos estimados y registro de actividad que no se puede alterar.
- Comandos de desarrollador (`dev:*`) para activar planes, cargos, PQRS y superadmins.

## Qué se corrigió en la auditoría

Todos los hallazgos Altos y Medios están resueltos, salvo M-7 (correo real), que queda para la publicación. Detalle y evidencia en `docs/auditoria/informe-backend.md`.

**Altos**
- **A-1** Las pruebas estaban rotas (60 de 96 no pasaban). Ahora hay una suite propia con base temporal que se niega a correr sobre la base de desarrollo.
- **A-2** Reservas falsas de invitados: tope de citas pendientes por teléfono y negocio, y límite de reservas guardadas por conexión.
- **A-3** La app ya no se conecta como superusuario. Usa un rol limitado, y las migraciones usan otro usuario.

**Medios**
- **M-1 / M-5** Límite de inicios de sesión por ruta, contador de fallos por cuenta guardado en la base (con bloqueos crecientes) y bloqueo del superadmin por cuenta y IP. Los fallos se cuentan de forma atómica, un fallo al reiniciar el contador no da error 500 y recuperar la contraseña quita el bloqueo.
- **M-2** Las cabeceras de IP (`X-Forwarded-For`, `CF-Connecting-IP`) solo se creen si se declaran proxies de confianza.
- **M-3** Se dejaron de aceptar contraseñas guardadas en texto plano.
- **M-4** Sesiones del personal con versión, `POST /api/v1/logout` y cierre de sesiones al cambiar la contraseña.
- **M-6** Al eliminar una cuenta se anonimiza el equipo y se borran sus fotos.
- **M-8** CORS permite `PUT` y `DELETE`.

**Bajos**
- **B-1** Mensaje genérico al registrar una cuenta repetida.
- **B-2** Los errores de validación no cuentan en el límite de registros.
- **B-3** Cancelar una cita inexistente responde 404.
- **B-4** Tres secretos independientes: sesiones, recuperación y segundo paso.
- **B-5** Las notificaciones push no llevan el nombre del cliente y los tokens vencen a los 60 días.
- **B-6** Los comandos de desarrollador quedan en el registro del superadmin y los riesgosos se niegan en producción.
- **B-7** Los mensajes de error de la base se limpian antes de escribirlos en el registro.
- **B-9** Dependencias actualizadas: `npm audit` reporta 0 vulnerabilidades.
- **B-10** Las actualizaciones por `id` filtran también por negocio en la propia sentencia.
- **B-11** Se quitó `/api/saludo` y se agregó `.env.example`.

**Pendiente para la publicación:** M-7 (proveedor de correo real), B-8 (`URL_PUBLICA`), HTTPS, el valor final de `TRUST_PROXY`, integración continua, refresh tokens y un límite compartido entre instancias (Redis).

**Aceptado a propósito:** quien conozca un correo puede bloquear esa cuenta unos minutos, y quien pruebe contraseñas del superadmin desde muchas IP puede seguir intentándolo (lo frenan el bloqueo y el segundo paso).

**Revisión nativa:** los cambios de riesgo alto (límites y contador de login, sesiones, secretos, y las dos correcciones finales del contador y la recuperación de contraseña) se revisaron con tres revisores cada uno y todos quedaron aprobados.

## Migraciones nuevas (27, de la 003 a la 029)

Se aplican con `npm run db:migrate`, en orden, cada una en su propia transacción. Ninguna borra filas; algunas transforman datos existentes (ver abajo).

| N.º | Qué hace |
| --- | --- |
| 003 | Registro de empresa y administrador |
| 004 | Foto del negocio |
| 005 | Gestión del negocio (clientes, equipo, servicios, productos, bloqueos) |
| 006 | Porcentaje de ganancia guardado en cada cita |
| 007 | Registro v2: horario por día, departamento, código del negocio y usuario de la administradora |
| 008 | Corrige el trigger de usuario único |
| 009 | Roles, suscripciones, cuentas de cliente, negocios guardados y consentimientos |
| 010 | Documentos legales (borrador) |
| 011 | Teléfonos en formato E.164 (migración en TypeScript; los que no se pudieron convertir se conservan con solo sus dígitos) |
| 012 | Ubicación del negocio y pago durante la prueba |
| 013 | Recuperación de contraseña, precisión del GPS y versión de sesión de las cuentas |
| 014 | Planes por tamaño de equipo |
| 015 | PQRS |
| 016 | Panel del superadmin y su registro de actividad |
| 017 | Textos legales versión 1.0 |
| 018 | Notificaciones push (dispositivos) |
| 019 | Inactividad del superadmin |
| 020 | Historial de ingresos por activación de plan |
| 021 | Intervalo de horarios y duración de servicios en múltiplos de 10 |
| 022 | Categorías de negocio y centro de notificaciones |
| 023 | Auditoría de autorizaciones (solo inserción) |
| 024 | Zonas horarias: las columnas de fecha pasan a `timestamptz` |
| 025 | Política de cancelación, reprogramaciones y WhatsApp de contacto |
| 026 | Planes Emprendedor, Equipo y Pro, PQRS prioritarias y perfil vinculado a la cuenta |
| 027 | Recordatorio de 2 horas, avisos de la prueba y guía inicial |
| 028 | Cobro por profesional y cargos proporcionales |
| 029 | Versión de sesión del personal y contador de intentos de login (auditoría) |

Qué cambian en datos que ya existen: la 011 pasa los teléfonos a E.164 (los que no se pudieron convertir se conservan); la 021 redondea la duración de los servicios al múltiplo de 10 más cercano; la 024 pasa las fechas a `timestamptz` sin cambiar los instantes; la 026 y la 028 reasignan el plan de cada negocio y recalculan el historial estimado de ingresos. Haz una copia de la base antes de migrar en producción.

## Variables nuevas del `.env`

El archivo `.env.example` trae todas con valores vacíos. El servidor valida el entorno al arrancar y dice qué variable revisar.

**Obligatorias**
| Variable | Para qué |
| --- | --- |
| `RECUPERACION_SECRET` | Protege los códigos para recuperar la contraseña. Mínimo 32 caracteres. |
| `TOTP_SECRET` | Cifra la clave del segundo paso del superadmin. Mínimo 32 caracteres. Si se cambia, hay que ejecutar `npm run db:recifrar-2fa`. |

`JWT_SECRET`, `RECUPERACION_SECRET` y `TOTP_SECRET` deben ser **distintos entre sí**. Se generan con `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
`DB_PASSWORD` ya no puede faltar ni estar vacía.

**Opcionales**
| Variable | Para qué | Por defecto |
| --- | --- | --- |
| `DB_MIGRACION_USER`, `DB_MIGRACION_PASSWORD` | Usuario con más permisos, solo para `db:migrate` | usa `DB_USER` |
| `TOTP_SECRET_ANTERIOR` | Valor anterior de `TOTP_SECRET`, solo para `db:recifrar-2fa` | — |
| `TRUST_PROXY` | Proxies de confianza delante del servidor (0 a 10) | `0` |
| `DETRAS_DE_CLOUDFLARE` | `true` solo detrás de Cloudflare (exige `TRUST_PROXY` mayor que 0) | `false` |
| `MAX_CITAS_PENDIENTES` | Citas pendientes por teléfono y negocio | `3` |
| `ENLACE_PUBLICO_BASE` | Dirección base de los enlaces públicos de los negocios | `agendaya.app` |
| `CARPETA_SUBIDAS` | Carpeta de las fotos subidas | `uploads` |
| `URL_PUBLICA` | Dirección pública del servidor para las URL de las fotos (definirla en producción) | la de cada solicitud |
| `EXPO_ACCESS_TOKEN` | Token de Expo para las notificaciones push | — |
| `ZONA_PLATAFORMA` | Zona horaria de lo que no es de ningún negocio | `America/Bogota` |
| `TEST_DB_NAME`, `TEST_DB_USER`, `TEST_DB_PASSWORD`, `TEST_DB_HOST`, `TEST_DB_PORT` | Base propia de las pruebas (`TEST_DB_NAME` debe incluir «test» o «prueba») | — |

## Antes de desplegar

1. Hacer una copia de la base de datos.
2. Crear el rol limitado de la aplicación con `db/mantenimiento/crear-rol-aplicacion.sql` y configurar `DB_USER` y `DB_MIGRACION_USER`.
3. Agregar `RECUPERACION_SECRET` y `TOTP_SECRET` al `.env`.
4. Ejecutar `npm run db:migrate`.
5. Si el superadmin ya tenía el segundo paso, ejecutar `npm run db:recifrar-2fa` (con `TOTP_SECRET_ANTERIOR` si el valor anterior no era `JWT_SECRET`).
6. Ejecutar `npm run db:cifrar-contrasenas` si quedan contraseñas heredadas en texto plano.

## Pruebas

`npm test`: **325 de 325 pasan** (28 archivos de prueba; antes había 5). `npm run typecheck` sin errores y `npm audit` con 0 vulnerabilidades.
