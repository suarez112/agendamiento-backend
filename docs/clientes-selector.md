# Selector de cliente existente (`GET /api/v1/clientes/buscar`)

Busca clientes del negocio para elegir un "cliente existente" (por ejemplo en Nueva cita, `POST /citas/panel` con `clienteId`). Sirve al **administrador** (integrante con rol Administrador o cuenta de administración) y al **empleado** del mismo negocio. `GET /clientes` sigue siendo solo para administradores.

## Acceso

- Sesión del personal (`Authorization: Bearer <token>`) con la suscripción vigente: **401** sin sesión, **403** con la cuenta de un cliente, **402** si el negocio está vencido.
- El negocio sale **siempre de la sesión**. Un `empresaId` (o cualquier otro parámetro) en la URL se ignora.

## Parámetros

| Parámetro | Regla |
| --- | --- |
| `q` | Obligatorio. De **3 a 100 caracteres**; ninguno de los dos límites cuenta los espacios de los extremos. |

No hay `limite` ni `cursor`: la respuesta trae como máximo **10 clientes**. Para encontrar a alguien que no aparece hay que escribir más.

## Qué busca

- **Nombre**: siempre, sin distinguir mayúsculas, en cualquier parte del nombre. `%` y `_` se buscan como texto.
- **Teléfono**: solo si la sesión puede ver teléfonos (ver abajo) y el texto parece un número (solo dígitos, espacios, `+`, `-`, `.` o paréntesis) con **al menos 3 dígitos**. Compara los dígitos, así `315 777-1234` encuentra `+573157771234`. `+57` (2 dígitos) no busca por teléfono.
- Orden: el de la lista de clientes (última cita más reciente primero, luego nombre).

## Privacidad del teléfono

La regla es la misma de toda la API (`puedeVerTelefonos` + `telefonoVisible`, `src/modules/clientes/privacidad.ts`):

| Quién | Opción `empleadosVenTelefono` | `telefono` / `indicativo` | Busca por teléfono |
| --- | --- | --- | --- |
| Administrador | apagada o encendida | con valor | sí |
| Empleado | apagada (por defecto) | `null` | **no**: solo por nombre |
| Empleado | encendida | con valor | sí |

- Con la opción encendida, el empleado ve el teléfono de **cualquier cliente del negocio** que encuentre la búsqueda (no solo de sus citas), con el mismo tope de 10 por búsqueda. En la agenda y en `POST /citas/panel` sigue viendo solo los de sus propias citas.
- Con la opción apagada los campos `telefono` e `indicativo` **siguen en la respuesta**, en `null`: la forma es siempre la misma.
- Un número escrito por un empleado con la opción apagada se busca solo en el nombre (normalmente responde `datos: []`).
- La opción se lee en cada solicitud: un cambio aplica en la siguiente, con el mismo token.

## Respuesta

**200**

```json
{
  "datos": [
    { "id": "…", "nombre": "Valeria Gómez", "telefono": null, "indicativo": null }
  ],
  "hayMas": false,
  "telefonosVisibles": false
}
```

- `datos`: hasta 10 clientes.
- `hayMas`: `true` si hay más de 10 coincidencias (la app puede pedir que se escriba más).
- `telefonosVisibles`: si esta sesión ve teléfonos y puede buscar por ellos (para cambiar el texto de ayuda del buscador).

## Errores

| Código | Mensaje |
| --- | --- |
| 400 | `Escribe al menos 3 caracteres para buscar` (sin `q`, vacío o menos de 3) |
| 400 | `La búsqueda puede tener hasta 100 caracteres` |
| 400 | `La búsqueda debe ser un texto` (`q` repetido o con caracteres no válidos) |
| 401 / 402 / 403 | Los comunes de los endpoints del personal |

## Código y pruebas

- Ruta: `src/modules/clientes/clientes.rutas.ts`; servicio: `buscarParaSelector`; consulta: `buscarClientesSelector` (`clientes.repositorio.ts`), que comparte la condición de búsqueda con `GET /clientes?q=`.
- Pruebas: `test/clientesSelector.test.ts` y el barrido de `test/privacidadTelefonos.test.ts`.
