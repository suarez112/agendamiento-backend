# AGENTS.md — agendamiento-backend

API REST (Express 5 + TypeScript + PostgreSQL) para agendar citas en barberías. Varios negocios comparten la base; cada uno solo ve sus datos. Detalle completo en `README.md`.

**Este repositorio es solo el backend.** El frontend (Expo/React Native) está en `C:\Users\eduar_9\app`; no lo modifiques desde aquí.

**Servidor durante el desarrollo:** el backend ya está encendido en el puerto 4000 con `npm run dev` (se recarga solo al guardar). **No lo inicies ni lo apagues.** Para comprobar un cambio, llama a los endpoints (`http://localhost:4000`). No hay emulador: lo visual lo prueba el usuario en su celular.

## Estructura

```
src/
  server.ts          arranque y apagado ordenado
  app.ts             crea servicios y conecta rutas (recibe pool y entorno)
  config/entorno.ts  variables de entorno validadas con zod
  config/planes.ts   planes por tamaño de equipo (Básico, Equipo, Pro): cupo y precios (los reales los pone el dueño)
  db/                pool, migraciones (migrar.ts) y scripts de mantenimiento
  shared/            errores, logs JSON, middlewares HTTP (CORS, límites, validación, errores)
  shared/telefonos.ts  validación y formato E.164 de los teléfonos (libphonenumber-js)
  shared/correo.ts     envío de correos detrás de una interfaz (en desarrollo, a la consola)
  shared/push.ts       envío de notificaciones push detrás de una interfaz (Expo Push; en las pruebas no envía nada)
  modules/<modulo>/  auth, cuentas, empresas, citas, clientes, equipo, servicios, productos, bloqueos, cartera: <m>.rutas.ts (HTTP + zod) → <m>.servicio.ts (reglas) → <m>.repositorio.ts (SQL)
  modules/auth/acceso.ts          login único (correo o usuario)
  modules/empresas/horario.ts     horario por día (tabla horarios_empresa)
  modules/citas/disponibilidad.ts  cálculo de las horas libres de un profesional según la duración del servicio (funciones puras)
  modules/planes/planes.ts        GET /api/v1/planes (planes y precios, público)
  modules/ubicaciones/            departamentos y municipios de Colombia (DIVIPOLA del DANE, divipola.ts generado)
  modules/empresas/suscripcion.ts estado de la suscripción y guardia 402
  modules/legal/legal.ts          política y términos vigentes, prueba de las autorizaciones (Ley 1581)
  modules/pqrs/                   PQRS: peticiones, quejas, reclamos y sugerencias con radicado y estado
  modules/notificaciones/         centro de notificaciones de la app, push (dispositivos), avisos de citas y tarea de recordatorios (recordatorios.ts)
  modules/categorias/             categorías de negocio (Barbería, Peluquería, Salón de belleza): públicas las activas, las administra el superadmin
  modules/superadmin/             panel del dueño de la plataforma: login con TOTP, negocios, PQRS y registro de actividad (totp.ts: segundo paso)
  modules/empresas/activacion.ts  activar un plan a una empresa (lo usan dev:activar-plan y el panel) y anotarlo en el historial de ingresos (activaciones_plan)
  modules/cuentas/eliminacion.servicio.ts  eliminar la cuenta y los datos personales (Ley 1581)
  modules/micuenta/               cuenta del cliente: negocios guardados y sus citas
  modules/cuentas/recuperacion.servicio.ts  recuperar la contraseña con un código por correo
  db/activarPlan.ts, db/simularVencimiento.ts, db/pqrs.ts, db/crearSuperadmin.ts, db/restablecerSuperadmin.ts, db/eliminarSuperadmin.ts   comandos de desarrollador (ver "Comandos de desarrollador")
db/migraciones/      numeradas NNN_nombre.sql (o .ts si SQL no alcanza); cada archivo en su propia transacción
test/                node:test; cada archivo crea y borra su propia base temporal
odd/tasks/           bitácoras de trabajo (specs, tareas, evidencia)
```

Un módulo nuevo copia la forma rutas → servicio → repositorio y se conecta en `src/app.ts`.

## Ejecutar

```bash
npm install
npm run db:migrate   # aplica migraciones pendientes (anotadas en schema_migrations)
npm run dev          # http://localhost:4000  (salud: GET /api/saludo)
npm run typecheck    # tipos de src/ y test/
npm test             # integración; requiere PostgreSQL y permiso CREATEDB
```

### Comandos de desarrollador (suscripciones)

No hay pagos reales. Para probar las suscripciones se usan dos comandos. `CODIGO` es el código del negocio (sin distinguir mayúsculas). Lee la base del `.env`; no hace falta tener el servidor encendido.

```bash
npm run dev:activar-plan -- CODIGO equipo anual # plan: basico | equipo | pro (opcional); periodo: mensual | anual
npm run dev:simular-vencimiento -- CODIGO DIAS # ej. 3, 0 o -2
```

- **`dev:activar-plan`**: si lo ejecutas mal (o sin argumentos) muestra el uso con la lista de planes (`basico | equipo | pro`), los periodos (`mensual | anual`) y un ejemplo (`npm run dev:activar-plan -- INFINITY equipo anual`). Recibe el plan por tamaño de equipo (`basico`, `equipo` o `pro`; si no se envía, conserva el que tiene) y el periodo (`mensual` o `anual`). Si el equipo activo no cabe en el plan elegido, lo rechaza y no cambia nada (`✖ Tu equipo tiene 4 integrante(s) activo(s) y el plan Básico permite hasta 3. …`). Deja la empresa `activa` con ese plan, de inmediato (ya no aparece como prueba). Fecha de pago = hoy (Colombia). Fecha de fin = 1 mes o 1 año contados desde: el **fin de la prueba**, si paga durante la prueba (no pierde los días gratis que le quedaban; se guardan en `dias_prueba_sumados` y `/suscripcion` los muestra en `diasPruebaSumados`); el fin del plan actual, si aún no vencía (una renovación anticipada no pierde días); o hoy, en otro caso. Sirve también para activar a mano un negocio en producción mientras no haya pagos. Cada activación queda en el historial de ingresos (`activaciones_plan`, origen `comando`). Ejemplo: `npm run dev:activar-plan -- CENTRAL10 equipo anual` → `✔ Barbería Central (CENTRAL10): plan Equipo anual activo (cupo 2/5). Pago: 2026-10-19. Fin: 2027-10-19. Días restantes: 365.` Durante una prueba con 15 días restantes, `-- CENTRAL10 basico mensual` → `… Fin: 2026-12-03. Días restantes: 45. Días de prueba sumados: 15.`
- **`dev:simular-vencimiento`**: deja a la empresa con `DIAS` días restantes de su prueba (si está en prueba) o de su plan (si está activa), cambiando la fecha de fin. `0` o negativo = vencida. Para un negocio vencido, actívale antes un plan. **No funciona con `NODE_ENV=production`** (responde con error y no cambia nada). Ejemplos: `-- CENTRAL10 5` (recordatorio de los últimos 7 días), `-- CENTRAL10 0` (vencida hoy).

Los dos muestran cómo quedó: estado, fecha de fin y días restantes.

```bash
npm run dev:pqrs -- listar [estado]                          # estado: recibida | en_proceso | resuelta | cerrada
npm run dev:pqrs -- responder RADICADO estado ["respuesta"]  # ej. -- responder PQRS-2026-000001 resuelta "Ya lo corregimos"
```

- **`dev:pqrs`**: `listar` muestra las PQRS (las sin resolver primero, de la más antigua a la más reciente; con un estado, solo las de ese estado) con radicado, tipo, quién la envió, mensaje y respuesta. `responder` cambia el estado de la PQRS con ese radicado (sin distinguir mayúsculas) y, si se envía texto (máx. 2000), guarda la respuesta y la fecha; sin texto conserva la respuesta anterior. Un radicado que no existe responde `No existe una PQRS con el radicado …`. La app ve el cambio en `GET /pqrs/mias`.

```bash
npm run dev:crear-superadmin -- correo              # crea tu cuenta de superadmin
npm run dev:crear-superadmin -- correo --reiniciar  # si perdiste la contraseña o el segundo paso
npm run dev:restablecer-superadmin -- correo         # olvidaste la contraseña: genera una nueva
npm run dev:restablecer-superadmin -- correo --totp  # además, una clave nueva de la verificación en dos pasos
npm run dev:eliminar-superadmin -- correo            # elimina un superadmin (pide confirmación)
```

- **`dev:crear-superadmin`**: única forma de crear un superadmin (no hay registro ni endpoint). Genera una contraseña al azar (20 caracteres) y la clave de la verificación en dos pasos, y muestra las dos **una sola vez**: la clave como código QR (para escanear con Google Authenticator, Authy…) y también escrita (`F7DO BPG2 …`) por si no se puede escanear. Si el correo ya existe responde `✖ Ya existe un superadmin con el correo …`. Con `--reiniciar` cambia la contraseña y el segundo paso de uno que ya existe y cierra sus sesiones abiertas. Funciona también con `NODE_ENV=production` (es como se crea en producción). Lee la base y `JWT_SECRET` del `.env`.
- **`dev:restablecer-superadmin`**: para cuando olvidas la contraseña. Genera una contraseña nueva (20 caracteres, se muestra **una sola vez**), cierra las sesiones abiertas y desbloquea la cuenta; la verificación en dos pasos sigue igual. Con `--totp` también genera una clave nueva del segundo paso (por ejemplo si perdiste el celular; la anterior deja de servir): la muestra como código QR **y escrita** (`F7DO BPG2 …`) y guarda el QR como imagen PNG en `secretos-superadmin/` (carpeta en `.gitignore`: no se sube a GitHub; borra la imagen cuando ya configuraste la app). `dev:crear-superadmin` guarda su QR en la misma carpeta. Un correo que no existe responde `✖ No existe un superadmin con el correo …`. **No hay recuperación por correo para el superadmin**: este comando es la única vía. Funciona con `NODE_ENV=production`.
- **`dev:eliminar-superadmin`**: elimina un superadmin (por ejemplo uno creado por error). Pregunta `¿Eliminar al superadmin …? No se puede deshacer. (s/N)` y solo borra con `s`. **Nunca borra al último** (`✖ Es el único superadmin y no se puede eliminar: …`: sin superadmins nadie podría entrar al panel); la comprobación se repite dentro de la transacción con las filas bloqueadas. Al terminar muestra los que quedan. El registro de actividad no se toca.

Puerto por defecto `4000` (`PORT`). Rutas bajo `/api/v1`.

## Base de datos y entorno

- PostgreSQL vía `pg` (`src/db/pool.ts`), con las extensiones `btree_gist` (migración 002) y `gen_random_uuid()` (PostgreSQL 13 o superior).
- Variables en `.env` en la raíz (ignorado por git; nunca lo subas). Se validan al arrancar en `src/config/entorno.ts`: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_MAX`, `JWT_SECRET`, `JWT_EXPIRA_EN`, `CORS_ORIGINS`, `TRUST_PROXY`, `NODE_ENV`, `PORT`, `CARPETA_SUBIDAS` (opcional, por defecto `uploads`: carpeta de las fotos subidas, ignorada por git) `ENLACE_PUBLICO_BASE` (opcional, por defecto `agendaya.app`: dirección base de los enlaces públicos de los negocios; sin `http(s)://` se asume `https://`; ver "Enlace público del negocio"), `URL_PUBLICA` (opcional: dirección pública del servidor, ej. `https://api.mibarberia.co`, para armar las URL de las fotos; si falta se usa la dirección de cada solicitud, así que configúrala en producción) y `EXPO_ACCESS_TOKEN` (opcional: token de acceso de Expo para las notificaciones push; sin él también se envían).
- El esquema solo cambia con un archivo nuevo en `db/migraciones/` (siguiente número). Nunca edites una migración ya aplicada. Casi siempre es `.sql`; si hace falta código (ej. una librería), puede ser `.ts` y exportar por defecto `async (db: pg.PoolClient) => {…}`, que corre en la misma transacción (ver la 011). Una migración `.ts` no importa nada de `src/`, para que siga haciendo lo mismo aunque el código cambie.
- Migración 007: horario por día en `horarios_empresa` (un día sin fila = cerrado; reemplaza `dias_atencion`, `horario_apertura` y `horario_cierre`, que se copiaron ahí), quita `nit`, `telefono` y `correo` de `empresas`, agrega `empresas.departamento`, empleados de 1 a 10, código del negocio `^[A-Z0-9]{1,10}$`, `usuarios.usuario` y bloqueos semanales o de una fecha (`bloqueos_tipo_valido`). La 008 corrige el trigger de usuario único.
- Migración 009: `barberos.atiende_clientes`; plan de la suscripción (`empresas.plan_suscripcion` `mensual`|`anual`, `fecha_pago`, `suscripcion_fin`); cuentas de cliente (`usuarios.nombre`, `telefono`, `indicativo`; `correo` pasa a opcional: correo o usuario); `negocios_guardados`; `citas.usuario_id` (cliente que reservó con su sesión); `documentos_legales` y `autorizaciones_datos`. La 010 publica el borrador `0.1-borrador` de la política y los términos.
- Migración 011 (`.ts`): **teléfonos en E.164** (`+573162781393`) en `varchar(16)` en `clientes`, `lista_negra`, `usuarios` y `autorizaciones_datos`. `clientes` pasa a ser único por `(empresa_id, telefono)`; índice único `usuarios_telefono_cliente_key` en `usuarios (telefono) WHERE rol = 'cliente'`. `lista_negra` sigue única por negocio. Los teléfonos que no se pudieron convertir **no se borraron**: quedaron solo con sus dígitos (no empiezan con `+`). Para verlos: `SELECT id, empresa_id, nombre, telefono FROM clientes WHERE telefono !~ '^\+'` (igual en las otras tablas). Al aplicarla quedaron 2 pendientes en `clientes`: `3768300614` (Popo) y `357491541` (DESQ), ambos del negocio INFINITY.
- Migración 012: `empresas.latitud` y `empresas.longitud` (opcionales, siempre juntas, rangos validados) y `empresas.dias_prueba_sumados` (días de prueba que quedaban al pagar durante la prueba).
- Migración 013: `empresas.precision_ubicacion` (precisión del GPS en metros, opcional, solo con coordenadas); `usuarios.version_sesion` (sube al cambiar la contraseña e invalida los tokens anteriores); tabla `codigos_recuperacion` (códigos para recuperar la contraseña: HMAC del código, vencimiento, intentos y uso).
- Migración 014: `empresas.plan_equipo` (`basico` | `equipo` | `pro`, por defecto `pro`): plan por tamaño de equipo. `plan_suscripcion` sigue siendo el periodo (`mensual` | `anual`). A las empresas existentes se les asignó el plan más pequeño que alcanza para su equipo activo (las de prueba, además, el número de empleados del registro si era mayor); no se borró a nadie. Al aplicarla, las tres quedaron en `basico`.
- Migración 015: tabla `pqrs` (radicado único `PQRS-AAAA-NNNNNN` desde la secuencia `pqrs_numero_seq`, `tipo`, `mensaje`, `nombre`, `contacto`, `usuario_id` opcional con `ON DELETE SET NULL`, `estado`, `respuesta`, `respondida_en`).
- Migración 016: panel del superadmin. `empresas.suspendida_en` y `empresas.suspension_motivo` (van juntas); tabla `superadmins` (aparte de `usuarios`: ningún login de la app llega a ellos; `totp_secreto` cifrado, `totp_ultimo_paso`, `version_sesion`, `intentos_fallidos`, `bloqueado_hasta`); tabla `actividad_superadmin` (solo se agregan filas: un disparador rechaza `UPDATE`, `DELETE` y `TRUNCATE`; sin llaves foráneas a propósito, copia el correo y los datos del negocio de ese momento).
- Migración 017: textos legales **versión 1.0** (reemplazan los borradores 0.1) a partir de `docs/legal/documentos-legales.md`: Política de Tratamiento de Datos, Términos y Condiciones y Aviso de privacidad (texto corto). `documentos_legales.tipo` admite un tercer valor, `aviso_privacidad`. Los clientes con cuenta deben aceptar la 1.0 en su próxima reserva.
- Migración 018: notificaciones push. Tabla `dispositivos_push` (`token` único, de un integrante del equipo `barbero_id` o de una cuenta `usuario_id`, nunca los dos; se borra con su dueño) y `citas.recordatorio_enviado_en` (marca el recordatorio de 24 h ya enviado).
- Migración 019: `superadmins.ultima_actividad` (momento de la última solicitud del superadmin; con más de 15 minutos de diferencia, o `NULL`, la sesión ya no sirve).
- Migración 020: tabla `activaciones_plan` (historial de activaciones de plan: negocio, `plan_equipo`, `periodo`, `precio` de ese momento, `fecha` en hora de Colombia, `origen` `panel` | `comando` | `historico`). Sin llave foránea (copia el código y el nombre del negocio, como `actividad_superadmin`). La llena `activarPlanEmpresa` en cada activación; al aplicarla se copió la **última** activación de cada negocio que ya había pagado (`origen = 'historico'`, con los precios de `src/config/planes.ts` de ese día). Las activaciones anteriores a esta migración no se guardaron, así que no se pueden recuperar.
- Migración 021: la duración de los servicios pasa a múltiplos de 10 de 10 a 150 (`servicios_duracion_valida`); los servicios que ya existían se redondearon hacia arriba al múltiplo de 10 más cercano dentro de ese rango (45 → 50; más de 150 → 150), las citas ya agendadas no cambian. `empresas.intervalo_minutos` (10, 20, 30, 40, 50 o 60; por defecto 30): cada cuántos minutos pueden agendar los clientes.
- Migración 022: tabla `categorias_negocio` (`nombre` único sin distinguir mayúsculas, `activa`; se cargan Barbería, Peluquería y Salón de belleza; `empresas.categoria` sigue guardando el nombre, así que los negocios que ya existían no cambian) y tabla `notificaciones` (centro de notificaciones: de una cuenta `usuario_id` o de un integrante `barbero_id`, nunca los dos; `tipo`, `titulo`, `texto`, `cita_id` que se desvincula si la cita se borra, `leida_en`).
- **Publicar una versión nueva de la política, los términos o el aviso**: una migración nueva que inserte filas en `documentos_legales` con otra `version` (nunca edites las filas publicadas). La más reciente de cada tipo es la vigente; los clientes con cuenta aceptan la política y los términos nuevos en su próxima reserva. Conviene publicar los tres tipos juntos con el mismo número.

## Endpoints

Todas las respuestas son JSON. Los errores siempre llegan como `{ "error": "mensaje" }`, listo para mostrar al usuario.

| Método | Ruta | Acceso |
| --- | --- | --- |
| GET | `/api/saludo` | público (salud) |
| POST | `/api/v1/login` | público, limitado. **Login único**: administradora, personal o cliente con cuenta. Cuerpo `{ usuario: "correo o usuario", clave }` |
| POST | `/api/v1/auth/login` | público, limitado. Personal (barberos). Cuerpo `{ usuario, clave }` (se mantiene) |
| GET | `/api/v1/ubicaciones` | público. Departamentos de Colombia con sus municipios |
| GET | `/api/v1/planes` | público. Planes por tamaño de equipo con sus precios (ver "Planes") |
| GET | `/api/v1/categorias` | público. Categorías de negocio activas (ver "Categorías de negocio") |
| GET | `/api/v1/legal/politica-datos` | público. Texto vigente de la Política de Tratamiento de Datos, con su versión |
| GET | `/api/v1/legal/terminos` | público. Texto vigente de los Términos y Condiciones, con su versión |
| GET | `/api/v1/legal/aviso-privacidad` | público. Texto corto vigente del Aviso de privacidad (va junto a la casilla de autorización), con su versión |
| PUT | `/api/v1/dispositivos` | cualquier sesión (personal, administradora o cliente con cuenta). Guarda el token de notificaciones push del celular (ver "Notificaciones push") |
| DELETE | `/api/v1/dispositivos` | cualquier sesión. Borra ese token al cerrar sesión |
| GET | `/api/v1/notificaciones` | cualquier sesión. Centro de notificaciones: las suyas, paginadas (ver "Centro de notificaciones") |
| GET | `/api/v1/notificaciones/no-leidas` | cualquier sesión. Cuántas tiene sin leer |
| PATCH | `/api/v1/notificaciones/:id/leida` | cualquier sesión. Marca una como leída |
| PATCH | `/api/v1/notificaciones/leidas` | cualquier sesión. Marca todas como leídas |
| PATCH | `/api/v1/mi-cuenta/citas/:id/cancelar` | cuenta de cliente. Cancela una cita suya que aún no empezó |
| GET | `/api/v1/empresas/codigo-disponible/:codigo` | público, limitado. ¿Algún negocio usa ya ese código? |
| GET | `/api/v1/empresas/validar/:codigo` | público, limitado |
| GET | `/api/v1/empresas/perfil/:codigo` | público, limitado. Información del negocio con su foto, para clientes |
| GET | `/api/v1/empresas/actual` | sesión del personal |
| POST | `/api/v1/citas` | público, limitado. Invitado o cliente con sesión. Exige aceptar la política y los términos (ver "Reservas"). Solo de hoy a 14 días después (hora de Colombia) y dentro del horario de ese día. 403 si el teléfono está en la lista negra o el negocio está vencido; 409 si choca con un bloqueo |
| GET | `/api/v1/citas/ocupadas?empresaId=` | público (sin datos de clientes) |
| GET | `/api/v1/citas/disponibilidad?empresaId=&barberoId=&servicioId=&fecha=` | público. Horas libres de un profesional para un servicio ese día (ver "Horas disponibles") |
| GET | `/api/v1/citas/bloqueos?empresaId=` | público. Horarios bloqueados del equipo, semanales y de una fecha (sin el motivo) |
| GET | `/api/v1/citas/agenda` | sesión del personal (admin: todo el negocio; empleado: sus citas), suscripción vigente |
| PATCH | `/api/v1/citas/:id/completar` | sesión del personal: el barbero de la cita, o la cuenta admin (cualquier cita del negocio), suscripción vigente |
| PATCH | `/api/v1/citas/:id/cancelar` | sesión del personal, solo admin del negocio, suscripción vigente (402 si no) |
| POST | `/api/v1/cuentas/registro/empresa` | público, limitado. Crea empresa + administrador. Exige aceptar la política y los términos |
| POST | `/api/v1/cuentas/registro/cliente` | público, limitado. Exige aceptar la política y los términos |
| POST | `/api/v1/cuentas/login` | público, limitado. Administradores de empresa y clientes (con correo) |
| POST | `/api/v1/cuentas/solicitar-recuperacion` | público, limitado por conexión y por correo. Envía un código para recuperar la contraseña (ver "Recuperar contraseña") |
| POST | `/api/v1/cuentas/restablecer-contrasena` | público, limitado. Cambia la contraseña con el código y cierra las sesiones abiertas |
| POST | `/api/v1/cuentas/eliminar` | cuenta (administradora o cliente), limitado. Elimina la cuenta y sus datos personales (ver "Eliminar la cuenta") |
| POST | `/api/v1/pqrs` | público, limitado. Radica una petición, queja, reclamo o sugerencia, como invitado o con sesión (ver "PQRS") |
| GET | `/api/v1/pqrs/mias` | cuenta (administradora o cliente). Las PQRS que radicó con su sesión |
| POST | `/api/v1/superadmin/login` | público, limitado, **solo el superadmin**. `{ correo, clave, codigo }` con el código de 6 dígitos de la app autenticadora. Sesión de 1 hora que se cierra sola tras 15 minutos sin actividad (ver "Panel del superadministrador") |
| POST | `/api/v1/superadmin/logout` | superadmin. Cierra la sesión e invalida el token en el servidor |
| GET | `/api/v1/superadmin/resumen` | superadmin. Cifras de toda la plataforma |
| GET | `/api/v1/superadmin/estadisticas` | superadmin. Cifras agregadas para los gráficos del panel |
| GET | `/api/v1/superadmin/ingresos` | superadmin. Ingresos **estimados** por mes (últimos 12), por año, mejor mes, mejor año y total |
| GET | `/api/v1/superadmin/negocios` | superadmin. Lista con búsqueda, filtros y paginación |
| GET | `/api/v1/superadmin/negocios/:id` | superadmin. Detalle de un negocio (solo cifras) |
| POST | `/api/v1/superadmin/negocios/:id/plan` | superadmin. Activa o cambia el plan |
| POST | `/api/v1/superadmin/negocios/:id/extender-prueba` | superadmin. Alarga la prueba X días |
| POST | `/api/v1/superadmin/negocios/:id/suspender` | superadmin. Suspende el negocio (con motivo) |
| POST | `/api/v1/superadmin/negocios/:id/reactivar` | superadmin. Quita la suspensión (con motivo) |
| GET | `/api/v1/superadmin/pqrs` | superadmin. Todas las PQRS, con filtros y paginación |
| GET | `/api/v1/superadmin/pqrs/:radicado` | superadmin. Detalle de una PQRS |
| PATCH | `/api/v1/superadmin/pqrs/:radicado` | superadmin. Cambia el estado y responde |
| GET | `/api/v1/superadmin/categorias` | superadmin. Todas las categorías, con su estado |
| POST | `/api/v1/superadmin/categorias` | superadmin. Crea una categoría |
| PATCH | `/api/v1/superadmin/categorias/:id` | superadmin. Edita el nombre o la desactiva o reactiva |
| GET | `/api/v1/superadmin/actividad` | superadmin. Registro de actividad del superadmin |
| GET | `/api/v1/admin/empresa/suscripcion` | personal admin (los dos tipos), **aunque esté vencida**. Estado, plan, fechas, días restantes y recordatorio |
| GET | `/api/v1/admin/empresa/intervalo` | personal admin, aunque esté vencida. Cada cuántos minutos pueden agendar los clientes |
| PUT | `/api/v1/admin/empresa/intervalo` | personal admin, aunque esté vencida. Cambia ese intervalo |
| GET | `/api/v1/admin/empresa/prueba` | personal admin, aunque esté vencida (se mantiene; usa `/suscripcion`) |
| GET | `/api/v1/admin/empresa` | personal admin, aunque esté vencida ("Mi negocio") |
| PATCH | `/api/v1/admin/empresa` | personal admin, aunque esté vencida |
| PUT | `/api/v1/admin/empresa/foto` | personal admin, aunque esté vencida. Sube o cambia la foto del negocio |
| GET | `/api/v1/mi-cuenta/negocios` | cuenta de cliente. Negocios guardados |
| POST | `/api/v1/mi-cuenta/negocios` | cuenta de cliente, limitado. Guarda un negocio con su código |
| DELETE | `/api/v1/mi-cuenta/negocios/:id` | cuenta de cliente. Quita un negocio de la lista |
| GET | `/api/v1/mi-cuenta/citas` | cuenta de cliente. Citas que reservó con su sesión |
| GET | `/api/v1/clientes` | personal admin, suscripción vigente. Clientes del negocio |
| GET | `/api/v1/clientes/:id/historial` | personal admin, suscripción vigente |
| GET | `/api/v1/clientes/lista-negra` | personal admin, suscripción vigente |
| POST | `/api/v1/clientes/lista-negra` | personal admin, suscripción vigente |
| DELETE | `/api/v1/clientes/lista-negra/:id` | personal admin, suscripción vigente |
| GET | `/api/v1/equipo` | personal admin, suscripción vigente |
| POST | `/api/v1/equipo` | personal admin, suscripción vigente |
| PATCH | `/api/v1/equipo/:id` | personal admin, suscripción vigente |
| DELETE | `/api/v1/equipo/:id` | personal admin, suscripción vigente |
| PUT | `/api/v1/equipo/:id/foto` | personal admin, suscripción vigente |
| GET | `/api/v1/servicios` | personal admin, suscripción vigente |
| POST | `/api/v1/servicios` | personal admin, suscripción vigente |
| PATCH | `/api/v1/servicios/:id` | personal admin, suscripción vigente |
| DELETE | `/api/v1/servicios/:id` | personal admin, suscripción vigente |
| GET | `/api/v1/productos/catalogo/:codigo` | público, limitado. Catálogo para clientes |
| GET | `/api/v1/productos` | personal admin, suscripción vigente |
| POST | `/api/v1/productos` | personal admin, suscripción vigente |
| PATCH | `/api/v1/productos/:id` | personal admin, suscripción vigente |
| DELETE | `/api/v1/productos/:id` | personal admin, suscripción vigente |
| PUT | `/api/v1/productos/:id/foto` | personal admin, suscripción vigente |
| DELETE | `/api/v1/productos/:id/foto` | personal admin, suscripción vigente |
| GET | `/api/v1/bloqueos` | personal admin, suscripción vigente (los empleados no ven ni usan bloqueos) |
| GET | `/api/v1/bloqueos/calendario?desde=&hasta=&barberoId=` | personal admin, suscripción vigente. Bloqueos y citas de un rango, con el inicio y fin reales de cada cita |
| POST | `/api/v1/bloqueos` | personal admin, suscripción vigente |
| DELETE | `/api/v1/bloqueos/:id` | personal admin, suscripción vigente |
| GET | `/api/v1/cartera?desde=&hasta=&barberoId=` | personal (admin: todo el negocio o un integrante; empleado: lo suyo), suscripción vigente |
| GET | `/api/v1/cartera/resumen?periodo=&desde=&hasta=&barberoId=` | personal (igual que `/cartera`), suscripción vigente. Resumen por período: `hoy`, `semana`, `mes` o `rango` (el rango va del registro del negocio a hoy) |
| GET | `/uploads/empresas/<archivo>`, `/uploads/barberos/<archivo>`, `/uploads/productos/<archivo>` | público. La imagen guardada (se usa la dirección que devuelve la API) |

"Sesión del personal" acepta **dos tokens**: el del barbero (`/api/v1/auth/login`) y el de la **cuenta del administrador de la empresa** (`/api/v1/cuentas/login`, `rol = admin`). La cuenta admin cuenta como administrador del negocio (`esAdmin`), siempre de su propia empresa. "Personal admin" = integrante del equipo con rol Administrador (`esAdmin`) o cuenta admin: **los dos tienen los mismos permisos** sobre su empresa (Mi negocio, suscripción, equipo, servicios, productos, bloqueos, clientes y la cartera completa). Un **empleado** (integrante con rol Empleado) solo usa su agenda y su propia cartera. Detalle en "Gestión del negocio".

### Contraseñas nuevas

Toda contraseña **nueva o cambiada** (registro de empresa, registro de cliente, restablecer con código, y crear o editar un integrante del equipo con `clave`) debe tener de 8 a 64 caracteres con al menos una **mayúscula**, una **minúscula**, un **número** y un **carácter especial** (algo que no sea letra, número ni espacio). Si no, **400** `La contraseña debe tener entre 8 y 64 caracteres e incluir una mayúscula, una minúscula, un número y un carácter especial`. La regla está en `claveNueva` (`src/shared/http/esquemas.ts`). Las contraseñas que ya existen **siguen funcionando** en los logins (que solo piden que la clave no esté vacía). Las del superadmin las genera el comando de desarrollador y ya cumplen la regla.

### Enlace público del negocio

Cada negocio tiene un enlace para compartir: `<ENLACE_PUBLICO_BASE>/<CÓDIGO>` (ej. `https://agendaya.app/CENTRAL10`). Llega como `enlacePublico` en la respuesta de `POST /cuentas/registro/empresa` (dentro de `empresa`) y en `GET`/`PATCH /admin/empresa` (Mi negocio). Si cambia el código del negocio, el enlace cambia con él.

### Categorías de negocio

- **GET `/api/v1/categorias`** (público): **200** `[{ "id", "nombre" }]` con las categorías **activas**, por orden alfabético (al inicio: Barbería, Peluquería y Salón de belleza).
- El registro de empresa (`POST /cuentas/registro/empresa`) solo acepta una categoría activa (no distingue mayúsculas y se guarda con el nombre oficial); si no, **400** `La categoría no es válida. Elige una de la lista.` `PATCH /admin/empresa` no cambia su validación de `categoria`. Desactivar una categoría no cambia a los negocios que ya la tienen.
- Solo el superadmin las administra (y queda en su registro de actividad como `crear_categoria` o `editar_categoria`): **GET `/superadmin/categorias`** (todas: `{ "id", "nombre", "activa" }`), **POST `/superadmin/categorias`** `{ "nombre" }` (máx. 60; **201** `{ "mensaje": "Categoría creada", "categoria" }`) y **PATCH `/superadmin/categorias/:id`** `{ "nombre"?, "activa"? }` (**200** `{ "mensaje": "Categoría actualizada", "categoria" }`). **409** `Ya existe una categoría con ese nombre`; **404** `Categoría no encontrada`. No se borran: se desactivan con `"activa": false`.

### Contrato de cuentas, prueba gratuita y administración

Hay dos tipos de sesión:

- **Personal** (`/api/v1/auth/login` o `/api/v1/login`, tabla `barberos`): sirve en `/empresas/actual`, `/citas/...` y los endpoints de gestión (`/clientes`, `/equipo`, `/servicios`, `/productos`, `/bloqueos`, `/cartera`). Un integrante con rol Administrador también sirve en `/api/v1/admin/empresa/...` (Mi negocio y suscripción); un empleado ahí responde 403 `Solo el administrador del negocio puede usar esta función.`
- **Cuenta** (`/api/v1/cuentas/...` o `/api/v1/login`, tabla `usuarios`, `rol` = `admin` | `cliente`): la cuenta **admin** sirve en `/api/v1/admin/...` y en todos los endpoints del personal, como administradora de su empresa. La de un **cliente** sirve en `/api/v1/mi-cuenta/...` y para reservar con su sesión; en los endpoints del personal y de `/api/v1/admin/...` responde 403 `Esta función es solo para el personal del negocio.`

Ambos se envían como `Authorization: Bearer <token>`.

**POST `/api/v1/login`** (login único): la administradora, alguien del personal o un **cliente con cuenta** entra con su **correo o usuario** y su contraseña; el backend detecta quién es. Los logins de antes (`/auth/login` y `/cuentas/login`) siguen funcionando igual.

- Recibe `{ "usuario": "ana.perez" | "ana@central.co", "clave": "…" }`. Si el texto tiene `@` se busca como correo (solo las cuentas tienen correo); si no, como usuario (no distingue mayúsculas). Un usuario nunca se repite entre cuentas (administradoras y clientes) y personal, así que no hay ambigüedad.
- Responde **200** con `tipo` y, según el caso, la misma respuesta del login de antes:
  - Administradora: `{ "tipo": "admin", "mensaje": "Autenticación exitosa", "token": "<jwt de cuenta>", "usuario": { "id", "correo", "usuario", "rol": "admin", "empresaId", "nombre": null, "telefono": null, "indicativo": null } }`
  - Cliente: `{ "tipo": "cliente", "mensaje": "Autenticación exitosa", "token": "<jwt de cuenta>", "usuario": { "id", "correo" | null, "usuario" | null, "rol": "cliente", "empresaId": null, "nombre", "telefono", "indicativo" }, "debeAceptarDocumentos": false }`. `debeAceptarDocumentos: true` = se publicó una versión nueva de la política o los términos y deberá aceptarla en su próxima reserva.
  - Personal: `{ "tipo": "personal", "mensaje": "Autenticación exitosa", "token": "<jwt del personal>", "barbero": { …igual que /auth/login… } }` (ahora incluye `rol` `"admin"` | `"empleado"` y `atiendeClientes`).
- Errores: **400** `Debes enviar tu correo o usuario y tu contraseña`; **401** `Correo, usuario o contraseña incorrectos` (igual si no existe); **402** `Este negocio está inactivo por ahora. Comunícate con el administrador del negocio.` (empleado de un negocio con la suscripción vencida; también en `/auth/login`); **429** demasiados intentos fallidos. Ya no responde 403 a los clientes.

**POST `/api/v1/cuentas/registro/empresa`**: registra la empresa, su horario y su administradora. La administradora entra después con su `correo` o su `usuario`, y la `clave`.

- Recibe:

  ```jsonc
  {
    "nombre": "Barbería Central",          // obligatorio, máx. 100
    "categoria": "Barbería",               // obligatorio: una categoría activa de GET /categorias
    "codigoAcceso": "central10",           // obligatorio: el código que usan los clientes (ver abajo)
    "direccion": "Calle 10 # 20-30",       // obligatorio, máx. 200
    "departamento": "Santander",           // obligatorio, departamento de Colombia
    "ciudad": "Bucaramanga",               // obligatorio, municipio de ese departamento
    "horario": [                           // obligatorio, los 7 días (ver abajo)
      { "dia": 0, "abierto": false },
      { "dia": 1, "abierto": true, "apertura": "08:00", "cierre": "19:00" },
      { "dia": 2, "abierto": true, "apertura": "08:00", "cierre": "19:00" },
      { "dia": 3, "abierto": true, "apertura": "08:00", "cierre": "19:00" },
      { "dia": 4, "abierto": true, "apertura": "08:00", "cierre": "19:00" },
      { "dia": 5, "abierto": true, "apertura": "08:00", "cierre": "20:00" },
      { "dia": 6, "abierto": true, "apertura": "09:00", "cierre": "14:00" }
    ],
    "nombreAdministradora": "Ana Pérez",   // obligatorio, máx. 120
    "numeroEmpleados": 4,                  // obligatorio, entero de 1 a 10; decide el plan de la prueba (1-3 Básico, 4-5 Equipo, 6-10 Pro)
    "logoUrl": "https://cdn.central.co/logo.png", // opcional (o null); http:// o https://
    "correo": "ana@central.co",            // obligatorio: correo de inicio de sesión; único entre todas las cuentas
    "usuario": "ana.perez",                // obligatorio: 4 a 20, solo letras, números, punto y guion bajo; único (ver abajo)
    "clave": "clave-segura-123",           // obligatorio, 8 a 64 caracteres
    "aceptaPoliticaDatos": true,           // obligatorio: debe ser true (ver "Autorización de tratamiento de datos")
    "aceptaTerminos": true                 // obligatorio: debe ser true
  }
  ```

  - **Ya no existen** `nit`, `telefono` ni el correo de contacto del negocio (si llegan, se ignoran). `correo` ahora es solo el correo de inicio de sesión de la administradora.
  - **Código del negocio** (`codigoAcceso`): lo escribe la administradora. Solo letras (sin tildes ni ñ) y números, sin espacios, de 1 a 10 caracteres; no distingue mayúsculas (se guarda y se devuelve en mayúsculas: `central10` → `CENTRAL10`); no puede tenerlo otro negocio. Antes de enviar el formulario se puede revisar con `GET /api/v1/empresas/codigo-disponible/:codigo`.
  - **Usuario**: no puede repetirse con ninguna otra administradora ni con nadie del personal activo, sin distinguir mayúsculas (`Ana.Perez` = `ana.perez`). La base lo garantiza (índice único + trigger, migraciones 007 y 008). Lo mismo aplica al crear personal en `POST /equipo`: no puede usar el usuario de una administradora.
  - **Departamento y ciudad**: se validan con la lista oficial DIVIPOLA del DANE (`GET /api/v1/ubicaciones`). No distinguen tildes ni mayúsculas, y se guardan y devuelven con el nombre oficial en mayúsculas (`santander` / `bucaramanga` → `SANTANDER` / `BUCARAMANGA`). Se aceptan algunos nombres comunes: `Bogotá` (→ `BOGOTÁ, D.C.`), `Valle`, `San Andrés`, `Cartagena`, `Cúcuta`, `Tumaco`, `Buga`, `Mariquita`, `Ubaté`.
  - **Horario**: un elemento por cada día, `dia` de 0 (domingo) a 6 (sábado), cada día una sola vez. `abierto: false` = cerrado ese día (no lleva horas). Cada día abierto lleva `apertura` y `cierre` en HH:MM de 24 h, con el cierre posterior a la apertura. Al menos un día abierto. Las reservas respetan el horario de cada día.

- Responde **201**:

  ```json
  {
    "mensaje": "Empresa registrada. Tu prueba gratuita de 15 días comenzó hoy.",
    "token": "<jwt>",
    "usuario": { "id": "…", "correo": "ana@central.co", "usuario": "ana.perez", "rol": "admin", "empresaId": "…" },
    "empresa": {
      "id": "…", "nombre": "Barbería Central", "codigoAcceso": "CENTRAL10", "enlacePublico": "https://agendaya.app/CENTRAL10",
      "estadoSuscripcion": "trial", "trialEndsAt": "2026-11-02T18:00:00.000Z", "diasPruebaRestantes": 15
    }
  }
  ```

  `trialEndsAt` = momento del registro + 15 días.
- Errores: **400** dato faltante o inválido, por ejemplo:
  - `El campo "ciudad" es obligatorio`, `El correo no es válido`, `La contraseña debe tener entre 8 y 64 caracteres e incluir una mayúscula, una minúscula, un número y un carácter especial`
  - `El número de empleados debe ser un número entero entre 1 y 10`
  - `El usuario debe tener entre 4 y 20 caracteres: solo letras, números, punto y guion bajo`
  - `El código del negocio solo puede tener letras (sin tildes ni ñ) y números, sin espacios, máximo 10 caracteres`
  - `El departamento no es un departamento de Colombia`, `La ciudad no es un municipio de ese departamento`
  - `El campo "horario" es obligatorio`, `El horario debe traer los 7 días de la semana (0 = domingo … 6 = sábado), cada uno una sola vez`, `Indica en cada día del horario si está abierto ("abierto": true o false)`, `El martes está abierto: indica su hora de apertura y de cierre`, `El miércoles, la hora de cierre debe ser posterior a la de apertura`, `Las horas del horario deben tener el formato HH:MM (24 horas)`, `El negocio debe abrir al menos un día`

  - `Debes aceptar la Política de Tratamiento de Datos y los Términos y Condiciones` (falta `aceptaPoliticaDatos` o `aceptaTerminos`, o no es `true`)

  **409** `Ya existe una cuenta con ese correo`, `Ese usuario ya está en uso. Elige otro.` o `Ese código ya lo usa otro negocio. Elige otro.`; **429** demasiados registros.

**GET `/api/v1/empresas/codigo-disponible/:codigo`**: público (sin token), mismo límite por IP que `/empresas/validar/:codigo`.

- Responde **200** `{ "codigo": "CENTRAL10", "disponible": true }` (`codigo` normalizado en mayúsculas). `disponible: false` si ya lo tiene un negocio, incluido el propio (en "Mi negocio", enviar el mismo código de siempre no es un error).
- Errores: **400** `El código del negocio solo puede tener letras (sin tildes ni ñ) y números, sin espacios, máximo 10 caracteres`; **429**.

**GET `/api/v1/ubicaciones`**: público. **200** `[{ "codigo": "68", "nombre": "SANTANDER", "municipios": [{ "codigo": "68001", "nombre": "BUCARAMANGA" }, …] }, …]`: los 33 departamentos (incluye `BOGOTÁ, D.C.`) y sus 1122 municipios, ordenados por nombre. Envía `nombre` tal cual en el registro. La respuesta se puede guardar en caché un día.

**POST `/api/v1/cuentas/registro/cliente`**: crea una cuenta de cliente (sin empresa). Es opcional: se puede seguir reservando como invitado.

- Recibe:

  ```jsonc
  {
    "nombre": "Juan Gómez",        // obligatorio, máx. 100 (se usa al reservar)
    "telefono": "3001234567",      // obligatorio; se valida y se guarda en E.164 (ver "Teléfonos"); único entre las cuentas de cliente
    "indicativo": "57",            // opcional, por defecto 57 (Colombia)
    "correo": "juan@correo.com",   // correo o usuario (o los dos): con eso inicia sesión
    "usuario": "juan.gomez",       // mismas reglas y unicidad que el usuario de la administradora
    "clave": "clave-segura-123",   // 8 a 64 caracteres
    "aceptaPoliticaDatos": true,   // obligatorio: true
    "aceptaTerminos": true         // obligatorio: true
  }
  ```

- Responde **201** `{ "mensaje": "Cuenta creada", "token": "<jwt>", "usuario": { "id", "correo" | null, "usuario" | null, "rol": "cliente", "empresaId": null, "nombre", "telefono": "+573001234567", "indicativo": "57" } }`. Inicia sesión después con `/api/v1/login` (correo o usuario).
- Errores: **400** (`Envía tus datos para crear la cuenta` si no hay cuerpo, `El campo "nombre" es obligatorio`, `El campo "teléfono" es obligatorio`, el mensaje de teléfono inválido (ver "Teléfonos"), `Envía tu correo o un nombre de usuario para iniciar sesión`, `El correo no es válido`, el mensaje de usuario inválido, `La contraseña debe tener entre 8 y 64 caracteres e incluir una mayúscula, una minúscula, un número y un carácter especial`, `Debes aceptar la Política de Tratamiento de Datos y los Términos y Condiciones`); **409** `Ya existe una cuenta con ese correo`, `Ese usuario ya está en uso. Elige otro.` o `Ya existe una cuenta con ese número de teléfono`; **429**.

**POST `/api/v1/cuentas/login`**: login de administradoras y clientes con correo (se mantiene; para la administradora también sirve `/api/v1/login`).

- Recibe `{ "correo", "clave" }` (el correo no distingue mayúsculas).
- Responde **200** `{ "mensaje": "Autenticación exitosa", "token": "<jwt>", "usuario": { "id", "correo", "usuario", "rol", "empresaId", "nombre", "telefono", "indicativo" } }` (los clientes además llevan `debeAceptarDocumentos`). `usuario.rol` (`admin` o `cliente`) indica qué pantallas mostrar. Un cliente que se registró solo con usuario entra por `/api/v1/login`.
- Errores: **400** `Debes enviar correo y contraseña`; **401** `Correo o contraseña incorrectos` (igual si el correo no existe); **429**.

**GET `/api/v1/admin/empresa/suscripcion`** (los dos tipos de admin; responde aunque esté vencida): la suscripción de la empresa.

- Responde **200**:

  ```json
  { "estado": "activa", "plan": "mensual", "fechaPago": "2026-10-19", "fechaFin": "2026-11-19",
    "diasRestantes": 5, "diasPruebaSumados": null, "mostrarRecordatorio": true,
    "mensaje": "Te quedan 5 días de tu plan mensual. Renuévalo para no perder el acceso.",
    "planEquipo": { "id": "equipo", "nombre": "Equipo", "cupo": 5 }, "cupoUsado": 3, "cupoDisponible": 2,
    "fechaRegistro": "2026-10-05" }
  ```

- `plan` es el **periodo** (`"mensual"` o `"anual"`); `planEquipo` es el **plan por tamaño de equipo** (ver "Planes"), también durante la prueba. `cupoUsado` = integrantes activos en Equipo; `cupoDisponible` = cuántos más se pueden agregar.
- `fechaRegistro` (AAAA-MM-DD, hora de Colombia): día en que se registró el negocio. Es la fecha más antigua que acepta el resumen de la cartera con `rango`. `null` en empresas sin fecha de creación.

- `estado`: `"prueba"` (15 días gratis desde el registro), `"activa"` (plan `"mensual"` o `"anual"`) o `"vencida"`.
- Si la empresa activó el plan **durante la prueba**, pasa de inmediato a `"activa"` y el plan empieza a contar desde el fin de la prueba. `diasPruebaSumados` = días de prueba que le quedaban y se sumaron al plan (`0` si pagó con la prueba ya vencida). `null` en la prueba o si el plan no se activó durante una prueba. Se conserva al renovar.
- `fechaPago` y `plan` son `null` en la prueba. `fechaFin` (AAAA-MM-DD) es el día en que termina la prueba o el plan. Las empresas activas de antes de los planes tienen `plan`, `fechaPago`, `fechaFin` y `diasRestantes` en `null` y no vencen.
- `diasRestantes` = `fechaFin` − hoy, con la **fecha actual de Colombia**: baja uno cada día a medianoche. El día de `fechaFin` ya es 0 y la suscripción queda **vencida**. Vencida = `0`.
- `mostrarRecordatorio`: `true` siempre durante la prueba y en los últimos 7 días de un plan (`diasRestantes` ≤ 7). `mensaje` es el texto para mostrar (o el aviso de vencida); `null` si no hay nada que mostrar.
- `suspendida`: `true` si soporte suspendió el negocio (ver "Panel del superadministrador"). Entonces `estado` es `"vencida"`, `diasRestantes` es `0` y `mensaje` es `Negocio suspendido; contacta a soporte`.
- Los planes se activan con `npm run dev:activar-plan` (no hay pagos reales; ver "Comandos de desarrollador").

**Planes** (`GET /api/v1/planes`, público): tres planes por tamaño de equipo, cada uno mensual o anual. Cupo y precios en `src/config/planes.ts` (los precios actuales son **de ejemplo**).

- Responde **200** `[{ "id": "basico", "nombre": "Básico", "cupo": 3, "precioMensual": 30000, "precioAnual": 300000, "moneda": "COP" }, { "id": "equipo", "nombre": "Equipo", "cupo": 5, … }, { "id": "pro", "nombre": "Pro", "cupo": 10, … }]`.
- El cupo es el máximo de integrantes activos en Equipo (ver "Equipo"). Al registrarse, el plan de la prueba sale de `numeroEmpleados`: 1-3 Básico, 4-5 Equipo, 6-10 Pro.
- El plan se cambia con `npm run dev:activar-plan` (no hay pagos reales). Cambiar a un plan menor se rechaza si el equipo activo no cabe.

**Cuando la suscripción está vencida**:
- Un negocio **suspendido** por el superadmin se comporta igual que uno vencido (misma lista de abajo), con estas diferencias de texto: a la administradora le responde 402 `Negocio suspendido; contacta a soporte`; a los empleados, el aviso de negocio inactivo de siempre; a los clientes, `recibiendoReservas: false` y 403 al reservar. Reactivarlo lo deja como estaba (la suspensión no cambia el plan ni las fechas: el tiempo suspendido sigue corriendo).
- La administradora (cuenta o integrante admin) **puede iniciar sesión** y usar Mi negocio (`GET`/`PATCH /admin/empresa`, `PUT /admin/empresa/foto`) y la consulta de suscripción. Todo lo demás responde **402** (equipo, servicios, productos, bloqueos, clientes, cartera, agenda, completar y cancelar citas).
- Los **empleados** no pueden entrar: el login, la agenda, completar citas y la cartera responden **402** `Este negocio está inactivo por ahora. Comunícate con el administrador del negocio.` (`/empresas/actual` sigue respondiendo: es la misma información pública de `/empresas/validar/:codigo`).
- Los **clientes no pueden reservar**: `POST /citas` responde **403** `Este negocio no está recibiendo reservas por ahora`. `/empresas/validar/:codigo` (`empresa.recibiendoReservas`), `/empresas/perfil/:codigo` y `/mi-cuenta/negocios` traen `recibiendoReservas: false` para avisar antes.

**GET `/api/v1/admin/empresa/intervalo`** y **PUT `/api/v1/admin/empresa/intervalo`** (solo administradores; funcionan aunque la suscripción esté vencida): el intervalo de horarios del negocio, o sea cada cuántos minutos pueden agendar los clientes. Con 10 las horas son 10:00, 10:10, 10:20…; con 30, 10:00, 10:30…
- GET responde **200** `{ "intervaloMinutos": 30, "opciones": [10, 20, 30, 40, 50, 60] }`. Por defecto 30.
- PUT recibe `{ "intervaloMinutos": 20 }` y responde **200** `{ "mensaje": "Intervalo de horarios actualizado", "intervaloMinutos": 20, "opciones": […] }`. **400** `El intervalo debe ser 10, 20, 30, 40, 50, 60 minutos` si no es una de las opciones. Aplica de inmediato a las horas disponibles; las citas ya agendadas no cambian.
- También viene como `intervaloMinutos` en `GET`/`PATCH /admin/empresa` y en `GET /empresas/perfil/:codigo`.

**GET `/api/v1/admin/empresa/prueba`** (se mantiene para la app de antes; usa `/suscripcion`): días de prueba que le quedan a la empresa.

- Responde **200** `{ "estadoSuscripcion": "trial", "trialEndsAt": "<fecha ISO>", "diasRestantes": 12, "pruebaVencida": false }`.
- `diasRestantes` se cuenta igual que en `/suscripcion` (fecha de Colombia) y nunca es negativo; es `null` si la empresa no está en prueba (por ejemplo `"activa"`). Con la prueba vencida responde `diasRestantes: 0` y `pruebaVencida: true`.

**GET `/api/v1/admin/empresa`** ("Mi negocio"): perfil de la empresa del administrador (siempre la suya; no recibe id). Lo usan la cuenta admin y los integrantes con rol Administrador. `estadoSuscripcion` es el estado guardado; el estado real (con la fecha de fin) está en `/admin/empresa/suscripcion`.

- Responde **200** `{ "id", "nombre", "codigoAcceso", "enlacePublico", "categoria", "direccion", "departamento", "ciudad", "horario", "diasAtencion", "horarioApertura", "horarioCierre", "nombreAdministradora", "numeroEmpleados", "logoUrl", "fotoUrl", "colorPrimario", "colorSecundario", "latitud", "longitud", "precisionUbicacion", "googleMapsUrl", "estadoSuscripcion", "trialEndsAt", "creadaEn" }`.
- `latitud` y `longitud`: números con hasta 6 decimales (≈ 11 cm) o `null` (ubicación en el mapa, opcional). `precisionUbicacion`: precisión del GPS en metros (un decimal) o `null`. `googleMapsUrl`: enlace de Google Maps (ver "Ubicación en Google Maps").
- `horario` siempre trae los 7 días, de domingo (0) a sábado (6): `{ "dia": 0, "abierto": false, "apertura": null, "cierre": null }` o `{ "dia": 1, "abierto": true, "apertura": "08:00", "cierre": "19:00" }`.
- `diasAtencion` (días abiertos), `horarioApertura` (la apertura más temprana de la semana) y `horarioCierre` (el cierre más tardío) se calculan a partir de `horario` y se mantienen para que la app actual siga funcionando; para el horario real de cada día usa `horario`.
- Ya no incluye `nit`, `telefono` ni `correo`. `departamento` es `null` en empresas registradas antes de la migración 007 hasta que lo completen.
- `fotoUrl` es la dirección completa de la foto subida (ej. `https://api.mibarberia.co/uploads/empresas/<uuid>.jpg`) o `null` si no tiene. `logoUrl` es otro campo: una dirección web que el administrador escribe a mano.

**PATCH `/api/v1/admin/empresa`**: modifica la empresa del administrador.

- Recibe uno o más de: `nombre`, `categoria`, `codigoAcceso`, `direccion`, `departamento` + `ciudad` (siempre juntos), `horario` (los 7 días, reemplaza el horario completo), `nombreAdministradora`, `numeroEmpleados`, `logoUrl`, `latitud` + `longitud` (siempre juntas; números, `null` en las dos las quita; si traen más de 6 decimales se redondean a 6), `precisionUbicacion` (opcional, metros: mayor que 0 y hasta 100000, redondeada a un decimal; solo junto con `latitud` y `longitud`; si se envían coordenadas nuevas sin ella queda en `null`, y al quitar las coordenadas también se quita). Mismas validaciones del registro. Se ignoran `id`, `empresaId`, `estadoSuscripcion`, `trialEndsAt`, `correo`, `usuario`, `clave` y cualquier otro campo (el acceso de la administradora no se cambia aquí).
- Cambiar `codigoAcceso` cambia el código que usan los clientes: el anterior deja de funcionar de inmediato.
- Responde **200** con el perfil actualizado (misma forma que el GET). Los datos y el horario se guardan juntos: si algo falla, no cambia nada.
- `numeroEmpleados` ya **no limita** el equipo (el límite es el cupo del plan). **Durante la prueba** cambia el plan: 1-3 Básico, 4-5 Equipo, 6-10 Pro; si el equipo activo no cabe en ese plan, responde 409. Fuera de la prueba es solo informativo.
- Errores: **400** `Envía al menos un dato para actualizar`, `Envía el departamento y la ciudad juntos`, `Envía la latitud y la longitud juntas (o las dos en null para quitarlas)`, `Envía la precisión de la ubicación junto con la latitud y la longitud`, `La precisión de la ubicación debe ser un número de metros mayor que 0 y hasta 100000`, `La latitud debe ser un número entre -90 y 90`, `La longitud debe ser un número entre -180 y 180` y los de validación del registro; **409** `Ese código ya lo usa otro negocio. Elige otro.` o (en la prueba) `Tu equipo tiene 4 integrante(s) activo(s) y el plan Básico permite hasta 3. Elimina primero del equipo a quien ya no trabaje en el negocio, o elige un plan más grande.`

**PUT `/api/v1/admin/empresa/foto`**: sube la foto del negocio o reemplaza la que tenía (la anterior se borra del servidor).

- Recibe `multipart/form-data` con **un solo** archivo en el campo `foto` y nada más. Solo JPG, PNG o WEBP, máximo 5 MB. El tipo se comprueba por el contenido del archivo, no por su nombre. Ejemplo en Expo:

  ```ts
  const datos = new FormData();
  datos.append('foto', { uri, name: 'foto.jpg', type: 'image/jpeg' } as any);
  await fetch(`${API}/api/v1/admin/empresa/foto`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` }, // no pongas Content-Type: fetch lo arma
    body: datos,
  });
  ```

- Responde **200** `{ "mensaje": "Foto del negocio actualizada", "fotoUrl": "https://…/uploads/empresas/<uuid>.jpg" }`.
- Errores: **400** `La foto debe ser una imagen JPG, PNG o WEBP` o `Envía la imagen en el campo "foto" (multipart/form-data)` (sin archivo, otro campo, más de un archivo o cuerpo mal formado); **413** `La foto no puede pesar más de 5 MB`; además los errores comunes de `/api/v1/admin/...` (401, 403, 402).
- La foto queda en `<CARPETA_SUBIDAS>/empresas/` con un nombre aleatorio; la base guarda solo la ruta (`/uploads/empresas/<uuid>.<ext>`, columna `empresas.foto_url`, migración 004). Para mostrarla usa `fotoUrl` tal cual.

**GET `/api/v1/empresas/perfil/:codigo`**: información del negocio para los clientes, con su foto. Público (sin token), usa el mismo código de acceso de `/empresas/validar/:codigo` y el mismo límite por IP.

- Responde **200** `{ "id", "nombre", "codigoAcceso", "categoria", "direccion", "departamento", "ciudad", "horario", "diasAtencion", "horarioApertura", "horarioCierre", "logoUrl", "fotoUrl", "colorPrimario", "colorSecundario", "googleMapsUrl", "recibiendoReservas" }` (`recibiendoReservas: false` si la suscripción venció), con `horario` y los campos calculados igual que en `GET /admin/empresa`. Ya no incluye `telefono` ni `correo`. No incluye nombre de la administradora, número de empleados ni datos de la suscripción. Los campos sin dato llegan como `null`.
- Errores: **404** `Establecimiento no encontrado`; **429** demasiados intentos.

**Ubicación en Google Maps** (`googleMapsUrl`, en `GET /empresas/perfil/:codigo` y en `GET`/`PATCH /admin/empresa`): enlace `https://www.google.com/maps/search/?api=1&query=...` (no necesita clave de API). Con las coordenadas si el negocio las tiene (`query=7.119349%2C-73.122741`); si no, con la dirección, el municipio y el departamento (`query=Calle%2010%20%23%2020-30%2C%20BUCARAMANGA%2C%20SANTANDER`). `null` si no hay ningún dato. Las coordenadas se editan en Mi negocio (`PATCH /admin/empresa` con `latitud` y `longitud`); no se piden en el registro.

**Errores comunes de `/api/v1/admin/...`**

- **401**: sin token o token vencido.
- **403** `Solo el administrador del negocio puede usar esta función.` (empleado) o `Esta función es solo para el personal del negocio.` (cliente).
- `/api/v1/admin/empresa/...` ya no responde 402: funciona con la suscripción vencida.

**Mensajes 402 (suscripción no vigente)** en los endpoints de gestión, la agenda y las citas:
  - prueba vencida: `Tu prueba gratuita de 15 días terminó. Activa tu suscripción para seguir usando las funciones de administrador.`
  - plan vencido o `vencida`: `La suscripción de tu empresa venció. Renuévala para seguir usando las funciones de administrador.`
  - `cancelada`: `La suscripción de tu empresa está cancelada. Actívala para seguir usando las funciones de administrador.`
  - a un empleado, siempre: `Este negocio está inactivo por ahora. Comunícate con el administrador del negocio.`

### Gestión del negocio (personal y cuenta del administrador)

Todos usan `Authorization: Bearer <token>` del barbero o de la cuenta admin. El negocio sale siempre de la sesión: nunca va en la URL ni en el cuerpo, y un `:id` de otro negocio responde 404.

**Errores comunes de estos endpoints**

- **401** `Sesión no válida. Inicia sesión de nuevo.` o `Sesión vencida. Inicia sesión de nuevo.`
- **403** `Esta función es solo para el personal del negocio.` (token de cliente) o `Solo el administrador del negocio puede usar esta función.` (empleado en un endpoint de admin).
- **402**: prueba gratuita o plan vencido, con los mensajes de "Mensajes 402". Aplica a todos estos endpoints (también a los empleados), menos a los públicos.
- **400** `Envía al menos un dato para actualizar` en un `PATCH` sin campos, y el mensaje de validación del campo (ej. `El campo "nombre" es obligatorio`).

**Permisos por rol**: la cuenta admin y los integrantes con rol Administrador pueden todo lo de esta sección. Un **empleado** solo puede `GET /citas/agenda` (sus citas), `PATCH /citas/:id/completar` (las suyas), `GET /cartera` (solo la suya) y `GET /empresas/actual`; en lo demás responde 403.

**Fotos de equipo y productos**: `PUT .../foto` recibe `multipart/form-data` con un solo archivo en el campo `foto`, igual que la foto del negocio: JPG, PNG o WEBP (se comprueba por el contenido), máximo 5 MB. Errores **400** `La foto debe ser una imagen JPG, PNG o WEBP` o `Envía la imagen en el campo "foto" (multipart/form-data)`; **413** `La foto no puede pesar más de 5 MB`. La foto anterior se borra del servidor. Los archivos quedan en `<CARPETA_SUBIDAS>/barberos/` o `<CARPETA_SUBIDAS>/productos/`; la API devuelve la dirección completa (`https://…/uploads/barberos/<uuid>.jpg`). Las fotos antiguas del equipo que ya eran direcciones web se devuelven tal cual. `/empresas/actual` y `/empresas/validar/:codigo` también devuelven `foto` del equipo como dirección completa. En esos dos, `empresa` trae además `horario` (los 7 días, misma forma que en `GET /admin/empresa`); `horarioApertura` y `horarioCierre` ahora son la apertura más temprana y el cierre más tardío de la semana.

#### Clientes (solo admin)

**GET `/api/v1/clientes`**: **200** clientes del negocio, del más reciente al más antiguo:

```json
[{ "id": "…", "nombre": "Juan", "telefono": "+573001234567", "indicativo": "57", "totalCitas": 4,
   "citasCompletadas": 3, "citasCanceladas": 1, "fechaUltimaCita": "2026-10-10", "estado": "activo",
   "enListaNegra": false, "listaNegraId": null }]
```

- `estado`: `"activo"` si el cliente tiene una cita no cancelada desde hace 45 días hasta hoy, o una cita próxima (fecha de Colombia; una visita de hoy cuenta como activo). Si no, `"inactivo"`. Se calcula en cada consulta a partir de sus citas.
- `citasCompletadas` y `citasCanceladas`: cuántas citas del cliente en el negocio están en cada estado. `totalCitas` son las reservas que hizo.
- `fechaUltimaCita`: la fecha más lejana que ha reservado (puede ser futura); reservar una fecha anterior ya no la hace retroceder.

**GET `/api/v1/clientes/:id/historial`**: **200** `{ "cliente": { …misma forma que la lista… }, "citas": [{ "id", "fecha": "2026-10-10", "hora": "03:30 PM", "servicio", "barberoId", "barberoNombre", "precio": 25000, "estado": "COMPLETADA" }] }`, citas de la más reciente a la más antigua. **404** `Cliente no encontrado`.

**GET `/api/v1/clientes/lista-negra`**: **200** `[{ "id", "nombre", "telefono", "agregadoEn": "<fecha ISO>" }]`.

**POST `/api/v1/clientes/lista-negra`**: recibe `{ "clienteId": "…" }` y guarda el nombre y teléfono de ese cliente. **201** `{ "mensaje": "Cliente agregado a la lista negra", "id", "nombre", "telefono", "agregadoEn" }`. Errores: **400** `Envía el identificador del cliente en "clienteId"`; **404** `Cliente no encontrado`; **409** `Este cliente ya está en la lista negra`.

**DELETE `/api/v1/clientes/lista-negra/:id`** (`:id` = `id` de la lista negra, o `listaNegraId` del cliente): **200** `{ "mensaje": "Cliente quitado de la lista negra" }`. **404** `Ese registro no está en la lista negra`.

Un teléfono de la lista negra (se comparan solo los dígitos; los dos están en E.164) no puede reservar: `POST /api/v1/citas` responde **403** `No es posible agendar con este número. Comunícate con el negocio.`

#### Equipo (solo admin)

Forma de un profesional: `{ "id", "nombre", "usuario", "rol": "admin" | "empleado", "esAdmin": false, "atiendeClientes": true, "especialidad": "Barbero" | null, "porcentajeGanancia": 50, "foto": "<url>" | null }`.

- **Rol**: `"admin"` (Administrador: los mismos permisos que la cuenta admin) o `"empleado"` (Empleado: solo su agenda y su cartera). `esAdmin` se mantiene igual a `rol === "admin"`.
- **Atiende clientes** (`atiendeClientes`): si recibe reservas como profesional. Quien no atiende no aparece en la vista pública del negocio (`/empresas/validar/:codigo`) y no se puede reservar con él (`POST /citas` responde 404 `Servicio o profesional no encontrado`). En `/empresas/actual` aparecen todos, con `atiendeClientes`.
- **Límite (cupo del plan)**: no puede haber más integrantes activos que el cupo del plan de la empresa (Básico 3, Equipo 5, Pro 10; ver "Planes"). Cuentan los integrantes activos de Equipo: la cuenta de correo de la administradora no cuenta, salvo que también esté agregada como integrante. Los eliminados no cuentan. Si un negocio ya tenía más, conserva su equipo pero no puede agregar a nadie hasta quedar por debajo.

**GET `/api/v1/equipo`**: **200** lista del equipo activo.

**POST `/api/v1/equipo`**: recibe

```jsonc
{
  "nombre": "Carlos",            // obligatorio, máx. 100
  "usuario": "carlos.r",         // obligatorio, 3 a 60: letras, números, . _ -; único (sin distinguir mayúsculas)
  "clave": "clave-segura",       // obligatorio, 8 a 64 caracteres; con ella entra en /api/v1/auth/login
  "rol": "empleado",             // opcional: "admin" (Administrador) o "empleado" (Empleado, por defecto)
  "esAdmin": false,              // opcional, se mantiene para la app de antes; si llega "rol", manda "rol"
  "atiendeClientes": true,       // opcional; por defecto true para un empleado y false para un administrador
  "especialidad": "Barbero",     // opcional (o null), máx. 100
  "porcentajeGanancia": 50       // opcional, 0 a 100, por defecto 50
}
```

**201** con el profesional. Errores: **400** validación (ej. `La contraseña debe tener entre 8 y 64 caracteres e incluir una mayúscula, una minúscula, un número y un carácter especial`, `El rol debe ser "admin" (Administrador) o "empleado" (Empleado)`); **409** `Ese usuario ya está en uso. Elige otro.` (también si es el usuario de una administradora o de un cliente) o, con el cupo lleno, `Tu equipo ya tiene 3 integrante(s) activo(s) y tu plan Básico permite hasta 3. Para agregar a alguien más, sube al plan Equipo (hasta 5 personas).` (en Pro: `… tu plan Pro permite hasta 10. Es el plan más grande: para agregar a alguien, elimina primero del equipo a quien ya no trabaje en el negocio.`)

**PATCH `/api/v1/equipo/:id`**: uno o más campos del POST (`rol` cambia el rol, `atiendeClientes` activa o quita las reservas, `clave` cambia la contraseña; `especialidad: null` la quita). **200** con el profesional. Errores: **400** `No puedes quitarte a ti mismo el rol de administrador.`; **404** `Profesional no encontrado`; **409** usuario repetido.

**DELETE `/api/v1/equipo/:id`**: **200** `{ "mensaje": "Profesional eliminado" }`. Ya no inicia sesión ni recibe reservas; sus citas pasadas y la cartera lo siguen mostrando. Errores: **400** `No puedes eliminar tu propio usuario.`; **404** `Profesional no encontrado`; **409** `Este profesional tiene N cita(s) pendiente(s). Cancélalas antes de eliminarlo.`

**PUT `/api/v1/equipo/:id/foto`** (multipart, campo `foto`): **200** `{ "mensaje": "Foto del profesional actualizada", "foto": "<url>" }`. **404** `Profesional no encontrado`.

#### Servicios

Forma: `{ "id", "nombre", "duracionMin": 30, "duracion": "30 min", "precio": 25000 }`.

**GET `/api/v1/servicios`** (admin): **200** servicios activos.

**POST `/api/v1/servicios`** (admin): recibe `{ "nombre": "Corte", "duracionMin": 30, "precio": 25000 }`, todos obligatorios: `nombre` máx. 100; `duracionMin` múltiplo de 10 de 10 a 150 (2 h 30; **400** `La duración debe ser un múltiplo de 10 minutos, de 10 a 150 (2 h 30)`); `precio` 0 o más, máximo 2 decimales. **201** con el servicio.

**PATCH `/api/v1/servicios/:id`** (admin): uno o más de esos campos. **200** con el servicio. Las citas ya agendadas conservan su precio y duración. **404** `Servicio no encontrado`.

**DELETE `/api/v1/servicios/:id`** (admin): **200** `{ "mensaje": "Servicio eliminado" }`. Deja de ofrecerse; las citas pasadas lo siguen mostrando. **404** `Servicio no encontrado`.

#### Productos

Forma: `{ "id", "nombre", "descripcion": "…" | null, "precio": 30000, "fotoUrl": "<url>" | null }`.

**GET `/api/v1/productos/catalogo/:codigo`** (público, sin token; mismo código y límite por IP que `/empresas/validar/:codigo`): **200** productos del negocio (puede ser `[]`). **404** `Establecimiento no encontrado`; **429**.

**GET `/api/v1/productos`** (admin): **200** productos del negocio.

**POST `/api/v1/productos`** (admin): recibe `{ "nombre": "Cera", "precio": 30000, "descripcion": "Fijación fuerte" }`: `nombre` obligatorio (máx. 100), `precio` obligatorio (0 o más, máx. 2 decimales), `descripcion` opcional o null (máx. 500). **201** con el producto, sin foto. La foto (opcional) se agrega después con `PUT /productos/:id/foto`.

**PATCH `/api/v1/productos/:id`** (admin): uno o más de esos campos (`descripcion: null` la quita). **200** con el producto. **404** `Producto no encontrado`.

**DELETE `/api/v1/productos/:id`** (admin): **200** `{ "mensaje": "Producto eliminado" }`; también borra su foto. **404** `Producto no encontrado`.

**PUT `/api/v1/productos/:id/foto`** (admin, multipart, campo `foto`): **200** `{ "mensaje": "Foto del producto actualizada", "fotoUrl": "<url>" }`. **404** `Producto no encontrado`.

**DELETE `/api/v1/productos/:id/foto`** (admin): **200** `{ "mensaje": "Foto del producto eliminada", "fotoUrl": null }`. **404** `Producto no encontrado`.

#### Bloqueos de horario (semanales y de solo ese día)

**Solo la administradora** (integrante admin o cuenta admin) ve, crea y borra bloqueos. Los empleados no ven ni usan bloqueos (403). Hay dos tipos:

- **Semanal** (`tipo: "semanal"`): se repite cada semana el mismo día (ej. almuerzo de los lunes). Lleva `diaSemana` (0 = domingo … 6 = sábado) y `fecha: null`.
- **Solo ese día** (`tipo: "fecha"`): una fecha concreta. Lleva `fecha` (AAAA-MM-DD) y `diaSemana: null`.

Cualquiera de los dos puede ser de unas horas (`horaInicio`–`horaFin`) o del **día completo** (`todoElDia: true`, que se guarda y se devuelve como `"00:00"`–`"24:00"`).

Forma: `{ "id", "barberoId", "barberoNombre", "tipo": "semanal" | "fecha", "diaSemana": 1 | null, "fecha": "2026-10-21" | null, "todoElDia": false, "horaInicio": "12:00", "horaFin": "13:00", "motivo": "Almuerzo" | null }`.

**GET `/api/v1/bloqueos`** (solo admin): **200** lista: los semanales y los de fecha de hoy en adelante (hora de Colombia), de todo el equipo (opcional `?barberoId=` para filtrar).

**POST `/api/v1/bloqueos`** (solo admin): recibe uno de estos cuerpos (`motivo` opcional, máx. 200):

```jsonc
{ "barberoId": "…", "diaSemana": 1, "horaInicio": "12:00", "horaFin": "13:00", "motivo": "Almuerzo" } // semanal
{ "barberoId": "…", "fecha": "2026-10-21", "horaInicio": "10:00", "horaFin": "11:00" }            // unas horas de ese día
{ "barberoId": "…", "fecha": "2026-10-22", "todoElDia": true, "motivo": "Vacaciones" }          // ese día completo
```

Horas HH:MM de 24 h, fin posterior al inicio; con `todoElDia: true` las horas se ignoran. **201** con el bloqueo. Errores: **400** `Elige el profesional en "barberoId"`, `Envía "diaSemana" para un bloqueo que se repite cada semana, o "fecha" para un bloqueo de solo ese día (solo uno de los dos)`, `Envía "horaInicio" y "horaFin", o "todoElDia": true para bloquear el día completo`, `La hora de fin debe ser posterior a la hora de inicio`, `El campo "fecha" debe ser una fecha real con el formato AAAA-MM-DD`, `El día debe ser un número del 0 (domingo) al 6 (sábado)`, `El negocio está cerrado los domingos. Elige un día en que esté abierto.` (semanal) o `El negocio está cerrado el domingo 2026-10-25. Elige un día en que esté abierto.` (de una fecha), `El bloqueo debe estar dentro del horario del negocio: los lunes abre de 08:00 a 18:00.` (o `el martes 2026-10-20 abre de …`); **403** `Solo el administrador del negocio puede usar esta función.` (barbero sin `esAdmin`); **404** `Profesional no encontrado`; **409** `Hay una cita en ese horario` (ver abajo); **400** `Las horas del bloqueo deben seguir el intervalo de horarios del negocio: de 30 en 30 minutos.`

Un bloqueo solo se puede crear en un día que el negocio abre (según el `horario` de ese día de la semana; en uno de una fecha, el día de la semana de esa fecha) y, si es de unas horas, dentro de la apertura y el cierre de ese día (los bordes cuentan: de 08:00 a 18:00 es válido si abre de 08:00 a 18:00). Uno de día completo solo exige que ese día abra. Los bloqueos que ya existían no se tocan, aunque hayan quedado fuera del horario.

- **No se puede bloquear una hora con cita**: si el profesional tiene una cita pendiente (`CONFIRMADA`) o completada que se cruza con el bloqueo, responde **409** `Hay una cita en ese horario`. Un bloqueo de fecha mira las citas de ese día; uno semanal, las de hoy en adelante que caen en ese día de la semana (las canceladas no cuentan). La revisión y el guardado son una sola transacción con el profesional bloqueado (`FOR UPDATE`), igual que las reservas: una reserva y un bloqueo a la vez no pueden quedar encima.
- **Las franjas siguen el intervalo del negocio** (`intervalo_minutos`, alineado al reloj: con 30, `10:00` y `10:30`): `horaInicio` y `horaFin` deben ser múltiplos del intervalo; también valen la apertura (como inicio) y el cierre (como fin) de ese día. Un día completo no se revisa. Los bloqueos que ya existían no se tocan.

**GET `/api/v1/bloqueos/calendario?desde=AAAA-MM-DD&hasta=AAAA-MM-DD&barberoId=`** (solo admin): los bloqueos y las citas de un rango (máximo 62 días; `barberoId` opcional) para mostrarlos juntos. **200**:

```json
{ "desde": "2026-10-21", "hasta": "2026-10-27", "intervaloMinutos": 30,
  "bloqueos": [ { …misma forma que GET /bloqueos: los semanales y los de fecha dentro del rango… } ],
  "citas": [ { "id", "barberoId", "barberoNombre", "fecha": "2026-10-21", "horaInicio": "10:00", "horaFin": "10:50", "servicio", "cliente", "estado": "CONFIRMADA" } ] }
```

`horaInicio` y `horaFin` son el inicio y el fin reales de la cita (según la duración de su servicio); no incluye las canceladas. `intervaloMinutos` es el de las franjas. Errores **400**: `La fecha "hasta" no puede ser anterior a "desde"`, `El rango no puede ser mayor que 62 días`. `GET /bloqueos` no cambia.

**DELETE `/api/v1/bloqueos/:id`** (solo admin): **200** `{ "mensaje": "Bloqueo eliminado" }`. **403** `Solo el administrador del negocio puede usar esta función.`; **404** `Bloqueo no encontrado`.

**GET `/api/v1/citas/bloqueos?empresaId=`** (público, para la pantalla de reservar): **200** los dos tipos, **sin el motivo**: `[{ "barberoId", "tipo": "semanal", "diaSemana": 1, "fecha": null, "todoElDia": false, "horaInicio": "12:00", "horaFin": "13:00" }, { "barberoId", "tipo": "fecha", "diaSemana": null, "fecha": "2026-10-22", "todoElDia": true, "horaInicio": "00:00", "horaFin": "24:00" }]`. Los de fecha solo de hoy en adelante (hora de Colombia). Una reserva que cae en cualquier bloqueo responde **409** `El profesional no atiende en ese horario. Por favor elige otra hora.`

#### Horas disponibles (`GET /api/v1/citas/disponibilidad`)

Público. Parámetros: `empresaId`, `barberoId`, `servicioId` y `fecha` (AAAA-MM-DD). Reemplaza la cuadrícula fija de la app: calcula las horas **de ese profesional, ese día y ese servicio**, con el horario del negocio ese día, sus citas (no canceladas), sus bloqueos (semanales y de esa fecha) y la **duración del servicio elegido**. Responde **200**:

```json
{ "empresaId": "…", "barberoId": "…", "servicioId": "…", "fecha": "2026-10-22", "duracionMin": 30, "intervaloMinutos": 30,
  "horas": [ { "inicio": "08:00", "hora": "08:00 AM", "pegada": true }, { "inicio": "08:30", "hora": "08:30 AM", "pegada": false } ] }
```

- `inicio` es HH:MM de 24 h; `hora` es el mismo momento en el formato de `POST /citas` (`"08:30 AM"`). `pegada: true` = recomendada: queda pegada a la apertura, al fin de una cita o bloqueo, o termina justo cuando empieza la siguiente cita, el siguiente bloqueo o el cierre (no deja huecos). Ordenadas de menor a mayor; `[]` si el negocio no atiende ese día o no queda espacio.
- **Qué se ofrece** (solo si el servicio cabe completo en el espacio libre): (1) siempre las horas pegadas; (2) en el resto del espacio libre, las horas del intervalo del negocio (`intervalo_minutos`, alineadas al reloj: con 30, 10:00 y 10:30), **salvo** las que dejarían antes o después del servicio un hueco más corto que el servicio activo más corto del negocio (ese hueco no se podría vender; los servicios no están ligados a un profesional, así que "el más corto" es el del negocio). Ejemplo: 08:00 a 12:00 con una cita de 09:10 a 09:50, servicio de 30 min, intervalo 30 y servicio más corto 20 → `08:00* 08:40* 09:50* 10:30 11:00 11:30*` (`*` = pegada; 08:30 y 10:00 se descartan porque dejarían un hueco de 10 min).
- Hoy no se ofrecen las horas que ya pasaron (hora de Colombia). Cálculo en `src/modules/citas/disponibilidad.ts` (funciones puras).
- Errores: **400** `No se pueden agendar citas en fechas pasadas` o `Solo puedes reservar desde hoy hasta 14 días después (…)`, `La fecha debe tener el formato AAAA-MM-DD`, `Falta el identificador …`; **403** negocio sin suscripción vigente; **404** `Servicio o profesional no encontrado`.
- `POST /citas` **no** exige que la hora venga de esta lista: solo que no choque (ver "Reservas").

#### Reservas (`POST /api/v1/citas`)

Cuerpo: `{ "empresaId", "barberoId", "servicioId", "fecha": "2026-10-21", "hora": "10:00 AM", "nombre", "telefono", "indicativo"?, "aceptaPoliticaDatos": true, "aceptaTerminos": true }`.

El teléfono se valida y se guarda en E.164 (ver "Teléfonos"); la respuesta trae `cita.telefono` en E.164 (`"+573001234567"`) y `cita.indicativo`. El cliente del negocio es el mismo si el número es el mismo, aunque se escriba distinto (`300 123 4567`, `+57 3001234567`).

- **Como invitado** (sin token; con código, enlace o QR): igual que antes, más la aceptación. `nombre` y `telefono` son obligatorios (**400** `Faltan datos para agendar la cita`) y `aceptaPoliticaDatos` y `aceptaTerminos` deben ser `true` en cada reserva (**400** `Debes aceptar la Política de Tratamiento de Datos y los Términos y Condiciones`). Se guarda la prueba con el teléfono.
- **Con sesión de cliente** (`Authorization: Bearer <token de la cuenta del cliente>`): se usan el nombre, teléfono e indicativo de la cuenta (lo que llegue en el cuerpo se ignora; una cuenta antigua sin esos datos usa los del cuerpo). No vuelve a aceptar: solo si se publicó una versión nueva de la política o los términos desde que aceptó, debe enviar los dos en `true` (**400** `Publicamos una nueva versión de la Política de Tratamiento de Datos o de los Términos y Condiciones. Acéptala para continuar.`). La cita queda en "Mis citas" (`GET /mi-cuenta/citas`).
- Cualquier otro token (personal, admin o vencido) se ignora: la reserva es de invitado.
- Negocio con la suscripción vencida: **403** `Este negocio no está recibiendo reservas por ahora`.
- Solo con profesionales que atienden clientes (`atiendeClientes`); si no, **404** `Servicio o profesional no encontrado`.

**La revisión de la hora y el guardado son una sola transacción**: se bloquea la fila del profesional (`SELECT … FOR UPDATE` sobre `barberos`, que también espera a un bloqueo que se esté creando), y dentro se comprueba que la hora no choque con **un bloqueo** (**409** `El profesional no atiende en ese horario. Por favor elige otra hora.`) ni con **otra cita** no cancelada (**409** `Esa hora ya está ocupada. Por favor elige otra.`), y recién entonces se guardan el cliente y la cita. Así no se puede reservar sobre un bloqueo ni dos clientes pueden tomar la misma hora aunque lleguen a la vez. `citas_sin_solapamiento` sigue como última defensa (mismo 409). *Por qué antes se podía:* la revisión del bloqueo se hacía fuera de la transacción, así que un bloqueo creado entre la revisión y el guardado no se veía.

Además de las reglas de siempre (lista negra, bloqueos, choque con otra cita), una reserva debe cumplir:

- **Fecha**: desde hoy hasta 14 días después (15 días en total contando hoy), en hora de Colombia (`America/Bogota`). Errores **400** `No se pueden agendar citas en fechas pasadas` o `Solo puedes reservar desde hoy hasta 14 días después (hasta el 2026-11-02).` (con la fecha límite real).
- **Horario de ese día** (el `horario` del negocio): **400** `El negocio no atiende ese día. Por favor elige otra fecha.` si ese día está cerrado, o `La hora elegida está fuera del horario del negocio` si la cita empieza antes de la apertura o termina después del cierre de ese día.

#### Cartera

**GET `/api/v1/cartera?desde=2026-10-01&hasta=2026-10-31&barberoId=`** (personal). Un admin ve todo el negocio, o un integrante con `barberoId` (también el suyo, si es integrante del equipo). Un empleado ve solo lo suyo (su `barberoId` se ignora si envía otro). La respuesta trae `barberoId` (el filtro aplicado; `null` = todo el negocio). Suma las citas **completadas** con fecha entre `desde` y `hasta` (incluidas). La ganancia de cada cita usa el porcentaje que tenía el profesional **cuando se completó** (se guarda en `citas.porcentaje_ganancia`, migración 006); cambiar después su porcentaje no cambia lo que ya ganó. El negocio se queda con el resto. En `porProfesional`, `porcentajeGanancia` es el porcentaje **actual** del profesional (informativo); `ganancia` puede no coincidir con `ventas × porcentajeGanancia` si el porcentaje cambió dentro del rango. Las citas completadas antes de la migración 006 tomaron el porcentaje que el profesional tenía ese día.

```json
{
  "desde": "2026-10-01", "hasta": "2026-10-31", "barberoId": null,
  "totalCitas": 42, "totalVentas": 1050000, "gananciaEquipo": 525000, "gananciaNegocio": 525000,
  "porProfesional": [
    { "barberoId": "…", "nombre": "Carlos", "activo": true, "porcentajeGanancia": 50,
      "citas": 20, "ventas": 500000, "ganancia": 250000 }
  ]
}
```

Errores: **400** `El campo "desde" es obligatorio`, `El campo "desde" debe ser una fecha real con el formato AAAA-MM-DD`, `La fecha "hasta" no puede ser anterior a "desde"`, `El rango no puede ser mayor que 366 días` o `Identificador de profesional inválido`.

**GET `/api/v1/cartera/resumen?periodo=mes`** (personal, suscripción vigente): resumen de un período. Mismas reglas de acceso que `/cartera` (un admin ve todo el negocio o un integrante con `barberoId`; un empleado solo lo suyo).

- `periodo` (obligatorio): `hoy`; `semana` (de lunes a domingo de esta semana); `mes` (del día 1 al último día de este mes); o `rango` con `desde` y `hasta` (AAAA-MM-DD, máximo 366 días). Fechas de Colombia. Con `rango`, `desde` no puede ser anterior al registro del negocio (`fechaRegistro` de `/admin/empresa/suscripcion`) y `hasta` no puede ser posterior a hoy.
- Responde **200**, con los profesionales de mayor a menor en ventas:

  ```json
  {
    "periodo": "mes", "desde": "2026-10-01", "hasta": "2026-10-31", "barberoId": null,
    "totalVentas": 60000, "gananciaNegocio": 32000, "citasCompletadas": 3,
    "porProfesional": [
      { "barberoId": "…", "nombre": "Carlos", "activo": true, "citas": 2, "ventas": 40000, "ganancia": 20000 },
      { "barberoId": "…", "nombre": "Luis", "activo": true, "citas": 1, "ventas": 20000, "ganancia": 8000 }
    ]
  }
  ```

  `ganancia` es lo que ganó el profesional (con el porcentaje guardado en cada cita, igual que `/cartera`); `gananciaNegocio` = `totalVentas` − lo que ganó el equipo.
- Además de lo anterior (que no cambia), la respuesta trae estos campos, calculados con el mismo filtro (un admin ve todo el negocio o un integrante con `barberoId`; un **empleado solo lo suyo**, aunque envíe otro `barberoId`) y las mismas fechas de Colombia y límites de `rango`:

  ```jsonc
  {
    "ticketPromedio": 20000,                // totalVentas / citasCompletadas (0 si no hubo citas)
    "comparacion": {
      "tipo": "anterior",                     // con qué se comparó (ver "Con qué comparar")
      "aviso": null,                          // texto si el rango de comparación quedó antes del registro; si no, null
      "periodoAnterior": { "desde": "2026-09-01", "hasta": "2026-09-30", "totalVentas": 50000, "gananciaNegocio": 25000, "gananciaEquipo": 25000, "citasCompletadas": 2 },  // el período con el que se compara, sea cual sea el tipo
      "variacionPorcentaje": { "ventas": 20, "gananciaNegocio": 28, "gananciaEquipo": 12, "citas": 50 }  // % de subida (+) o bajada (−), un decimal
    },
    "ventasPorDia": [{ "fecha": "2026-10-01", "ventas": 0, "citas": 0 }, …],   // todos los días del período, con ceros
    "serviciosMasVendidos": [{ "servicioId": "…", "nombre": "Corte", "cantidad": 12, "ventas": 300000 }],  // hasta 10, por cantidad
    "ocupacion": {
      "diasSemana": [{ "dia": 0, "citas": 0 }, …],      // los 7 días (0 = domingo … 6 = sábado)
      "horas": [{ "hora": "10:00", "citas": 3 }, …],    // solo las horas con citas, en orden
      "diaMasOcupado": 2, "horaMasOcupada": "10:00"     // null si no hubo citas
    },
    "cancelaciones": { "totalCitas": 6, "canceladas": 3, "tasaPorcentaje": 50 },
    "clientes": { "nuevos": 2, "recurrentes": 1 },
    "pagoProfesionales": { "total": 12500, "detalle": [{ "barberoId": "…", "nombre": "Carlos", "activo": true, "porcentajeGanancia": 50, "citas": 1, "ventas": 25000, "aPagar": 12500 }] }
  }
  ```

  - **Período anterior**: completo y de la misma forma: `hoy` → ayer; `semana` → la semana pasada (lunes a domingo); `mes` → el mes anterior completo; `rango` → los mismos días justo antes de `desde`. Puede quedar antes del registro del negocio (llega en ceros). Si el período actual aún no termina (hoy, esta semana, este mes), se compara contra el anterior completo.
  - **Con qué comparar** (`comparar`, opcional, por defecto `anterior`): `anterior` (lo de arriba, sin cambios); `mes_pasado` (el mismo rango un mes antes; si el día no existe, el último del mes: 31 de marzo → 28 de febrero); `anio_pasado` (el mismo rango un año antes); `personalizado` (con `compararDesde` y `compararHasta`, AAAA-MM-DD, máximo 366 días; el rango puede tener otra duración que el período actual). Ejemplo: `/cartera/resumen?periodo=mes&comparar=anio_pasado`. `compararDesde` y `compararHasta` se ignoran en los otros tipos. El resultado siempre va en `comparacion.periodoAnterior` (con sus fechas reales) y `comparacion.tipo` dice cuál se usó.
  - **Antes del registro**: con `mes_pasado`, `anio_pasado` o `personalizado`, si el rango de comparación empieza antes del registro del negocio (`fechaRegistro`), `periodoAnterior` llega con sus fechas pero en ceros (`totalVentas`, `gananciaNegocio`, `gananciaEquipo` y `citasCompletadas` en 0) y `comparacion.aviso` trae el texto (`El período de comparación (2025-10-01 a 2025-10-31) empieza antes del registro del negocio (2026-10-05); se muestra en ceros.`). La variación contra cero sigue la regla de abajo. Con `anterior` no cambia nada: se calcula como siempre.
  - **Variación**: `(actual − anterior) / anterior × 100`, un decimal; negativa = bajó. Si el anterior es 0: `0` si ahora tampoco hay, y `null` si ahora sí hay (no se puede calcular un porcentaje).
  - `ventasPorDia`, `serviciosMasVendidos`, `ticketPromedio` y `pagoProfesionales` cuentan solo citas **completadas**. `aPagar` = lo que le corresponde al profesional con el porcentaje guardado en cada cita (igual que `ganancia`); `porcentajeGanancia` es el actual, informativo. `total` = lo que corresponde pagar a todo el equipo.
  - `ocupacion` cuenta las citas **no canceladas** del período (completadas y confirmadas, también las futuras) por día de la semana y por hora de inicio.
  - `cancelaciones` cuenta todas las citas del período, de cualquier estado; `tasaPorcentaje` = canceladas / totalCitas (las confirmadas que aún no llegan también cuentan en el total).
  - `clientes`: clientes con alguna cita no cancelada en el período. **Nuevos**: no tenían citas no canceladas antes de `desde`; **recurrentes**: sí. Con un profesional filtrado (o un empleado), se miran solo las citas de ese profesional.
- Errores: **400** `Elige el período en "periodo": "hoy", "semana", "mes" o "rango" (con "desde" y "hasta")`, y con `rango` los mismos de `/cartera` (`El campo "desde" es obligatorio`, …), `La fecha "desde" no puede ser anterior a la fecha de registro del negocio (2026-10-05).` y `La fecha "hasta" no puede ser posterior a hoy (2026-10-20).` Por `comparar`: `Elige con qué comparar en "comparar": "anterior", "mes_pasado", "anio_pasado" o "personalizado" (con "compararDesde" y "compararHasta")`, `Envía "compararDesde" y "compararHasta" para comparar con un rango personalizado`, `El campo "compararDesde" debe ser una fecha real con el formato AAAA-MM-DD`, `La fecha "compararHasta" no puede ser anterior a "compararDesde"` y `El rango de comparación no puede ser mayor que 366 días`.

### Recuperar contraseña (administradoras y clientes con correo)

Para cuentas de la tabla `usuarios` con correo (administradoras y clientes). El personal (barberos) no se recupera aquí: la administradora le cambia la contraseña en `PATCH /equipo/:id`.

**POST `/api/v1/cuentas/solicitar-recuperacion`**: recibe `{ "correo": "ana@central.co" }`.

- Responde **siempre** **200** `{ "mensaje": "Si el correo pertenece a una cuenta, te enviamos un código de 6 dígitos para restablecer tu contraseña. Vence en 15 minutos." }`, exista o no la cuenta.
- Si existe, genera un código de 6 dígitos al azar que **vence en 15 minutos** y sirve **una sola vez**. Se guarda solo su HMAC-SHA256 (con `JWT_SECRET`), nunca el código. Pedir otro código anula el anterior.
- Errores: **400** `El correo no es válido` o `Envía el correo de tu cuenta`; **429** `Ya pediste varios códigos para este correo. Espera unos minutos antes de pedir otro.` (3 por correo cada 15 minutos) o `Demasiados intentos para recuperar la contraseña. Intenta de nuevo en unos minutos.` (10 por conexión cada 15 minutos, sumando los de restablecer).

**POST `/api/v1/cuentas/restablecer-contrasena`**: recibe `{ "correo", "codigo": "123456", "clave": "nueva-clave-123" }` (contraseña de 8 a 64 caracteres, igual que en el registro).

- Responde **200** `{ "mensaje": "Tu contraseña se cambió. Inicia sesión con tu nueva contraseña." }` y **cierra todas las sesiones abiertas** de esa cuenta (los tokens anteriores responden 401). La app debe pedir iniciar sesión de nuevo.
- Tras **5 intentos fallidos** el código queda bloqueado y hay que pedir otro.
- Errores: **400** `El código debe tener 6 dígitos`, `La contraseña debe tener entre 8 y 64 caracteres e incluir una mayúscula, una minúscula, un número y un carácter especial`, `El correo no es válido` y, para cualquier otro fallo (cuenta inexistente, código errado, vencido, ya usado o bloqueado), siempre el mismo: `El código no es válido, ya venció o se bloqueó por demasiados intentos. Solicita uno nuevo.`; **429** (mismo límite por conexión).

**Envío del correo** (`src/shared/correo.ts`): interfaz `EnviadorCorreo` con un solo método, `enviar({ para, asunto, texto })`. `crearApp` puede recibir otro enviador en sus dependencias.

- **En desarrollo (y en las pruebas) no se envía nada**: el correo, con el código, se imprime en la consola del backend (la terminal de `npm run dev`).
- **Con `NODE_ENV=production` todavía no hay proveedor**: no se envía ni se muestra el código; solo queda el evento `correo_sin_proveedor` en el log. La recuperación no funciona en producción hasta conectar uno.
- Para un proveedor real: otra implementación de `EnviadorCorreo` en `crearEnviadorCorreo`, y estas variables en `.env` (validadas en `src/config/entorno.ts`):
  - `CORREO_REMITENTE`: quien envía, ej. `"Agendamiento <no-responder@mibarberia.co>"` (dominio verificado en el proveedor).
  - Con una API (Resend, SendGrid, Brevo…): `CORREO_PROVEEDOR` (ej. `resend`) y `CORREO_API_KEY`.
  - O con SMTP: `SMTP_HOST`, `SMTP_PORT` (587 o 465), `SMTP_USUARIO`, `SMTP_CLAVE` y `SMTP_SEGURO` (`true` con el puerto 465).

### PQRS (peticiones, quejas, reclamos y sugerencias)

**POST `/api/v1/pqrs`**: público, límite por IP (10 cada 15 minutos). Sirve como invitado o con el token de una cuenta (administradora o cliente); un token vencido o inválido no falla: se radica como invitado.

- Recibe `{ "tipo": "queja", "mensaje": "La app se cierra", "nombre": "Ana", "contacto": "ana@x.co" }`: `tipo` = `peticion` | `queja` | `reclamo` | `sugerencia`; `mensaje` hasta 2000 caracteres; `nombre` hasta 100 y `contacto` (correo o teléfono, texto libre) hasta 150. Con sesión, `nombre` y `contacto` son opcionales: se toman de la cuenta (nombre; correo o, si no, teléfono). Como invitado son obligatorios.
- Responde **201** `{ "mensaje": "Recibimos tu queja. Guarda tu número de radicado: PQRS-2026-000001.", "pqrs": { "radicado", "tipo", "mensaje", "estado": "recibida", "respuesta": null, "respondidaEn": null, "creadaEn" } }`.
- Errores: **400** `El tipo debe ser "peticion", "queja", "reclamo" o "sugerencia"`, `El campo "mensaje" es obligatorio`, `El campo "nombre" es obligatorio`, `El campo "contacto" es obligatorio`, `Envía el tipo y el mensaje de tu PQRS`; **429** `Enviaste varias PQRS seguidas. Intenta de nuevo en unos minutos.`
- Estados: `recibida` → `en_proceso` → `resuelta` → `cerrada`. Los cambia el equipo de soporte con `npm run dev:pqrs` (ver "Comandos de desarrollador"), con una respuesta de texto.

**GET `/api/v1/pqrs/mias`**: cuenta (administradora o cliente; **401** sin sesión). **200** las que radicó con su sesión, de la más reciente a la más antigua, con la misma forma de `pqrs` de arriba. Las de invitado no aparecen: se consultan con el radicado que recibió.

### Panel del superadministrador (dueño de la plataforma)

Rol aparte de `admin` y `cliente`: vive en la tabla `superadmins`, no en `usuarios`. **No se puede crear desde la app ni con el registro**: solo con `npm run dev:crear-superadmin` (ver "Comandos de desarrollador"). Ningún otro login (`/login`, `/cuentas/login`, `/auth/login`, recuperar contraseña) llega a esa cuenta.

**POST `/api/v1/superadmin/login`**: recibe `{ "correo", "clave", "codigo" }` (`codigo` = 6 dígitos de la app autenticadora, TOTP RFC 6238: SHA-1, 30 s, se acepta un paso antes y uno después).

- Responde **200** `{ "mensaje": "Autenticación exitosa", "token": "<jwt>", "expiraEnSegundos": 3600, "inactividadMinutos": 15, "superadmin": { "id", "correo" } }`. El token es de otro tipo (`tipo: "superadmin"`): solo sirve en `/api/v1/superadmin/...` y los demás endpoints lo rechazan (y al revés). Dura **1 hora** fija (no usa `JWT_EXPIRA_EN`). Se envía como `Authorization: Bearer <token>`. Las respuestas del panel llevan `Cache-Control: no-store`.
- Seguridad: cada código sirve **una sola vez** (se guarda el último paso usado); la clave del segundo paso se guarda **cifrada** (AES-256-GCM, llave derivada de `JWT_SECRET`: si cambias `JWT_SECRET`, reinicia el segundo paso con `--reiniciar`); la contraseña se compara siempre con bcrypt aunque el correo no exista; límite por IP (los intentos fallidos de `limitadores.login`) y bloqueo de la cuenta 15 minutos tras 5 fallos seguidos. `--reiniciar` sube `version_sesion` y cierra las sesiones abiertas.
- Errores: **400** `Debes enviar tu correo, tu contraseña y el código de tu app autenticadora` o `El código de la app autenticadora debe tener 6 dígitos`; **401** `Correo, contraseña o código incorrectos` (igual si falla cualquiera de los tres) o `Ese código ya se usó. Espera el siguiente código de tu app autenticadora.`; **429** `Demasiados intentos fallidos. Espera 15 minutos para volver a intentar.` o el límite por IP.
- Los demás endpoints responden **401** `Sesión no válida. Inicia sesión de nuevo.` (sin token), `Sesión vencida o no válida. Inicia sesión de nuevo.` o `Sesión cerrada por 15 minutos sin actividad. Inicia sesión de nuevo.`
- **Cierre automático por inactividad**: cada solicitud autenticada guarda `superadmins.ultima_actividad`. Si pasan **15 minutos sin ninguna**, el token deja de servir (el 401 de arriba) aunque no haya vencido su hora; hay que iniciar sesión otra vez. Lo decide el servidor, así que la app solo debe llevar al login al recibir ese 401 (`inactividadMinutos` del login sirve para mostrar un aviso).
- **POST `/api/v1/superadmin/logout`** (sin cuerpo): cierra la sesión **en el servidor**: sube `version_sesion` y borra `ultima_actividad`, así este token y cualquier otro anterior de esa cuenta dejan de servir (401 `Sesión no válida…`), aunque no hayan vencido. Responde **200** `{ "mensaje": "Sesión cerrada" }` y queda como acción `cerrar_sesion` en el registro de actividad. La app debe borrar el token al llamarlo.

Las listas se paginan con `?pagina=1&limite=25` (máximo 100) y responden `{ "total", "pagina", "limite", "datos": [...] }`.

**Estado de un negocio** (se calcula hoy, hora de Colombia, igual que `buscarSuscripcion`): `suspendido` (manda sobre los demás); `prueba` o `activo` mientras no pase su fecha de fin; `vencido` en otro caso (incluye los cancelados). Un negocio activo sin fecha de fin (anterior a los planes) no vence.

**GET `/superadmin/resumen`**: **200** `{ "totalNegocios", "enPrueba", "activos", "vencidos", "suspendidos", "nuevosEsteMes", "porVencerEn7Dias", "citasHoy" }`. `enPrueba + activos + vencidos + suspendidos = totalNegocios`. `porVencerEn7Dias` = en prueba o activos con 7 días o menos. `citasHoy` = citas de hoy de todos los negocios, sin contar las canceladas.

**GET `/superadmin/negocios?buscar=&estado=&pagina=&limite=`**: `buscar` busca en el nombre o el código (sin distinguir mayúsculas); `estado` = `prueba` | `activo` | `vencido` | `suspendido` | `por_vencer` (en prueba o activos con ≤ 7 días). Del más reciente al más antiguo. Cada negocio: `{ "id", "nombre", "codigoAcceso", "planEquipo": { "id", "nombre", "cupo" }, "plan": "mensual" | "anual" | null, "estado", "diasRestantes", "cupoUsado", "municipio", "departamento", "fechaRegistro" }` (`diasRestantes`: `null` si no tiene fecha de fin, nunca negativo). **400** `El estado debe ser uno de: …`.

**GET `/superadmin/negocios/:id`**: lo de la lista más `categoria`, `direccion`, `administradora: { nombre, correo }`, `suscripcion: { estadoGuardado, fechaPago, fechaFin, finDePrueba, diasPruebaSumados }`, `suspension: { desde, motivo } | null`, `equipo: { activos, cupo, administradores, empleados }`, `cifras: { clientes, servicios, productos, citas: { total, confirmadas, completadas, canceladas, esteMes, ultima }, ventas: { total, esteMes } }` y `actividadReciente` (las últimas 10 acciones del superadmin sobre ese negocio). **Solo cifras**: nunca nombres, teléfonos ni otros datos de los clientes del negocio. **404** `Negocio no encontrado`.

**GET `/superadmin/estadisticas`**: cifras agregadas para dibujar gráficos. **Solo conteos y totales de la plataforma: nada de nombres, teléfonos ni otros datos de clientes** (los negocios que vencen sí traen su nombre y código, que son del negocio). Las listas vienen completas (con ceros) para graficar sin rellenar huecos. Responde **200**:

```jsonc
{
  "negociosNuevosPorMes": [{ "mes": "2025-11", "total": 0 }, …],        // últimos 12 meses, el actual al final (por fecha de registro)
  "negociosPorEstado": [{ "estado": "prueba" | "activo" | "vencido" | "suspendido", "total": 3 }, …],  // los 4, aunque sean 0
  "negociosPorPlan": [{ "plan": "basico", "nombre": "Básico", "total": 5, "activos": 2 }, …],         // los 3 planes; "activos" = estado activo
  "citasPorDia": [{ "dia": "2026-09-21", "total": 12 }, …],             // últimos 30 días hasta hoy (hora de Colombia), sin las canceladas
  "topDepartamentos": [{ "departamento": "SANTANDER", "total": 4 }, …], // hasta 5, más negocios primero
  "conversionPruebaAPlan": { "pruebasTerminadas": 20, "convertidos": 8, "tasaPorcentaje": 40 },
  "vencenEn7Dias": { "total": 2, "negocios": [{ "id", "nombre", "codigoAcceso", "estado", "diasRestantes", "fechaFin" }] },  // prueba o activos, hasta 50
  "ingresoMensualEstimado": { "estimado": true, "moneda": "COP", "total": 160000, "detalle": [{ "plan": "equipo", "periodo": "anual", "negocios": 2, "ingreso": 83333 }], "nota": "…" }
}
```

- `conversionPruebaAPlan`: de los negocios que **ya pagaron o cuya prueba ya terminó** (`pruebasTerminadas`; uno que sigue en su prueba aún no pudo convertirse), cuántos pagaron o están activos (`convertidos`). `tasaPorcentaje` con un decimal; `null` si aún no hay ninguno.
- `ingresoMensualEstimado`: **es una estimación, no dinero cobrado** (por eso `estimado: true`). Suma, por cada negocio en estado `activo`, el precio mensual de su plan o el anual dividido en 12, con los precios de `src/config/planes.ts` (hoy de ejemplo). No cuenta pruebas, vencidos ni suspendidos, ni activos de antes de los planes (sin periodo, no hay precio).

**GET `/superadmin/ingresos`**: ingresos **estimados** de la plataforma, sumando el precio del plan en cada activación del historial `activaciones_plan` (migración 020). **No son pagos reales** (todavía no hay pasarela): por eso la respuesta lleva `estimado: true`. Un plan anual cuenta completo en el mes en que se activa. Cada activación o renovación (panel o `dev:activar-plan`) suma una fila. Solo cifras: nada de datos de clientes. Responde **200**:

```jsonc
{
  "estimado": true, "moneda": "COP",
  "total": 530000, "activaciones": 2,                                  // todo el historial
  "porMes": [{ "mes": "2025-11", "total": 0, "activaciones": 0 }, …],  // últimos 12 meses, el actual al final, con ceros
  "porAnio": [{ "anio": 2026, "total": 530000, "activaciones": 2 }],   // desde el primer año con activaciones hasta el actual, sin huecos
  "mejorMes": { "mes": "2026-10", "total": 530000, "activaciones": 2 } | null,  // de todo el historial; null si no hay ingresos
  "mejorAnio": { "anio": 2026, "total": 530000, "activaciones": 2 } | null,     // con empate gana el más reciente
  "nota": "Estimado: …"
}
```

**Acciones sobre un negocio** (todas responden **200** `{ "mensaje", "negocio": { …forma de la lista… } }`, **404** `Negocio no encontrado`, y quedan en el registro de actividad; `motivo` opcional hasta 300 caracteres salvo donde se indica):

- **POST `/negocios/:id/plan`** `{ "periodo": "mensual" | "anual", "planEquipo"?: "basico" | "equipo" | "pro", "motivo"? }`: misma regla que `dev:activar-plan` (`activarPlanEmpresa`): queda `activa` hoy; la fecha de fin cuenta desde el fin de la prueba, el fin del plan vigente u hoy; sin `planEquipo` conserva el actual. **409** si el equipo activo no cabe en el plan (`Tu equipo tiene …`) o `Este negocio está cancelado (su cuenta fue eliminada) y no se puede activar.`; **400** `El periodo debe ser "mensual" o "anual"`.
- **POST `/negocios/:id/extender-prueba`** `{ "dias": 1-365, "motivo"? }`: alarga la prueba desde su fin (o desde hoy si ya había terminado). **409** `Este negocio no está en prueba gratuita. Para darle más tiempo, actívale un plan.`; **400** `Los días deben ser un número entero entre 1 y 365`.
- **POST `/negocios/:id/suspender`** `{ "motivo" }` y **POST `/negocios/:id/reactivar`** `{ "motivo" }`: el **motivo es obligatorio** (**400** `El campo "motivo" es obligatorio`). **409** `Este negocio ya está suspendido.` / `Este negocio no está suspendido.` Suspender no toca el plan ni las fechas; ver "Cuando la suscripción está vencida".

**PQRS**: **GET `/superadmin/pqrs?estado=&tipo=&pagina=&limite=`** (las sin resolver primero, de la más antigua a la más reciente) y **GET `/superadmin/pqrs/:radicado`** (sin distinguir mayúsculas; **404** `No existe una PQRS con ese radicado`). Forma: `{ "radicado", "tipo", "estado", "mensaje", "nombre", "contacto", "conCuenta", "respuesta", "respondidaEn", "creadaEn", "actualizadaEn" }`. **PATCH `/superadmin/pqrs/:radicado`** `{ "estado", "respuesta"? }` (respuesta hasta 2000; sin texto conserva la anterior): **200** `{ "mensaje": "PQRS actualizada", "pqrs": {…} }`. Es lo mismo que `dev:pqrs responder`.

**Registro de actividad**: **GET `/superadmin/actividad?accion=&empresaId=&desde=&hasta=&pagina=&limite=`** (`desde` y `hasta` AAAA-MM-DD, hora de Colombia), de la más reciente a la más antigua: `{ "id", "superadmin": "correo", "accion", "negocio": { "id", "codigoAcceso", "nombre" } | null, "referencia", "detalle", "motivo", "fecha" }`. Acciones: `inicio_sesion` (con la IP en `detalle`), `cerrar_sesion`, `activar_plan`, `extender_prueba`, `suspender`, `reactivar` y `responder_pqrs` (`referencia` = radicado). Las consultas no se registran. No hay endpoint para editarlo ni borrarlo, y la base rechaza `UPDATE`, `DELETE` y `TRUNCATE` (migración 016). El nombre y el código del negocio quedan copiados tal como estaban en ese momento.

### Eliminar la cuenta (Ley 1581 de 2012)

**POST `/api/v1/cuentas/eliminar`**: una administradora o un cliente con cuenta elimina su cuenta y sus datos personales. Requiere su sesión (`Authorization: Bearer <token>`) y confirmar con la contraseña. Los intentos con contraseña errónea cuentan en el límite de login.

- Recibe `{ "clave": "…", "eliminarNegocio": false }` (`eliminarNegocio` es opcional y solo importa para una administradora; ver abajo).
- Responde **200** `{ "mensaje": "Tu cuenta y tus datos personales fueron eliminados." }`. El token deja de servir de inmediato (401). Todo ocurre en una transacción.
- Errores: **400** `Envía tu contraseña para confirmar`; **401** `La contraseña no es correcta` o sesión no válida; **409** (solo administradora) `Eres la única persona que administra este negocio. Agrega primero a otro administrador en Equipo, o envía "eliminarNegocio": true para cerrar también el negocio.`; **429**.
- **Qué se borra**: la fila de la cuenta completa (correo, usuario, teléfono, nombre y contraseña) y con ella sus negocios guardados, códigos de recuperación y la prueba de autorizaciones de la cuenta.
- **Qué se conserva, sin datos personales**: las citas y la cartera (la cita deja de apuntar a la cuenta). En cada negocio, el registro del cliente con ese teléfono queda como `Cliente eliminado` con un teléfono de relleno único que no es un número. Las PQRS de la cuenta se conservan (son un registro de atención) con nombre y contacto `Cuenta eliminada`.
- **Qué se conserva a propósito**: la lista negra de cada negocio (nombre y teléfono; es un registro del negocio, y borrarla permitiría eludirla con una cuenta nueva) y la prueba de las autorizaciones dadas como invitado, que se guardan por teléfono (evidencia legal). El mensaje de una PQRS no se edita.
- **Administradora**: si el negocio tiene otra persona que lo administre (un integrante activo con rol Administrador u otra cuenta admin), solo se elimina su cuenta y el negocio sigue. Si es la única, responde 409 salvo que envíe `"eliminarNegocio": true`: entonces el negocio queda `cancelada` (nadie del equipo entra y no recibe reservas), el equipo queda inactivo, `nombre_administradora` pasa a `Cuenta eliminada`, los clientes del negocio se anonimizan y su lista negra se borra. Las citas y la cartera quedan guardadas. No se borran el negocio ni sus fotos del servidor.

### Teléfonos (formato E.164)

- Todos los teléfonos que recibe el backend (reservas `POST /citas` y cuentas de cliente `POST /cuentas/registro/cliente`) se validan y normalizan con **libphonenumber-js** (`src/shared/telefonos.ts`) y se guardan en **E.164** (`+573162781393`, máx. 16 caracteres). El equipo no tiene teléfono.
- Se acepta el número como lo escriba la persona: con espacios o guiones, con `+` y código de país (`+57 316 278 1393`), con el indicativo pegado (`573162781393`) o sin código de país; **sin código de país se usa `indicativo`, y si no llega, Colombia (57)**. El `indicativo` que se guarda y se devuelve es el del número.
- Inválido → **400** `El número de teléfono no es válido. Revisa el número y el indicativo del país (ej. 3001234567 para Colombia).`
- Unicidad: único **por negocio** en los clientes de cada empresa y **único global** entre las cuentas de cliente (**409** `Ya existe una cuenta con ese número de teléfono`). En las demás tablas no es único global.
- Los teléfonos guardados antes de la migración 011 que no se pudieron convertir siguen en la base con solo sus dígitos (no empiezan con `+`); ver la migración 011 en "Base de datos y entorno".

### Cuenta del cliente (`/api/v1/mi-cuenta`)

Solo con el token de una cuenta de cliente (`/api/v1/login` o `/cuentas/login`). Otro token responde **403** `Esta función es solo para clientes con cuenta.` (cuenta admin) o **401** (personal, sin token o vencido).

Forma de un negocio guardado: `{ "id", "nombre", "codigoAcceso", "categoria", "direccion", "departamento", "ciudad", "logoUrl", "fotoUrl", "recibiendoReservas": true, "guardadoEn": "<fecha ISO>" }`. Se guarda el negocio, no el código: si el negocio cambia su código, sigue en la lista con el nuevo.

- **GET `/mi-cuenta/negocios`**: **200** negocios guardados, del más reciente al más antiguo.
- **POST `/mi-cuenta/negocios`**: recibe `{ "codigo": "central10" }`. **201** `{ "mensaje": "Negocio guardado", "negocio": { … } }` (si ya estaba, responde igual). Errores: **400** `Envía el código del negocio en "codigo"` o el mensaje del código inválido; **404** `Establecimiento no encontrado`; **429** (mismo límite que `/empresas/validar/:codigo`).
- **DELETE `/mi-cuenta/negocios/:id`** (`:id` = `id` del negocio): **200** `{ "mensaje": "Negocio quitado de tu lista" }`. **404** `Ese negocio no está en tu lista`.
- **GET `/mi-cuenta/citas`**: **200** citas que reservó con su sesión, de la más reciente a la más antigua: `[{ "id", "empresaId", "negocio", "codigoAcceso", "servicio", "barberoId", "barberoNombre", "fecha": "2026-10-21", "hora": "10:00 AM", "duracionMin": 30, "precio": 25000, "estado": "CONFIRMADA" }]`. Las reservas como invitado no aparecen.
- **PATCH `/mi-cuenta/citas/:id/cancelar`**: el cliente cancela una cita **suya** (reservada con su sesión) que sigue `CONFIRMADA` y todavía no empezó (hora de Colombia). **200** `{ "mensaje": "Cita cancelada", "estado": "CANCELADA", "canceladaEn": "<fecha ISO>" }`. **409** `No se pudo cancelar: la cita no existe, no es tuya, ya fue atendida o cancelada, o ya empezó.`; **400** `Identificador de cita inválido`. No se llena `cancelada_por` (la agenda no muestra quién canceló). Avisa por push al profesional y a los administradores (ver "Notificaciones push").

### Notificaciones push (Expo Push)

Los avisos salen por **Expo Push** (`src/shared/push.ts`, interfaz `EnviadorPush`; `crearApp` puede recibir otro en `push`). En `NODE_ENV=test` no se envía nada. La app obtiene el token con `expo-notifications` (`ExponentPushToken[…]`).

**PUT `/api/v1/dispositivos`** (sesión del personal, de la administradora o de un cliente con cuenta): recibe `{ "token": "ExponentPushToken[xxxx]", "plataforma": "ios" | "android" | "web" }` (`plataforma` opcional). **200** `{ "mensaje": "Dispositivo registrado" }`. Se llama después de iniciar sesión y cuando Expo cambie el token. El dueño sale de la sesión. Un token es de una sola persona: si otra inicia sesión en ese celular y lo registra, pasa a ser suyo. Errores: **400** `Envía el token del dispositivo en "token"`, `El token del dispositivo no es válido`, `La plataforma debe ser "ios", "android" o "web"`; **401** sin sesión válida.

**DELETE `/api/v1/dispositivos`**: recibe `{ "token": "…" }` y borra ese token **solo si es de quien lo pide**. Se llama al cerrar sesión, antes de descartar el token de la sesión. **200** `{ "mensaje": "Dispositivo eliminado" }` (igual si no existía). Al eliminar una cuenta se borran sus tokens; un integrante eliminado del equipo deja de recibir avisos.

### Centro de notificaciones (dentro de la app)

Cada aviso de abajo, además de la push, se **guarda** en `notificaciones` para quien lo recibe (administradoras, integrantes del equipo y clientes con cuenta). Los endpoints sirven a cualquier sesión y cada quien ve solo las suyas (el dueño sale de la sesión; **401** sin sesión válida):

- **GET `/api/v1/notificaciones?soloNoLeidas=false&pagina=1&limite=25`** (límite máximo 100): **200** `{ "total", "noLeidas", "pagina", "limite", "datos": [{ "id", "tipo", "titulo", "texto", "citaId", "leida", "leidaEn", "creadaEn" }] }`, de la más reciente a la más antigua. `total` cuenta solo las no leídas si `soloNoLeidas=true`; `noLeidas` siempre es el total sin leer. `tipo` es el mismo `data.tipo` de la push; `citaId` es `null` si la cita se borró.
- **GET `/api/v1/notificaciones/no-leidas`**: **200** `{ "noLeidas": 3 }`.
- **PATCH `/api/v1/notificaciones/:id/leida`**: **200** con la notificación (si ya estaba leída conserva su fecha). **404** `Notificación no encontrada` (no existe o es de otra persona).
- **PATCH `/api/v1/notificaciones/leidas`**: marca todas como leídas. **200** `{ "mensaje": "Notificaciones marcadas como leídas", "marcadas": 2 }`.

Guardar la notificación y enviar la push son pasos independientes: sin token de dispositivo solo queda la notificación interna, y si cualquiera de los dos falla (`push_fallo` en el log) la reserva o la cancelación no se afectan.

**Qué se avisa y a quién** (`data.tipo` y `data.citaId` permiten a la app abrir la cita):

| Evento | Quién lo recibe | `data.tipo` |
| --- | --- | --- |
| Cita nueva (invitado o cliente con cuenta) | El profesional de la cita y los administradores del negocio (integrantes con rol Administrador y cuentas admin) | `cita_nueva` |
| El cliente cancela su cita (`PATCH /mi-cuenta/citas/:id/cancelar`) | El profesional y los administradores | `cita_cancelada_por_cliente` |
| El negocio cancela (`PATCH /citas/:id/cancelar`) | El cliente, solo si reservó con su cuenta | `cita_cancelada` |
| Recordatorio de 24 h | El cliente con cuenta | `recordatorio` |

- **Un fallo de envío nunca afecta la reserva ni la cancelación**: el aviso se dispara después de guardar y sin esperarlo, y cualquier error solo queda en el log (`push_fallo`, `push_expo_fallo`). Quien no tenga tokens registrados no recibe la push (la notificación interna sí queda).
- **Tokens inválidos**: si Expo responde `DeviceNotRegistered`, el token se borra de `dispositivos_push`. No se consultan los recibos de Expo (solo la respuesta inmediata).
- **Recordatorios** (`modules/notificaciones/recordatorios.ts`): una tarea que arranca `server.ts` (no `crearApp`, así las pruebas no la inician) y corre al arrancar y luego **cada 15 minutos**. Recuerda las citas `CONFIRMADA` de clientes con cuenta que empiezan dentro de **23 a 24 horas** (hora de Colombia). Una cita reservada con menos de 24 h de anticipación no recibe recordatorio. Cada cita se marca en `citas.recordatorio_enviado_en` en el mismo paso en que se elige (con bloqueo de filas), así que **no se envía dos veces** aunque haya varias instancias o dos vueltas se crucen; si el envío falla, ese recordatorio no se reintenta. Los invitados no reciben recordatorio (no tienen dispositivo).

### Autorización de tratamiento de datos (Ley 1581 de 2012)

- El registro de empresa, el registro de cliente y la reserva como invitado exigen `"aceptaPoliticaDatos": true` y `"aceptaTerminos": true`; si no, **400** `Debes aceptar la Política de Tratamiento de Datos y los Términos y Condiciones`. Un cliente con cuenta solo acepta de nuevo cuando se publica una versión nueva (ver "Reservas").
- La app muestra los textos vigentes con **GET `/api/v1/legal/politica-datos`**, **GET `/api/v1/legal/terminos`** y **GET `/api/v1/legal/aviso-privacidad`** (públicos; el aviso es el texto corto que va junto a la casilla): **200** `{ "tipo": "politica_datos" | "terminos" | "aviso_privacidad", "version": "1.0", "titulo", "contenido": "<markdown>", "publicadoEn": "<fecha ISO>" }`. La casilla sigue siendo una sola: política y términos (el aviso no guarda versión aceptada).
- **Los textos actuales son la versión 1.0 (migración 017), todavía un BORRADOR de `docs/legal/documentos-legales.md` sin revisión legal.** Conservan espacios por llenar: `[NOMBRE DEL RESPONSABLE]`, `[IDENTIFICACIÓN]`, `[DOMICILIO]`, `[DIRECCIÓN FÍSICA]`, `[CORREO DE CONTACTO]`, `[TELÉFONO]`, `[PROVEEDOR Y PAÍS DEL SERVIDOR]` y `[FECHA DE ENTRADA EN VIGENCIA]`. Antes de publicar la app con usuarios reales, que un abogado los revise y se publique una versión nueva (p. ej. 1.1) con esos datos completos.
- Prueba de cada autorización en `autorizaciones_datos`: `origen` (`registro_empresa`, `registro_cliente` o `reserva`), quién (`usuario_id`, o `telefono` + `indicativo` si es invitado), `empresa_id` y `cita_id` cuando aplica, `aceptado_en` (fecha y hora) y `version_politica` / `version_terminos` aceptadas. Se acepta siempre la política y los términos juntos. Se borra con la cuenta o el negocio al que pertenece.

## Autenticación y roles

- Personal: login con `usuario` + `clave` contra `barberos` activos (bcrypt, costo 12). El token lleva `sub` (id del barbero) y `empresaId`. `requerirSesion` **lee `es_admin` de la base en cada solicitud**, así que un cambio de rol aplica de inmediato; `requerirAdmin` exige admin. Un barbero eliminado (`activo = false`) pierde la sesión. Rol en la API: `es_admin` true = `"admin"`, false = `"empleado"`.
- `requerirSesion` también acepta el token de una cuenta `admin`: la sesión queda con `usuarioId`, `barberoId: null`, la empresa de la cuenta y `esAdmin: true` (`src/modules/auth/auth.servicio.ts`). Si la cuenta completó o canceló una cita, queda en `citas.completada_por_usuario` / `cancelada_por_usuario` (migración 005). `crearPermisos` (`src/modules/auth/permisos.ts`) arma las guardias `personal` y `admin` de los módulos de gestión; ambas exigen suscripción vigente.
- Login único (`POST /api/v1/login`, `src/modules/auth/acceso.ts`): con `@` busca la cuenta (admin o cliente) por correo; sin `@`, primero la cuenta por `usuarios.usuario` y si no existe, el personal por `barberos.usuario`. Firma el mismo token que el login de antes de cada tipo, así que las guardias no cambian. Hace siempre una comparación bcrypt, para que el tiempo no revele qué correos o usuarios existen.
- Usuario de la administradora (`usuarios.usuario`, migración 007): obligatorio para `rol = admin`, `null` en clientes, único sin distinguir mayúsculas. El trigger `verificar_usuario_login_unico` (corregido en la 008) impide que coincida con un barbero activo y al revés. A las administradoras que ya existían se les creó a partir de su correo (lo que va antes de la @; si se repetía, con un número al final).
- Cuentas: login con `correo` + `clave` contra `usuarios` (bcrypt, costo 12). El token lleva `sub` (id del usuario), `tipo: "cuenta"` y `ver` (la `version_sesion` de la cuenta al firmarlo; los tokens de antes de la migración 013 cuentan como 0). Las guardias responden 401 a un token cuya versión ya no coincide: así, cambiar la contraseña cierra todas las sesiones abiertas. `requerirCuenta` **lee `rol` y `empresa_id` de la base en cada solicitud**; `requerirAdminEmpresa` exige `rol = admin` con empresa (`src/modules/cuentas/cuentas.guardias.ts`).
- Los tokens son JWT HS256 y duran `JWT_EXPIRA_EN`.
- Superadmin (`src/modules/superadmin/`): tabla `superadmins`, token propio (`tipo: "superadmin"`, 1 hora, con `ver` = `version_sesion`) que las demás guardias rechazan. La guardia lee la cuenta de la base en cada solicitud. Detalle en "Panel del superadministrador".
- Cuentas de cliente: `rol = cliente`, sin empresa, con `nombre`, `telefono`, `indicativo` y correo o usuario (los dos opcionales, al menos uno). `cuentas.clienteDeToken` reconoce su token en `POST /citas`; `requerirCuenta` + `requerirCliente` protegen `/mi-cuenta`.
- Suscripción (`src/modules/empresas/suscripcion.ts`, `buscarSuscripcion` en `empresas.repositorio.ts`): el estado se **calcula** en cada consulta con la fecha de Colombia, sin tareas programadas. Fin = día de `trial_ends_at` (prueba) o `suscripcion_fin` (plan); habilitada si el estado guardado es `trial` o `activa` y el fin es posterior a hoy (o `activa` sin fin, empresas de antes de los planes, que quedaron `activa`). `requerirSuscripcionVigente` va después de la guardia de sesión en los endpoints de gestión, agenda y citas, y responde 402 (mensaje de negocio inactivo a los empleados). Mi negocio y `/suscripcion` no la llevan.

## Reglas de seguridad (auditoría previa)

- Negocio, usuario y rol salen **de la sesión**, nunca del cuerpo ni de la URL.
- Toda entrada se valida con zod en la capa de rutas (`parsear`); el cuerpo JSON tiene un límite de 10 kb.
- SQL siempre parametrizado (`$1`, `$2`…). Nunca concatenes valores del usuario.
- Las consultas usan listas explícitas de columnas: nada de `SELECT *`, para no filtrar `password_hash`, datos de clientes ni columnas nuevas.
- Errores siempre como `{ "error": "mensaje" }`, sin pila ni SQL; el detalle queda solo en el log del servidor (`shared/http/manejadorErrores.ts`).
- Integridad en la base: llaves foráneas compuestas `(empresa_id, …)` aíslan negocios; `citas_sin_solapamiento` impide dobles reservas (la API responde 409); CHECK en estados, horarios y precios.
- Límites por IP (login, código de negocio, reservas, registro, recuperar contraseña, general) y por correo (pedir códigos de recuperación), `helmet` y CORS con lista de orígenes.
- Prueba cada regla nueva con un test de integración en `test/`.
