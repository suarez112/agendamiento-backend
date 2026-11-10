# Publicar con Wompi (cambio futuro de `render.yaml` y del doc de despliegue)

Este archivo guarda el texto exacto que hay que aplicar **cuando se active Wompi en producción**. Todavía no está aplicado:
`render.yaml` sigue con `PROVEEDOR_PAGO=manual` y `docs/despliegue-render.md` sigue como estaba.

> **Aviso:** desde el retiro del flujo manual (rama `refactor/quitar-pagos-manuales`) el servidor **no arranca** con
> `PROVEEDOR_PAGO=manual` (ver "Orden para no dejar la API caída" más abajo). Aplica este cambio **antes** de desplegar ese código.

## 1. `render.yaml`

Reemplazar este bloque:

```yaml
      - key: PROVEEDOR_PAGO
        value: manual
      # Optional: page where admins activate their plan (linked in trial emails). Leave blank if none.
      - key: URL_PAGOS
        sync: false
```

por este (los valores se escriben solo en el panel de Render; nunca en el repositorio):

```yaml
      # Subscription payments go through Wompi. The server refuses to start in production without the four
      # production keys (pub_prod_, prv_prod_, prod_events_, prod_integrity_) and URL_PAGOS. Values are set in the
      # Render dashboard only (sync: false); never commit them.
      - key: PROVEEDOR_PAGO
        value: wompi
      - key: WOMPI_LLAVE_PUBLICA
        sync: false
      - key: WOMPI_LLAVE_PRIVADA
        sync: false
      - key: WOMPI_SECRETO_EVENTOS
        sync: false
      - key: WOMPI_SECRETO_INTEGRIDAD
        sync: false
      # Where the payer returns after paying (the app or the website); "/<reference>" is appended. Required with Wompi.
      - key: URL_PAGOS
        sync: false
```

## 2. `docs/despliegue-render.md`

**a) En "Las que llenas tú"**, reemplazar el párrafo de introducción:

```md
Render te las pide al crear el Blueprint. **Todas son opcionales**: si no tienes el dato, déjalas en blanco. Si el Blueprint ya
estaba creado, Render no las pide: agrégalas a mano en el servicio → **Environment** → **Add Environment Variable** y luego despliega.
```

por:

```md
Render te las pide al crear el Blueprint. **Las de Wompi y `URL_PAGOS` son obligatorias en producción**: con `PROVEEDOR_PAGO=wompi` el
servidor no arranca si falta alguna o si una llave no es de producción. El resto son opcionales: si no tienes el dato, déjalas en blanco.
Si el Blueprint ya estaba creado, Render no las pide: agrégalas a mano en el servicio → **Environment** → **Add Environment Variable** y
luego despliega.
```

**b) En la misma tabla**, reemplazar la fila de `URL_PAGOS`:

```md
| `URL_PAGOS` | Página donde un administrador activa su plan. Aparece en los correos de la prueba gratuita ("Activa tu plan aquí"). Ej. `https://agendality.com/pagos` | Es una página de tu sitio web o de la app. Si aún no existe, déjala en blanco |
```

por estas cinco filas:

```md
| `WOMPI_LLAVE_PUBLICA` | Llave pública de Wompi. Va en la dirección del pago. En producción empieza con `pub_prod_` | Panel de Wompi → **Desarrolladores** → llaves del ambiente de **producción**. Cópiala solo en Render |
| `WOMPI_LLAVE_PRIVADA` | Llave privada de Wompi: consulta el estado de cada pago. Nunca sale del servidor. Empieza con `prv_prod_` | Mismo lugar. Cópiala solo en Render |
| `WOMPI_SECRETO_EVENTOS` | Secreto con el que se verifica la firma de los avisos (webhook) de Wompi. Empieza con `prod_events_` | Mismo lugar. Cópiala solo en Render |
| `WOMPI_SECRETO_INTEGRIDAD` | Secreto que firma la dirección del pago. Empieza con `prod_integrity_` | Mismo lugar. Cópiala solo en Render |
| `URL_PAGOS` | A dónde vuelve la persona después de pagar (la app o tu sitio web). Se le agrega `/<referencia>` y Wompi agrega `?id=<transacción>`. También se enlaza en los correos de la prueba gratuita ("Activa tu plan aquí"). Ej. `https://agendality.com/pagos` | Es una página de tu sitio web o de la app. **Obligatoria en producción** |
```

**c) En "Las que genera Render" / valores fijos**, reemplazar la fila:

```md
| `PROVEEDOR_PAGO` | `manual` | Pagos por Nequi, llave Bre-B o QR, verificados por ti en el panel |
```

por:

```md
| `PROVEEDOR_PAGO` | `wompi` | Los pagos de la suscripción se cobran con Wompi. Sin esta variable los pagos quedan desactivados (crear una orden responde 503) |
```

**d) Justo después de** `Si cambias una variable en Render, el servicio se reinicia solo con el valor nuevo.`, agregar:

```md
**Aviso de Wompi (webhook):** en el panel de Wompi, ambiente de producción, pon como **URL de eventos**
`https://api.agendality.com/api/v1/pagos/webhook`. Con ella, el plan se activa aunque la persona cierre la app antes de volver.
Las llaves de prueba (`*_test_*`) no sirven en producción: el servidor se niega a arrancar con ellas.
```

## 3. Pasos en el panel de Wompi

1. Entra al panel de Wompi con el comercio ya aprobado para producción.
2. **Desarrolladores** → cambia al ambiente de **producción** (no sandbox).
3. Copia las cuatro llaves: llave pública (`pub_prod_…`), llave privada (`prv_prod_…`), secreto de eventos (`prod_events_…`) y
   secreto de integridad (`prod_integrity_…`). Pégalas solo en Render → servicio `agendality-api` → **Environment**.
4. En **URL de eventos** del ambiente de producción pon `https://api.agendality.com/api/v1/pagos/webhook` y guarda.
5. Define `URL_PAGOS` en Render (la página a la que vuelve la persona, p. ej. `https://agendality.com/pagos`).
6. Con llaves **sandbox** primero, en un servidor de pruebas con `NODE_ENV=development` (en producción no arrancan): crea una orden,
   paga con una tarjeta de prueba aprobada y otra rechazada, y comprueba que el plan se activa por el webhook y que `confirmar` al
   volver da el mismo resultado sin duplicar. Reenvía el evento desde el panel y comprueba que no activa dos veces.
7. Solo entonces pasa a producción con las llaves `*_prod_*`.

## 4. Orden para no dejar la API caída

Con el código nuevo, `PROVEEDOR_PAGO=manual` no es un valor válido: el servidor termina al arrancar con
`PROVEEDOR_PAGO: debe ser wompi o simulado`. Por eso el cambio de variables debe estar aplicado **antes** de desplegar ese código:

1. **Antes de tocar nada**, resuelve las órdenes manuales pendientes (aprobar o rechazar con el panel actual): con el código nuevo
   ya nadie podrá hacerlo.
2. En Render → **Environment**, carga los valores de `WOMPI_LLAVE_PUBLICA`, `WOMPI_LLAVE_PRIVADA`, `WOMPI_SECRETO_EVENTOS`,
   `WOMPI_SECRETO_INTEGRIDAD` y `URL_PAGOS` (solo llaves `*_prod_*`). El código actual los ignora mientras siga en `manual`.
3. Cambia `PROVEEDOR_PAGO` a `wompi`, en el panel de Render y, en el mismo Pull Request, en `render.yaml` (secciones 1 y 2 de este
   archivo), para que la sincronización del Blueprint no lo devuelva a `manual`. El código actual también acepta `wompi`: este paso
   es seguro con la versión que ya está publicada.
4. Comprueba en **Logs** que el servicio reinició bien y que `GET /api/v1/pagos/configuracion` responde `proveedor: "wompi"`.
5. Recién entonces une a `main` la rama del refactor y lanza **Manual Deploy** → **Deploy latest commit** (el despliegue
   automático está apagado: unir a `main` no publica nada).
6. Pon la URL de eventos en el panel de Wompi (sección 3, paso 4) y haz un pago real pequeño para comprobar el flujo completo.

Si algún paso falla, Render permite volver a la versión anterior desde **Events** → **Rollback**.
