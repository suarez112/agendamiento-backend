# Auditoría – tanda 3 (hallazgos A-2, M-1, M-2, M-4, M-5, M-6, M-8, B-1 a B-7, B-9 a B-11 y pendientes)
- Rama: `auditoria` · Estrategia de entrega: ask-on-risk (rebanadas en commits convencionales en la misma rama; push al final) · Pruebas: `npm test` (node:test) y `npm run typecheck`
- Fuente: `docs/auditoria/informe-backend.md`. Solo backend. El servidor de desarrollo ya está encendido: no se inicia ni se apaga.

## Specs
- S1 (A-2) Máximo de citas pendientes por teléfono en cada negocio (invitados y clientes con cuenta), el número en configuración. Mensaje exacto: "Ya tienes 3 citas pendientes en este negocio. Cancela una o espera a que se complete para reservar otra." Además, límite de reservas por conexión. Sin verificación por SMS ni WhatsApp.
- S2 (M-1) Límites de intentos separados por ruta, y un contador por cuenta guardado en la base de datos (no solo en memoria ni solo por IP).
- S3 (M-2) TRUST_PROXY con un valor seguro por defecto (no confiar en encabezados de proxy salvo que se configure). Documentar qué valor usar según el hosting.
- S4 (M-4) version_sesion también para el personal (barberos) y endpoint POST /logout que invalide la sesión en el servidor. Al cambiar la contraseña se cierran las demás sesiones. Los refresh tokens se dejan para cuando publiquemos.
- S5 (M-5) El bloqueo del superadmin por intentos fallidos debe ser por cuenta + IP, con mensaje genérico, para que nadie pueda bloquearlo desde fuera.
- S6 (M-8) CORS debe permitir PUT y DELETE.
- S7 (B-10 + tanda 1) Agregar el filtro de negocio (AND empresa_id) en los tres UPDATE señalados; GET /cartera?barberoId= con un profesional de otro negocio responde 404; resolver las otras observaciones de "Seguimiento – tanda 1" (T1-2, T1-3, T1-4).
- S8 (M-6) Eliminar cuenta anonimiza al equipo, borra sus fotos y limpia sus notificaciones, conservando citas y cartera sin datos personales.
- S9 (B-1) Mensajes genéricos que no revelen si un correo, usuario o teléfono ya existe (en registro y login): "No pudimos crear la cuenta con esos datos. Si ya tienes una, inicia sesión o recupera tu contraseña."
- S10 (B-2) El límite de registros no cuenta los intentos con errores de validación.
- S11 (B-3) Cancelar una cita inexistente responde 404 (la existencia se revisa antes que la suscripción).
- S12 (B-4) Secretos separados para sesiones, códigos de recuperación y 2FA. Preparar el código para leer tres variables, DETENERSE y explicar cómo generarlas y qué líneas agregar; continuar al confirmar el usuario. Explicar si los usuarios con 2FA deberán configurarlo de nuevo.
- S13 (B-5) Notificaciones push sin el nombre del cliente en el texto, y tokens que vencen si no se usan.
- S14 (B-6) Todos los comandos dev:* quedan registrados en la actividad del superadmin; los peligrosos se niegan en producción salvo activar-plan (que pide confirmación).
- S15 (B-7) Limpiar los mensajes de error de la base de datos antes de mostrarlos y registrar los inicios de sesión fallidos (sin contraseñas).
- S16 (B-9) Corregir el aviso de npm audit de uuid con overrides (NO usar npm audit fix --force).
- S17 (B-11) Crear .env.example sin valores reales y eliminar /api/saludo si no se usa (el frontend en `C:\Users\eduar_9\app` no lo usa).
- S18 Prueba propia para db:cifrar-contrasenas; configuracionPruebas.ts recorta espacios al leer credenciales (un valor como " " no cuenta como definido); revisar la otra sugerencia de esa línea.
- Fuera de alcance (para cuando se publique): M-7 (correo real), B-8 (URL_PUBLICA), HTTPS y el valor final de TRUST_PROXY.

## Tasks
| ID | Specs | Ruta | Estado | Commit |
| --- | --- | --- | --- | --- |
| T1 | S6, S7, S11, S17(saludo), S10 | inline | hecho | d0c67f7, edd7dab, b4cc31e |
| T2 | S2, S5, S15(login fallido) | inline | hecho | 52bc3e0 |
| T3 | S4, S3 | inline | hecho | 76b56cc, 19b2143 |
| T4 | S1, S9 | inline | hecho | edd7dab, b4cc31e |
| T5 | S8, S13 | inline | hecho | 0a89c50 |
| T6 | S12 | inline | hecho (secretos obligatorios; el 2FA del superadmin de desarrollo no se pudo re-cifrar, ver el informe) | 3dcfede |
| T7 | S14, S15, S16, S17, S18, informe | inline | hecho; .env.example bloqueado por permisos: contenido en docs/despliegue/env-ejemplo.txt | a7d6e47, 77591cb, 56dc920, f87087e, 5a4dd9e |

## Log
- L1 (2026-10-26, usuario): "Solo BACKEND. Sigue AGENTS.md (el servidor ya está encendido; no lo inicies ni lo apagues). Trabaja en la rama auditoria. Explícame en lenguaje sencillo. Basado en docs/auditoria/informe-backend.md. Agrega o actualiza pruebas para cada arreglo y corre todas al final. Tanda 3: 1..18 (ver Specs). Actualiza el informe marcando lo corregido. Commit y push. Resumen corto." y "Continue where you left off."
- Decisión: la ejecución anterior se interrumpió antes de empezar; no había cambios en el árbol de trabajo.
- Verificación final: 317 pruebas, 317 pasan; typecheck limpio; sin bases temporales sobrantes. Revisión nativa de los commits de riesgo alto (52bc3e0, 19b2143, 3dcfede) pendiente del consentimiento del usuario.
