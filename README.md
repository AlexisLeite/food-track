# Comida

Aplicación mínima en español para registrar comidas y calorías, por foto o audio. Login con usuario y contraseña, objetivos individuales, opciones estimadas por Codex e historial de reevaluaciones. «Describir comida» abre el modal con el micrófono listo; la grabación empieza únicamente al pulsar el botón de grabar. Tanto las descripciones como las correcciones muestran dos botones del mismo estilo: «Tocá para grabar» y «Tocá para escribir». Escribir abre un campo con botón de envío; volver conserva el borrador. Stop envía el audio automáticamente, lo transcribe localmente y solicita el análisis. Solo se conserva la transcripción; cerrar el modal cancela la grabación sin enviarla.

El contador diario muestra debajo el acumulado de la semana de domingo a sábado. Ambos son verdes dentro del objetivo y rojos al superarlo, de forma independiente. El objetivo semanal suma los siete objetivos diarios base, respetando cambios guardados; para fechas anteriores al primer objetivo conocido se usa la configuración actual. Los registros pendientes de selección no cuentan como calorías consumidas.

## Ejecutar

Requiere Node.js 22.13 o posterior, Python con venv y Codex CLI con una sesión iniciada (`codex login status`).

```sh
npm ci
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
set -a
. ./.env
set +a
npm start
```

Para precargar el modelo de audio antes de recibir peticiones:

```sh
.venv/bin/python -c 'from faster_whisper import WhisperModel; WhisperModel("small", device="cpu", compute_type="int8")'
```

El servidor escucha en `127.0.0.1:3086`. Configurar `APP_ORIGIN` con el origen exacto (esquema, host y puerto) usado en el navegador. En producción HTTPS usar `COOKIE_SECURE=true`. El servicio systemd carga `.env`; `npm start` usa las variables exportadas. No se necesita una API key de OpenAI: Codex CLI usa su sesión existente del usuario del servicio. No se copia ni se expone el token a la aplicación cliente. Los procesos de análisis omiten configuración, reglas y herramientas de shell y utilizan un sandbox de solo lectura. Se usa [Codex en modo no interactivo](https://developers.openai.com/codex/noninteractive), con imagen adjunta y esquema JSON de salida.

## Publicación en este equipo

- URL: https://comida.gim.uy
- Servicio: `foodtrack.service`, instalado desde `deploy/foodtrack.service`.
- Checkout: `/repos/foodtrack`.
- Datos: `/repos/foodtrack/data/foodtrack.sqlite` y `/repos/foodtrack/data/photos/`.
- Cloudflare Tunnel: ingress de `comida.gim.uy` a `http://127.0.0.1:3086` en `/etc/cloudflared/config.yml`.
- DNS: CNAME hacia el túnel existente. Los ingress anteriores se conservan.

```sh
npm run check
npm test
systemctl restart foodtrack
systemctl status foodtrack --no-pager
```

Las pruebas usan una base temporal y un analizador inyectado; comprueban aislamiento de usuarios, sesiones, CSRF, selección de opciones, totales, reevaluaciones, recuperación de fallos y borrado. El análisis real de Codex y la transcripción local también se verificaron durante la instalación.

Para respaldar, detener brevemente `foodtrack`, copiar todo `data/` (incluidos SQLite, WAL y SHM si existen) y volver a iniciarlo. No subir datos, `.env`, credenciales de Codex ni el entorno Python a Git. La transcripción borra sus archivos temporales tanto al finalizar como al fallar. El navegador libera el micrófono y los fragmentos de audio al parar, cancelar o cerrar, y descarta el archivo una vez enviada la transcripción. Las fotos se guardan hasta que el usuario elimina la comida.

## Cambiar la contraseña de alexis

Ejecutar en el servidor desde una terminal interactiva:

```sh
sudo /repos/foodtrack/scripts/cambiar-password-alexis.sh
```

Pide y confirma la nueva contraseña sin mostrarla (12 a 128 caracteres),
crea y verifica un respaldo SQLite consistente junto a la base, actualiza
el hash scrypt de alexis y revoca sus sesiones en una transacción.
Conserva sus comidas, fotos, historial y perfil. No requiere reiniciar el servicio.
Lee `DATA_DIR` de `.env` del checkout; `FOODTRACK_DB` permite usar una base
de prueba existente. La contraseña no se pasa como argumento ni se guarda
en el historial del shell. Las copias `foodtrack.sqlite.before-password-*.sqlite`
contienen datos privados y se crean con permisos 0600.

## Navegación e historia

Las secciones Comida, Historia y Configuración comparten navegación superior. Los días posteriores y las secciones hacia la derecha entran desde la derecha, mientras el contenido actual sale hacia la izquierda; al retroceder ocurre lo contrario. Las animaciones respetan la preferencia de movimiento reducido y descartan respuestas de navegación que llegan fuera de orden.

Historia compara el consumo confirmado con el objetivo diario para calorías y cada macronutriente. Permite períodos de 7, 30 y 90 días y elegir la fecha final, con datos por día accesibles. Los días sin registros son datos ausentes, no ingesta cero. Las comidas pendientes de confirmar y los macros faltantes se distinguen en la tabla. El porcentaje expresa consumo/objetivo, no una valoración nutricional de días incompletos.

Los objetivos se guardan por usuario y fecha en `profile_goals` al cambiar la configuración. Al actualizar esta versión se conserva como primera referencia el perfil existente y su fecha de inicio; no se inventan objetivos anteriores a esa fecha. Cambios en la configuración posteriores se reflejan desde ese día en adelante.

El botón Describir comida graba y transcribe el audio, guarda el texto en `meal_descriptions` y solicita las alternativas a Codex sin adjuntar imagen. Usa la misma selección, edición, macros y correcciones por audio que las fotos. Si falla Codex, el registro queda pendiente para poder reintentar. El servidor autoriza cada lectura y edición por usuario.

## Cálculo

Gasto estimado: Mifflin–St Jeor (10 × peso kg + 6,25 × altura cm − 5 × edad + 5 para hombre / −161 para mujer), multiplicado por actividad (1,2 / 1,375 / 1,55 / 1,725 / 1,9). Fuente de la ecuación: [Mifflin et al., 1990](https://pubmed.ncbi.nlm.nih.gov/2305711/).

La meta inicial usa una aproximación lineal de 7.700 kcal por kg, dividida por los días hasta la fecha elegida. Se calcula al guardar la configuración y permanece estable hasta modificarla. No es una predicción fisiológica exacta ni garantiza alcanzar ese peso en esa fecha. El déficit máximo diario es de 1.200 kcal, sin piso fijo de ingesta según género. Se conserva el máximo de superávit de 500 kcal/día. Los resultados negativos se muestran como presupuesto agotado o plazo matemáticamente inviable, según corresponda. Aplicación para adultos, con estimaciones orientativas. El [NIDDK Body Weight Planner](https://www.niddk.nih.gov/bwp) ofrece un modelo de cambios de peso más completo.

## Macronutrientes

Cada nueva opción de Codex incluye `protein`, `fat` y `carbs`: gramos totales de proteínas, grasas y carbohidratos para la porción completa, además de calorías. El servidor valida que sean números finitos y no negativos. Al seleccionar o editar una opción, sus macros se suman al registro diario; reevaluar conserva la selección anterior hasta confirmar otra.

La dirección del objetivo se infiere comparando peso objetivo y actual. Estos repartos son valores predeterminados del producto, orientativos, expresados como porcentaje de las calorías diarias:

| Objetivo inferido | Proteínas | Grasas | Carbohidratos |
| --- | --- | --- | --- |
| Bajar de peso | 30 % | 25 % | 45 % |
| Subir de peso | 25 % | 25 % | 50 % |
| Mantener el peso | 20 % | 30 % | 50 % |

Las metas en gramos se calculan con 4 kcal/g de proteínas y carbohidratos y 9 kcal/g de grasas, redondeadas a un decimal. Los repartos elegidos se encuentran dentro de los [rangos AMDR para adultos de National Academies, tabla C-5](https://www.nationalacademies.org/read/10872/chapter/13); la distinción por objetivo es una decisión del producto, no una prescripción individual de esa fuente.

Los perfiles existentes reciben las metas al leerlos sin cambiar sus calorías, pesos ni plazos guardados. Las opciones antiguas sin macros se conservan, se señalan como incompletas y requieren reevaluación y confirmación para completarlas. Si un día contiene alguna comida sin macros, sus calorías siguen contando y el resumen de macros se marca como incompleto.

Para completar datos históricos por pedido del usuario: `node scripts/backfill-macros.js`. El script crea antes un respaldo SQLite consistente en `data/backups/`, solicita a Codex solo los macros de las opciones ya guardadas y conserva porciones, calorías y selecciones. Compara los registros dentro de una transacción para evitar sobrescribir ediciones concurrentes. No se ejecuta automáticamente al iniciar el servidor.

Las opciones de una foto representan alternativas para el plato completo: solo la seleccionada suma calorías. Reevaluar conserva todas las alternativas previas y no cambia la selección hasta confirmarla. Las cantidades y calorías de una imagen son estimaciones.

## Límites de esta primera versión

Registro abierto de cuentas, sin recuperación de contraseña por correo. Una sesión de Codex del servidor atiende los análisis de todos los usuarios, uno por vez, sujeta a su disponibilidad y límites. El audio admite hasta 8 MB y 75 segundos; las grabaciones de la interfaz se detienen a los 60 segundos. El navegador admite fotos de hasta 40 MB y las convierte antes de subirlas a JPEG de hasta 1.600 px y 500 KiB, sin conservar metadatos. Si no puede decodificar o comprimir una foto, no envía el original. El servidor mantiene su límite de 12 MB y valida/reconvierte las imágenes recibidas. Día alimentario en zona America/Montevideo.

La navegación muestra inmediatamente cada sección o día con una transición lateral. La caché del navegador usa TanStack Query Core y localStorage, separada por usuario y válida durante 24 horas; requiere autenticar la sesión antes de restaurarse. Muestra datos guardados mientras consulta al servidor y usa ETags para revalidarlos. Las modificaciones invalidan los días guardados (que incluyen sus totales semanales) y la historia; salir elimina la caché de la cuenta. Para regenerar la librería local: `npm run build:cache`.

Los modales animan su apertura y cierre (respetando reducir movimiento) y se cierran con la X, Escape o un clic fuera de sus límites.

Al enviar audio o una foto, el control se reemplaza por una animación de íconos (entrada → plato → datos) durante recepción y análisis. El botón de grabar no vuelve a estar disponible entre transcripción y análisis; si falla una solicitud, permite reintentar. Se respeta la preferencia de reducir movimiento. La barra diaria escala hasta el mayor valor entre consumo y objetivo y marca el objetivo con un triángulo, incluso cuando se supera.

La barra diaria conserva el fondo blanco y llena de verde hasta el objetivo; el exceso aparece en rojo, con el objetivo señalado por un triángulo. No muestra etiquetas en sus extremos.


El presupuesto diario se recalcula como `(objetivo semanal base − ingesta confirmada desde el domingo hasta el día anterior) / días restantes hasta el sábado, incluido el día consultado`. Se redondea a kcal enteras y no cambia al registrar comidas del mismo día. Los registros de días futuros no reducen el presupuesto del día consultado. Si el reparto semanal supera el déficit de 1.200 kcal/día, se conserva el valor bruto y se informa que se aplica el máximo de déficit. Los macros y la gráfica de Historia usan este mismo presupuesto, incluyendo registros anteriores al inicio del período cuando pertenecen a esa semana.

Configuración muestra peso proyectado para la fecha solicitada y fecha estimada para alcanzar el peso objetivo con el ajuste base aplicado. Ambas proyecciones usan el modelo lineal existente de 7.700 kcal/kg, desde la fecha de configuración y con gasto constante; son aproximaciones, no un pronóstico basado en mediciones posteriores. Se calculan también para perfiles ya guardados, sin modificar sus datos ni las comidas.

El cambio al déficit máximo de 1.000 kcal/día recalcula los perfiles guardados conservando sus datos y fecha inicial. Antes se crea un respaldo SQLite y se registra el nuevo objetivo desde la fecha del cambio; se conservan los objetivos de días anteriores. La migración se aplica una sola vez por versión de política.

La política de calorías versión 3 elimina los pisos fijos de 1.200/1.500 kcal según género. El límite inferior se calcula como `max(0, gasto estimado − 1.000)`, tanto para el objetivo base como para el reparto semanal. No se atribuye a la OMS un mínimo universal de ingesta; sus recomendaciones generales describen necesidades individuales: https://www.who.int/news-room/fact-sheets/detail/healthy-diet.

La política versión 4 elimina el máximo de déficit de 1.000 kcal/día, también en el reparto semanal. Los objetivos se calculan según el peso y plazo guardados, sin cambiar la fecha inicial. Los perfiles existentes se recalculan con respaldo previo y conservando las comidas y objetivos históricos anteriores al día de la actualización.

La política versión 5 fija un déficit máximo de 1.200 kcal/día, tanto para el objetivo base como para el reparto semanal. Es una configuración del producto solicitada por el usuario, no una certificación de seguridad médica individual. Se recalculan los perfiles con respaldo previo y conservación del historial.

En el modal de una comida, «Repetir comida» permite elegir una fecha y copiar la opción confirmada, con las mismas calorías y macros, sin solicitar un análisis nuevo. La copia conserva descripción, alternativas y una foto independiente, y puede editarse o eliminarse sin afectar al registro original. Se invalidan las cachés de los días e Historia y se actualiza el presupuesto semanal. Las comidas pendientes de selección no se pueden repetir.

El cambio entre los botones de grabar/escribir y el campo de texto usa una transición de 180 ms con desplazamiento, desvanecimiento y ajuste de altura, también al volver. Se conserva el borrador y se respeta reducir movimiento.

Todas las evaluaciones de comida (foto, descripción, reevaluación y completado de macros) solicitan Fast mediante `service_tier="fast"` y `features.fast_mode=true` en cada ejecución de Codex, incluso al omitir la configuración global. Referencia: https://learn.chatgpt.com/docs/agent-configuration/speed.

## Logs de ejecución

Los registros JSON se consultan con `journalctl -u foodtrack.service -f -o cat`. Cada petición API tiene un `requestId`, también devuelto en `X-Request-ID`, para correlacionar recepción, finalización o desconexión con el análisis o la transcripción. Los procesos de Codex y Whisper registran inicio, PID, duración, código de salida, señal, timeout y resultado; Codex registra además el nivel Fast solicitado y la cantidad de opciones. Los logs no incluyen prompts, transcripciones, contenido de audio ni diagnósticos crudos del CLI. La consola del navegador muestra estado HTTP, tipo de respuesta e identificadores cuando recibe una respuesta ilegible, y la interfaz muestra un mensaje comprensible.

Por pedido del usuario, todos los audios de todas las cuentas se conservan en `/mnt/scraper-db/food-track/audio`, en el disco secundario. Cada archivo tiene metadatos JSON con usuario, fecha, formato, identificador de petición, transcripción y resultado (o código de error si falla). La configuración persistente está en `data/audio-debug/persistent.json`, con `userId: "*"`, `mountPoint: "/mnt/scraper-db"` y `mountUuid: "301f3153-374a-4a01-99ba-7d9979e3bf01"`. Primero se guardan los bytes y el resultado en `data/audio-debug/pending`; un worker revisa la cola al iniciar y cada 30 segundos y la transfiere al externo después de finalizar la transcripción. Si falta el disco o falla la transferencia, conserva la copia local y reintenta. Los audios de procesos interrumpidos también se recuperan al iniciar. El directorio tiene permisos 0700 y los archivos 0600; no se sirven públicamente ni se incluyen en Git.

La base SQLite, sus respaldos, las cuentas y el historial **permanecen en `DATA_DIR` del disco interno**. Las fotos se guardan directamente en `/mnt/scraper-db/food-track/photos` cuando el disco está disponible. Si falta o falla una escritura, las fotos nuevas quedan temporalmente en `data/photos`; al volver el disco se copian, sincronizan y retiran de la cola local. Las fotos anteriores no se replican localmente: pueden devolver 404 mientras el USB está ausente, sin impedir consultar el historial ni registrar comidas nuevas. Se puede repetir una comida de foto sin la imagen si esta no está disponible. Las eliminaciones pendientes también se aplican al recuperar el disco. Los lectores de imágenes en curso no pierden su archivo durante una transferencia.

Foodtrack arranca sin el externo y no tiene dependencias systemd del montaje. La identidad del filesystem se comprueba por UUID y número de dispositivo antes de crear directorios. Las operaciones externas usan descriptores abiertos del volumen validado, para evitar escribir en el directorio vacío del disco interno si desaparece el montaje. `deploy/install-service.sh` instala la unidad, configura la protección del archivo de audio y respalda/retira los dos drop-ins antiguos que bloqueaban el arranque. La ubicación externa de fotos se configura con `FOODTRACK_PHOTOS_DIR`, `FOODTRACK_MEDIA_MOUNT` y `FOODTRACK_MEDIA_UUID`; los scripts de mantenimiento deben cargar las mismas variables del servicio.

Verificado en producción el 2026-10-24: `npm test` aprobó 63 pruebas; `npm run check` y la sintaxis de los módulos nuevos e instalador pasaron. Las pruebas incluyen cuentas/historial disponibles por API, fotos anteriores ausentes, nuevas fotos locales, repetición sin imagen y recuperación posterior. Una prueba con el volumen real y datos temporales verificó el UUID, guardado directo, cola local con UUID ausente y transferencia de fotos/audios sin duplicación; se retiraron sus archivos. Se migraron 12 fotos y se comparó SHA-256 con los originales. SQLite conservó su inode, ruta y cantidades de usuarios/comidas/análisis/sesiones; `PRAGMA quick_check` devolvió `ok`. La evidencia previa está en `/var/backups/foodtrack-storage-migration-20261024.json`. El servicio está activo, habilitado y respondió HTTP 200 en `https://comida.gim.uy/`. No se desconectó el USB real ni se reinició el equipo para estas comprobaciones.

La navegación entre Comida, Historia y Configuración usa una botonera fija inferior con íconos de línea. En Comida, el selector de fecha queda apilado inmediatamente encima. Deslizar hacia la izquierda avanza al día siguiente y hacia la derecha vuelve al anterior; se respetan scroll vertical, campos de formulario, modales y gestos desde el borde de Safari.

«Repetir comida» abre el calendario nativo mediante un campo de fecha transparente superpuesto al botón, para que el toque móvil llegue directamente al control del navegador; no muestra un campo adicional ni un calendario custom.

## Permiso de extracción con Codex

La columna `users.enable_codex_extraction` es `INTEGER NOT NULL DEFAULT 0` y solo admite 0/1. Toda cuenta nueva se crea deshabilitada, sin excepciones por nombre. No hay pantallas ni endpoints para cambiarla: se administra únicamente por SQL. Por ejemplo, `UPDATE users SET enable_codex_extraction=1 WHERE username='alexis';` habilita esa cuenta, y el valor 0 revoca el permiso. Cada petición de análisis/reevaluación consulta el usuario autenticado desde la base y devuelve 403 antes de ejecutar Codex si el flag no es 1. Las opciones existentes siguen disponibles para seleccionar o repetir. El script de completado de macros también omite cuentas deshabilitadas. La migración respalda la base antes de agregar la columna y no habilita usuarios automáticamente ni al reiniciar.

Los contadores diario y semanal muestran consumo/objetivo mientras no se supere el objetivo. Al superarlo muestran consumo/mantenimiento/objetivo, con el objetivo rojo, tenue y tachado. El consumo es verde dentro del objetivo, neutro hasta mantenimiento y rojo al superar mantenimiento. El mantenimiento semanal suma los gastos diarios guardados. La barra diaria es verde hasta el objetivo, tiene un degradado de verde a rojo hasta mantenimiento y es roja sólida por encima; la flecha de mantenimiento aparece solo al superar el objetivo. El scroll del contenido ocupa todo el ancho del navegador, con una barra clara de 4 px donde el navegador lo permite.

La gráfica de Historia conserva sus ejes, escala y controles y añade una línea roja tenue con el balance acumulado de esta semana, comparando consumo, objetivo y mantenimiento de los mismos días registrados: coincidir con la gris representa cumplir el objetivo calórico acumulado; coincidir con la verde representa mantenimiento. Se ignoran días futuros y los días sin registros no se cuentan como ingesta cero. Hoy se identifica como provisional en el tooltip, sin punteado adicional. Domingo es un punto y la serie ocupa como máximo siete días. Todas las líneas usan curvas que preservan los valores y no inventan picos; la gráfica de calorías muestra solamente el balance semanal rojo y las referencias de objetivo y mantenimiento. Las gráficas de macronutrientes conservan el consumo diario con puntos pequeños.

El asistente ocupa la sección central como una ruta normal y participa de las transiciones laterales, integrado como cuarto ícono de la barra inferior para usuarios autorizados. Adapta la ventana, la composición de mensajes y el comportamiento del teclado de `/repos/rulelab-wt` a los módulos nativos y estilos de Comida. El botón usa únicamente un ícono de conversación centrado y solo aparece si `/api/me` informa `canChat`, derivado de `enable_codex_extraction`. `POST /api/chat` comprueba nuevamente ese flag en la base. No hay controles para administrarlo. Usa siempre `gpt-6.1-sol`, velocidad normal (sin Fast) y búsqueda web en vivo, sin acceso a shell, herramientas de edición ni MCP configurados por el usuario. Recibe el perfil, los objetivos y el historial de los últimos 90 días de la cuenta autenticada, con detalle de hasta 500 comidas y totales diarios completos; no recibe credenciales, fotos ni registros de otras cuentas. Actualiza ese contexto en cada consulta. Las respuestas incluyen enlaces a las fuentes consultadas.

Hay una única conversación en memoria del cliente: cerrar/reabrir o cambiar de sección conserva los mensajes; refrescar, salir o cambiar de cuenta los elimina. No usa localStorage, tablas de conversaciones ni sesiones persistentes de Codex (`thread/start` con `ephemeral: true`). Cada turno envía el historial completo, sin compactación; un límite explícito de tamaño pide recargar cuando se alcanza. La respuesta usa eventos HTTP con estado de revisión/búsqueda, texto incremental real de Codex App Server y permite detener la consulta. El textarea permanece disponible para escribir el próximo mensaje durante la respuesta, conservando el borrador. En móvil no recibe foco automático al entrar ni al terminar una respuesta; se mantiene la conversación al cambiar de sección. El renderizador copia `AssistantMessage`, `tokenReveal` y `textPresentation` de Rulelab: ReactMarkdown con GFM para tablas/listas/enlaces, bloques estables y entrada animada por palabras. Agrupa los fragmentos recibidos por frame, sin demorar la respuesta ya recibida; respeta movimiento reducido. Se carga al abrir el chat, sin cargar React en la navegación inicial. Se compila con `npm run build:assistant`. El mismo botón sirve para grabar con el campo vacío, detener/enviar audio o enviar texto. La transcripción usa el endpoint y archivo de diagnóstico de audio existentes.

Las sugerencias iniciales incluyen comidas para este mediodía (antes de las 15:00 de Uruguay) o esta noche (desde las 15:00), además de un bocadillo. La etiqueta se actualiza al entrar y cada minuto mientras el chat está visible. El asistente recibe la hora local del servidor y prioriza preparaciones cotidianas de clase media uruguaya, ingredientes accesibles, porciones acordes al objetivo y preferencias inferidas del historial, sin asumir restricciones o gustos no registrados.

La búsqueda web mantiene `code_mode_host = true`, necesario para ejecutar la herramienta, con shell, edición, apps y MCP ajenos deshabilitados. Los logs registran inicio y final de búsquedas y su cantidad por consulta, sin guardar consultas ni URLs.
