# Task Sync Bridge

Extension de Chrome MV3 para crear tareas manualmente, capturar la pestana actual y sincronizar entre Notion y Google Tasks.

## Lo que incluye

- Popup para capturar titulo, notas y fecha limite.
- Boton para capturar la pestana activa como borrador de tarea.
- Pagina de opciones para guardar credenciales/configuracion.
- Integracion con Notion usando `integration token` + `database id`.
- Integracion con Google Tasks usando OAuth dentro de la extension.
- Lectura de tareas recientes de ambos servicios desde el popup.
- Sincronizacion manual bidireccional con un registro local de correspondencias entre tareas.
- Sincronizacion automatica configurable por intervalo.
- Estrategia de conflictos configurable: manual, Notion o Google Tasks.

## Como cargarla en Chrome

1. Abre `chrome://extensions`.
2. Activa `Developer mode`.
3. Haz clic en `Load unpacked`.
4. Selecciona esta carpeta.

## Configurar Notion

1. Crea una integracion en Notion.
2. Copia el token secreto.
3. Comparte tu database con la integracion.
4. Copia el `database_id`.
5. En la pagina de opciones de la extension pega:
   - `Integration token`
   - `Database ID`
   - nombres reales de las propiedades de tu database

### Where to find the Notion Database ID

1. Open your Notion database as a full page.
2. Look at the URL in the browser.
3. Copy the 32-character database ID from the URL.

Example:

`https://www.notion.so/workspace/My-Tasks-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?v=...`

In that example, the database ID is:

`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`

If your URL shows dashes, you can usually paste it either with or without them.

La base de datos necesita, como minimo:

- Una propiedad tipo `title` para el nombre de la tarea.
- Una propiedad tipo `rich_text` para notas, si vas a usar notas.
- Una propiedad tipo `date` para la fecha, si vas a usar fecha limite.
- Una propiedad tipo `checkbox` para completado, si quieres sincronizar ese estado.

## Configurar Google Tasks

1. Ve a Google Cloud Console.
2. Crea un proyecto o usa uno existente.
3. Habilita la API `Google Tasks API`.
4. Crea un `OAuth Client ID`.
5. En `Authorized redirect URIs` agrega la URL de redirect de tu extension:

   `https://<EXTENSION_ID>.chromiumapp.org/oauth2`

6. Copia el `Client ID` en la pagina de opciones.
7. Copia tambien el `Client Secret` en la pagina de opciones.
8. Haz clic en `Autorizar Google`.

## Como funciona la sincronizacion

- La extension lee hasta 25 tareas recientes de cada lado.
- Si encuentra tareas equivalentes, crea un enlace local para no duplicarlas.
- Si una tarea existe en un solo lado, la crea en el otro.
- Si una tarea enlazada cambia solo en Notion o solo en Google Tasks, actualiza la contraparte.
- Si cambian ambas desde la ultima sync, aplica la estrategia elegida en Opciones.
- Si eliges `Manual`, la extension no pisa datos y deja el conflicto sin resolver.

## Notas importantes

- Los secretos se guardan en el almacenamiento de la extension. Para produccion conviene endurecer la seguridad y definir mejor el modelo de credenciales.
- Esta version puede sincronizar manualmente o de forma automatica por intervalo.
- Las eliminaciones no se propagan todavia.
- La calidad del mapeo mejora si los nombres de propiedades de Notion coinciden con la configuracion de Opciones.
