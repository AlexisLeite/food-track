# Comida

Aplicación mínima en español para registrar comidas y calorías, por foto o audio. Login con usuario y contraseña, objetivos individuales, opciones estimadas por Codex e historial de reevaluaciones. «Describir comida» abre el modal con el micrófono listo; la grabación empieza únicamente al pulsar el botón de grabar. Tanto las descripciones como las correcciones muestran dos botones del mismo estilo: «Tocá para grabar» y «Tocá para escribir». Escribir abre un campo con botón de envío; volver conserva el borrador. Stop envía el audio automáticamente, lo transcribe localmente y solicita el análisis. Solo se conserva la transcripción; cerrar el modal cancela la grabación sin enviarla.

El contador diario muestra debajo el acumulado de la semana de domingo a sábado. Ambos son verdes dentro del objetivo y rojos al superarlo, de forma independiente. El objetivo semanal suma los siete objetivos diarios base, respetando cambios guardados; para fechas anteriores al primer objetivo conocido se usa la configuración actual. Los registros pendientes de selección no cuentan como calorías consumidas.

## Ejecutar

Requiere PostgreSQL y Node.js 22.13 o posterior, Python con venv y Codex CLI con una sesión iniciada (`codex login status`).

```sh
npm ci
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
set -a
. ./.env
set +a
npm run db:generate
npm run db:migrate
npm start
```

Para precargar el modelo de audio antes de recibir peticiones:

```sh
.venv/bin/python -c 'from faster_whisper import WhisperModel; WhisperModel("small", device="cpu", compute_type="int8")'
```

El servidor escucha en `127.0.0.1:3086`. Configurar `APP_ORIGIN` con el origen exacto (esquema, host y puerto) usado en el navegador. En producción HTTPS usar `COOKIE_SECURE=true`. El servicio systemd carga `.env`; `npm start` usa las variables exportadas. No se necesita una API key de OpenAI: Codex CLI usa su sesión existente del usuario del servicio. No se copia ni se expone el token a la aplicación cliente. Los procesos de análisis omiten configuración, reglas y herramientas de shell y utilizan un sandbox de solo lectura. Se mantiene un único [Codex App Server](https://learn.chatgpt.com/docs/app-server) por proceso de la aplicación, precargado al iniciar el servicio y conectado por stdio local. Todas las extracciones de la cola y el chat reutilizan ese proceso con hilos efímeros independientes por solicitud; cada hilo se descarga al terminar. Se conservan los límites de tres extracciones y tres chats simultáneos. Si Codex se interrumpe, los trabajos en curso fallan para que la cola aplique sus reintentos; el proceso se vuelve a iniciar automáticamente con espera progresiva de 1 a 30 segundos. Cancelar o agotar el tiempo de una consulta interrumpe solo su turno. Los logs distinguen inicio del proceso, conexión lista, creación del hilo, inicio del turno y resultado, sin registrar credenciales ni contenido.

## Publicación en este equipo

- URL: https://comida.gim.uy
- Servicio: `foodtrack.service`, instalado desde `deploy/foodtrack.service`.
- Checkout: `/repos/foodtrack`.
- Base: PostgreSQL `foodtrack`, instancia `18/main`, puerto 5432; acceso mediante Prisma 7.
- Fotos y audios: `/mnt/scraper-db/food-track/`; `DATA_DIR` conserva respaldos y colas locales de archivos.
- Cloudflare Tunnel: ingress de `comida.gim.uy` a `http://127.0.0.1:3086` en `/etc/cloudflared/config.yml`.
- DNS: CNAME hacia el túnel existente. Los ingress anteriores se conservan.

```sh
npm run check
npm test
systemctl restart foodtrack
systemctl status foodtrack --no-pager
```

Las pruebas usan una base temporal y un analizador inyectado; comprueban aislamiento de usuarios, sesiones, CSRF, selección de opciones, totales, reevaluaciones, recuperación de fallos y borrado. El análisis real de Codex y la transcripción local también se verificaron durante la instalación.

Para respaldar la base sin detener el servicio: `npm run db:backup`. Genera y verifica un dump PostgreSQL en formato custom y con permisos 0600. Respaldar también las fotos y audios del disco secundario. No subir datos, `.env`, credenciales de Codex ni el entorno Python a Git. La transcripción borra sus archivos temporales tanto al finalizar como al fallar. El navegador libera el micrófono y los fragmentos de audio al parar, cancelar o cerrar, y descarta el archivo una vez enviada la transcripción. Las fotos se guardan hasta que el usuario elimina la comida.

## Cambiar la contraseña de alexis

Ejecutar en el servidor desde una terminal interactiva:

```sh
sudo /repos/foodtrack/scripts/cambiar-password-alexis.sh
```

Pide y confirma la nueva contraseña sin mostrarla (12 a 128 caracteres),
crea y verifica un respaldo PostgreSQL consistente en `data/backups`, actualiza
el hash scrypt de alexis y revoca sus sesiones en una transacción.
Conserva sus comidas, fotos, historial y perfil. No requiere reiniciar el servicio.
Lee `DATABASE_URL` y `DATA_DIR` de `.env` del checkout; `FOODTRACK_DB` se reserva para recuperación explícita de copias SQLite antiguas. La contraseña no se pasa como argumento ni se guarda
en el historial del shell. Las copias `before-password-*.dump`
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

Para completar datos históricos por pedido del usuario: `node scripts/backfill-macros.js`. El script crea antes un respaldo PostgreSQL consistente en `data/backups/`, solicita a Codex solo los macros de las opciones ya guardadas y conserva porciones, calorías y selecciones. Compara los registros dentro de una transacción para evitar sobrescribir ediciones concurrentes. No se ejecuta automáticamente al iniciar el servidor.

Las opciones de una foto representan alternativas para el plato completo: solo la seleccionada suma calorías. Reevaluar conserva todas las alternativas previas y no cambia la selección hasta confirmarla. Las cantidades y calorías de una imagen son estimaciones.

## Límites de esta primera versión

Registro abierto de cuentas, sin recuperación de contraseña por correo. Una sesión de Codex del servidor atiende los análisis de todos los usuarios, hasta tres extracciones simultáneas, sujeta a su disponibilidad y límites. El audio admite hasta 8 MB y 75 segundos; las grabaciones de la interfaz se detienen a los 60 segundos. El navegador admite fotos de hasta 40 MB y las convierte antes de subirlas a JPEG de hasta 1.600 px y 500 KiB, sin conservar metadatos. Si no puede decodificar o comprimir una foto, no envía el original. El servidor mantiene su límite de 12 MB y valida/reconvierte las imágenes recibidas. Día alimentario en zona America/Montevideo.

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

Todas las extracciones (foto, descripción, reevaluación, completado de macros y entrenamiento) usan explícitamente `gpt-6.1-terra`, razonamiento `low` y modo rápido mediante `service_tier="fast"` y `features.fast_mode=true`, incluso al omitir la configuración global. Conservan los prompts y el archivo mínimo de instrucciones que usaba Sol. Referencia: https://learn.chatgpt.com/docs/agent-configuration/speed.

## Logs de ejecución

Los registros JSON se consultan con `journalctl -u foodtrack.service -f -o cat`. Cada petición API tiene un `requestId`, también devuelto en `X-Request-ID`, para correlacionar recepción, finalización o desconexión con el análisis o la transcripción. Los procesos de Codex y Whisper registran inicio, PID, duración, código de salida, señal, timeout y resultado; Codex registra además el nivel de servicio solicitado y la cantidad de opciones. Los logs no incluyen prompts, transcripciones, contenido de audio ni diagnósticos crudos del CLI. La consola del navegador muestra estado HTTP, tipo de respuesta e identificadores cuando recibe una respuesta ilegible, y la interfaz muestra un mensaje comprensible.

Por pedido del usuario, todos los audios de todas las cuentas se conservan en `/mnt/scraper-db/food-track/audio`, en el disco secundario. Cada archivo tiene metadatos JSON con usuario, fecha, formato, identificador de petición, transcripción y resultado (o código de error si falla). La configuración persistente está en `data/audio-debug/persistent.json`, con `userId: "*"`, `mountPoint: "/mnt/scraper-db"` y `mountUuid: "301f3153-374a-4a01-99ba-7d9979e3bf01"`. Primero se guardan los bytes y el resultado en `data/audio-debug/pending`; un worker revisa la cola al iniciar y cada 30 segundos y la transfiere al externo después de finalizar la transcripción. Si falta el disco o falla la transferencia, conserva la copia local y reintenta. Los audios de procesos interrumpidos también se recuperan al iniciar. El directorio tiene permisos 0700 y los archivos 0600; no se sirven públicamente ni se incluyen en Git.

La base PostgreSQL, las cuentas y el historial permanecen en la instancia `18/main` del disco interno (`/var/lib/postgresql/18/main`); los respaldos de Foodtrack se guardan en `DATA_DIR/backups`. Las fotos se guardan directamente en `/mnt/scraper-db/food-track/photos` cuando el disco está disponible. Si falta o falla una escritura, las fotos nuevas quedan temporalmente en `data/photos`; al volver el disco se copian, sincronizan y retiran de la cola local. Las fotos anteriores no se replican localmente: pueden devolver 404 mientras el USB está ausente, sin impedir consultar el historial ni registrar comidas nuevas. Se puede repetir una comida de foto sin la imagen si esta no está disponible. Las eliminaciones pendientes también se aplican al recuperar el disco. Los lectores de imágenes en curso no pierden su archivo durante una transferencia.

Foodtrack arranca sin el externo y no tiene dependencias systemd del montaje. La identidad del filesystem se comprueba por UUID y número de dispositivo antes de crear directorios. Las operaciones externas usan descriptores abiertos del volumen validado, para evitar escribir en el directorio vacío del disco interno si desaparece el montaje. `deploy/install-service.sh` instala la unidad, configura la protección del archivo de audio y respalda/retira los dos drop-ins antiguos que bloqueaban el arranque. La ubicación externa de fotos se configura con `FOODTRACK_PHOTOS_DIR`, `FOODTRACK_MEDIA_MOUNT` y `FOODTRACK_MEDIA_UUID`; los scripts de mantenimiento deben cargar las mismas variables del servicio.

Verificado en producción el 2026-10-24: `npm test` aprobó 63 pruebas; `npm run check` y la sintaxis de los módulos nuevos e instalador pasaron. Las pruebas incluyen cuentas/historial disponibles por API, fotos anteriores ausentes, nuevas fotos locales, repetición sin imagen y recuperación posterior. Una prueba con el volumen real y datos temporales verificó el UUID, guardado directo, cola local con UUID ausente y transferencia de fotos/audios sin duplicación; se retiraron sus archivos. Se migraron 12 fotos y se comparó SHA-256 con los originales. SQLite conservó su inode, ruta y cantidades de usuarios/comidas/análisis/sesiones; `PRAGMA quick_check` devolvió `ok`. La evidencia previa está en `/var/backups/foodtrack-storage-migration-20261024.json`. El servicio está activo, habilitado y respondió HTTP 200 en `https://comida.gim.uy/`. No se desconectó el USB real ni se reinició el equipo para estas comprobaciones.

La navegación entre Comida, Historia y Configuración usa una botonera fija inferior con íconos de línea. En Comida, el selector de fecha queda apilado inmediatamente encima. Deslizar hacia la izquierda avanza al día siguiente y hacia la derecha vuelve al anterior; se respetan scroll vertical, campos de formulario, modales y gestos desde el borde de Safari.

«Repetir comida» abre el calendario nativo mediante un campo de fecha transparente superpuesto al botón, para que el toque móvil llegue directamente al control del navegador; no muestra un campo adicional ni un calendario custom.

## Permiso de extracción con Codex

La columna `users.enable_codex_extraction` es `INTEGER NOT NULL DEFAULT 0` y solo admite 0/1. Toda cuenta nueva se crea deshabilitada, sin excepciones por nombre. No hay pantallas ni endpoints para cambiarla: se administra únicamente por SQL. Por ejemplo, `UPDATE users SET enable_codex_extraction=1 WHERE username='alexis';` habilita esa cuenta, y el valor 0 revoca el permiso. Cada petición de análisis/reevaluación consulta el usuario autenticado desde la base y devuelve 403 antes de ejecutar Codex si el flag no es 1. Las opciones existentes siguen disponibles para seleccionar o repetir. El script de completado de macros también omite cuentas deshabilitadas. La migración respalda la base antes de agregar la columna y no habilita usuarios automáticamente ni al reiniciar.

Los contadores diario y semanal muestran consumo/objetivo mientras no se supere el objetivo. Al superarlo muestran consumo/mantenimiento/objetivo, con el objetivo rojo, tenue y tachado. El consumo es verde dentro del objetivo, neutro hasta mantenimiento y rojo al superar mantenimiento. El mantenimiento semanal suma los gastos diarios guardados. La barra diaria es verde hasta el objetivo, tiene un degradado de verde a rojo hasta mantenimiento y es roja sólida por encima; la flecha de mantenimiento aparece solo al superar el objetivo. El scroll del contenido ocupa todo el ancho del navegador, con una barra clara de 4 px donde el navegador lo permite.

La gráfica de Historia conserva sus ejes, escala y controles y muestra una línea roja tenue de balance móvil: cada punto pondera el consumo, objetivo y mantenimiento de esa fecha y los seis días anteriores, sin reiniciarse los domingos. Coincidir con la gris representa cumplir el objetivo del período; coincidir con la verde representa mantenimiento. Los días sin registros no se cuentan como ingesta cero y hoy se identifica como provisional. Se muestran como máximo 28 días de balance; el servidor incluye seis días previos al inicio visible y las comidas necesarias para calcular sus objetivos históricos. Todas las líneas usan curvas que preservan los valores y no inventan picos. Las gráficas de macronutrientes conservan el consumo diario con puntos pequeños.

El asistente ocupa la sección central como una ruta normal y participa de las transiciones laterales, integrado como cuarto ícono de la barra inferior para usuarios autorizados. Adapta la ventana, la composición de mensajes y el comportamiento del teclado de `/repos/rulelab-wt` a los módulos nativos y estilos de Comida. El botón usa únicamente un ícono de conversación centrado y solo aparece si `/api/me` informa `canChat`, derivado de `enable_codex_extraction`. `POST /api/chat` comprueba nuevamente ese flag en la base. No hay controles para administrarlo. Usa siempre `gpt-6-luna`, velocidad normal (sin Fast) y búsqueda web en vivo, sin acceso a shell, herramientas de edición ni MCP configurados por el usuario. Recibe el perfil, los objetivos y el historial de los últimos 90 días de la cuenta autenticada, con detalle de hasta 500 comidas y totales diarios completos; no recibe credenciales, fotos ni registros de otras cuentas. Actualiza ese contexto en cada consulta. Las respuestas incluyen enlaces a las fuentes consultadas.

Hay una única conversación en memoria del cliente: cerrar/reabrir o cambiar de sección conserva los mensajes; refrescar, salir o cambiar de cuenta los elimina. La conversación completada no usa localStorage, tablas de conversaciones ni sesiones persistentes de Codex (`thread/start` con `ephemeral: true`). Cada turno envía el historial completo, sin compactación; un límite explícito de tamaño pide recargar cuando se alcanza. La respuesta usa eventos HTTP con estado de revisión/búsqueda, texto incremental real de Codex App Server y permite detener la consulta. El textarea permanece disponible para escribir el próximo mensaje durante la respuesta, conservando el borrador. En móvil no recibe foco automático al entrar ni al terminar una respuesta; se mantiene la conversación al cambiar de sección. El renderizador copia `AssistantMessage`, `tokenReveal` y `textPresentation` de Rulelab: ReactMarkdown con GFM para tablas/listas/enlaces, bloques estables y entrada animada por palabras. Agrupa los fragmentos recibidos por frame, sin demorar la respuesta ya recibida; respeta movimiento reducido. Se carga al abrir el chat, sin cargar React en la navegación inicial. Se compila con `npm run build:assistant`. El mismo botón sirve para grabar con el campo vacío, detener/enviar audio o enviar texto. La transcripción usa el endpoint y archivo de diagnóstico de audio existentes.

Las sugerencias iniciales incluyen comidas para este mediodía (antes de las 15:00 de Uruguay) o esta noche (desde las 15:00), además de un bocadillo. La etiqueta se actualiza al entrar y cada minuto mientras el chat está visible. El asistente recibe la hora local del servidor y prioriza preparaciones cotidianas de clase media uruguaya, ingredientes accesibles, porciones acordes al objetivo y preferencias inferidas del historial, sin asumir restricciones o gustos no registrados.

La búsqueda web mantiene `code_mode_host = true`, necesario para ejecutar la herramienta, con shell, edición, apps y MCP ajenos deshabilitados. Los logs registran inicio y final de búsquedas y su cantidad por consulta, sin guardar consultas ni URLs.


Los envíos de comida, aclaraciones y chat se guardan antes de enviarlos en IndexedDB (`foodtrack-outbox`), separados por usuario. Audio y fotos se almacenan como bytes por compatibilidad con Safari y se reconstruyen para previsualizar/reintentar. Al fallar, aparece «Envíos pendientes» con contenido, Reintentar y Eliminar; la cola sobrevive a recargas y se elimina al completar todo el flujo o por decisión del usuario. Si el almacenamiento local falla, se conserva en memoria y se advierte que no se cierre la página. La bandeja local requiere Reintentar; las extracciones aceptadas por el servidor reintentan automáticamente los errores transitorios.

Cada envío recibe un hash SHA-256 estable, con un nonce para distinguir dos envíos intencionales idénticos. Las etapas de transcripción, creación y análisis usan hashes derivados; el avance se guarda después de cada respuesta. `X-Submission-ID` identifica cada operación y la respuesta incluye `submissionHash`. La tabla `submission_receipts` conserva respuestas exitosas por usuario, hash, ruta y huella del contenido: repetir la misma solicitud devuelve el resultado previo, incluso tras reiniciar el servidor, sin duplicar comidas ni ejecutar nuevamente una extracción completada. Reutilizar el hash con otro contenido devuelve 409. Los reintentos del chat conservan únicamente el contexto del turno pendiente; sus respuestas terminadas con hash también se recuperan sin una nueva ejecución. Los permisos se verifican de nuevo antes de devolver extracciones o respuestas del chat guardadas.


Las configuraciones se conservan como versiones en `profile_versions`, con fecha efectiva de Uruguay e instante de guardado. Guardar configuración agrega una fila y actualiza la copia actual de `users.profile`; no reemplaza versiones anteriores, ni siquiera si se edita varias veces el mismo día. `profile_timeline` selecciona la última versión de cada fecha. La migración respalda la base e importa los objetivos anteriores conservando intactos `profile_goals` y las demás tablas originales.

Para reconstruir el presupuesto de un día pasado, se usan solamente las configuraciones conocidas hasta ese día. Una configuración nueva rige desde hoy: en la semana en curso se conserva el objetivo base de cada día anterior y se aplica el nuevo a los días restantes; luego se resta lo consumido hasta ayer y se divide entre los días restantes. Los días futuros comparten el reparto de hoy. La gráfica usa el objetivo, mantenimiento y distribución de macros vigentes para cada fecha. Los días anteriores a la primera configuración conocida no reciben retroactivamente los valores actuales. Los logs `profile_configuration_saved` registran usuario, versión y fecha efectiva, sin volcar datos personales del perfil.

La aplicación inicia en tema oscuro. En Configuración, el selector Tema permite alternar entre Oscuro y Claro sin guardar ni modificar el perfil nutricional. La preferencia se guarda en `users.theme` (`dark` por defecto, también para cuentas existentes) mediante `PUT /api/preferences`, autenticado y limitado a la cuenta de la sesión. Login, registro y `/api/me` devuelven el tema; se recupera al abrir la cuenta en otro dispositivo. Al salir se vuelve al tema oscuro. Superficies, controles nativos, modales, gráficas y chat comparten variables de color para ambos temas.

La política de calorías versión 6 reemplaza el déficit absoluto por `maxDailyDeficitPercent`: 10 % por defecto, configurable entre 0 y 40 %. El mínimo del presupuesto es el mantenimiento por `(1 − porcentaje/100)`, redondeado hacia arriba a kcal enteras, tanto para el objetivo inicial como para el reparto semanal. El 40 % es un límite de producto elegido por el usuario, no un máximo médico universal. Las guías europeas de EASO describen reducciones del 15–30 % en personas con peso estable: https://easo.org/wp-content/uploads/2018/12/2015-OMTF-European-Guidelines-for-Obesity-Management.pdf. La migración respalda la base, agrega una versión desde el día de actualización y conserva todos los perfiles y cálculos previos. Las configuraciones históricas sin porcentaje mantienen su antigua política.

El perfil de gasto tiene dos modos: `estimated` conserva el factor de actividad semanal, incluidos los entrenamientos habituales; `workouts` calcula el gasto base según `dailyActivity` (sentado, de pie/caminando o trabajo físico moderado), excluyendo entrenamientos. En este segundo modo, la sección Entrenamientos permite describir por texto o audio una sesión con su duración, revisar la estimación y confirmarla o eliminarla. Codex interpreta actividad, duración y MET con servicio estándar; solo los usuarios habilitados para extracción pueden solicitarlo. Cada análisis devuelve tres opciones con los mismos datos declarados y diferentes supuestos sobre los datos faltantes (duración, descansos o intensidad). El servidor calcula las calorías de cada alternativa y solo suma la elegida; se puede cambiar la opción sin crear otro entrenamiento. La falta de duración no bloquea la estimación. Las calorías se calculan en el servidor como `(MET − 1) × 3,5 × peso / 200 × minutos`, con el peso vigente en la fecha del entrenamiento; son estimaciones netas sobre el reposo, basadas en el Compendio 2024: https://pacompendium.com/adult-compendium/. Se guarda la estimación con su peso y supuestos y no se recalcula al cambiar el perfil.

Solo los entrenamientos confirmados de fechas en modo `workouts` suman gasto y presupuesto de comida. La sesión suma a su día, sin repartirse también entre los demás días. El gasto previo compensa la ingesta previa al repartir el presupuesto semanal restante; las calorías de sesiones futuras no se anticipan. Historia y el balance móvil rojo de siete días usan el mantenimiento base más los entrenamientos de cada fecha. Los días sin comidas siguen siendo datos incompletos, no consumo cero. Los envíos de texto/audio de entrenamientos usan la bandeja local de pendientes y hashes de idempotencia, con reintento o eliminación. Los registros se aíslan por usuario; cambiar de modo conserva entrenamientos y versiones anteriores.

La sección Estadísticas y `GET /api/statistics?days=7|30|90` están restringidos en servidor a la cuenta `alexis`, independientemente del permiso de extracción. Muestra tokens diarios de todas las cuentas y los tres usuarios con mayor consumo del mismo período, según días de Uruguay. `token_usage` guarda una fila por ejecución con usuario, tipo, estado y contadores; `token_usage_meta` conserva el inicio de la medición. Se capturan los totales acumulados de `thread/tokenUsage/updated` del App Server, separados por hilo tanto para extracciones como para chat. Entrada incluye caché y salida incluye razonamiento: no se suman dos veces. Los snapshots del chat actualizan la misma fila, los reintentos idempotentes que recuperan respuestas guardadas no crean ejecuciones y los errores con consumo conocido también cuentan. Ejecuciones sin métricas informadas quedan marcadas sin estimar tokens. No se guardan prompts ni respuestas en estas tablas. La medición comienza con esta actualización: no se inventa consumo histórico. La transcripción local de audio no usa Codex.

El porcentaje de consumo usa constantes editables en `server/usage-config.js`: capacidades semanales alternativas de 300.000.000 tokens de entrada sin caché, 6.000.000.000 en caché o 60.000.000 de salida para GPT‑6.1 Sol estándar en Pro US$200. Son estimaciones provisionales, no cuotas oficiales. Cada ejecución aporta `100 × ((entrada − caché)/300M + caché/6000M + salida/60M) × multiplicador`, con 1 en estándar, 2,5 en Fast y 8 en Ultrafast. El razonamiento ya está incluido en salida. Se guardan `token_usage.model` y `token_usage.speed`. Para las nuevas ejecuciones se pondera el modelo: Terra 0,5 en entrada/caché/salida; Luna 0,05 en entrada/salida y 0,1 en caché, respecto a Sol. Es una aproximación basada en tarifas relativas de créditos, no una conversión oficial de cuota Pro. Las filas sin modelo histórico conservan Sol como referencia; las filas anteriores de comida/foto se identifican como Fast y las de chat/entrenamiento como estándar, conservando los contadores originales. El ranking se ordena por porcentaje estimado, no por tokens brutos. La vista inicia en los últimos siete días; al elegir 30 o 90 muestra el equivalente acumulado respecto a una cuota semanal, que puede superar el 100 %. No representa el saldo global de Codex ni incluye otros proyectos.

Configuración incluye un modal para cambiar la contraseña con contraseña actual, nueva y confirmación. `PUT /api/password` valida la contraseña actual y exige entre 10 y 128 caracteres para la nueva, guarda un hash scrypt con sal nueva y revoca las demás sesiones de esa cuenta conservando la sesión que hizo el cambio. Registro mantiene el mínimo de 10 caracteres; login admite contraseñas iniciales existentes más cortas. El endpoint actúa únicamente sobre la cuenta autenticada, sin aceptar identificadores de otro usuario.

Comidas (foto, descripción y aclaraciones), estimaciones de entrenamientos y chat fijan explícitamente el razonamiento `low`. El chat usa GPT‑6 Luna; las extracciones conservan su modelo. Todas las solicitudes usan velocidad estándar, con Fast desactivado explícitamente.

Los análisis de comidas y entrenamientos reemplazan las instrucciones generales de Codex mediante `baseInstructions` por hilo, leyendo `server/extraction-instructions.txt`. El archivo contiene instrucciones breves de estimación, formato y tratamiento de los datos del usuario. `project_doc_max_bytes=0` excluye instrucciones de AGENTS.md. Los prompts específicos y esquemas JSON de cada tarea se conservan; el chat mantiene sus propias instrucciones y búsqueda web.

La extracción desactiva agentes (`agents.enabled=false`), catálogo e instrucciones de skills, personalidad y herramientas ajenas a estimar. Permite búsqueda web en vivo, con prioridad al fabricante y la etiqueta de la variante vendida en Uruguay para productos de marca; incorpora la fuente en `details` y distingue información verificada de estimaciones. Las consultas no deben incluir datos personales. Los logs registran el inicio y final de las búsquedas sin guardar sus consultas. La imagen adjunta y el esquema de salida siguen enviándose normalmente. La configuración se aplica por hilo, sin modificar el Codex personal ni el asistente con búsqueda web. En una prueba con la misma descripción, la entrada pasó de 14.138 tokens originales a 10.106 con instrucciones mínimas y a 3.540 al desactivar esas funciones; es una medición puntual, no un consumo fijo por solicitud.

El chat reemplaza las instrucciones generales de Codex por `server/chat-instructions.txt`, con reglas breves para recomendaciones, privacidad y fuentes. Desactiva agentes y catálogo de skills, conservando búsqueda web en vivo, streaming, historial y contexto de la cuenta.


### Cola y presupuestos de IA

Las comidas, aclaraciones y entrenamientos comparten una cola PostgreSQL durable (`extraction_jobs`), con tres extracciones simultáneas. Cada trabajo admite tres intentos automáticos en total ante errores transitorios (esperas de 1 y 3 segundos). No se reintentan validaciones ni permisos denegados. Un reenvío explícito con el mismo hash recupera el resultado o vuelve a intentar un fallo transitorio sin duplicar el registro ni la reserva de presupuesto. Se revisa el permiso también al ejecutar y entregar el resultado; solo el dueño puede consultar el trabajo. Los trabajos pendientes y los que estaban ejecutándose se recuperan al reiniciar. Los identificadores de análisis/entrenamiento coinciden con el trabajo para recuperar también una interrupción entre guardar el registro y completar el trabajo.

El navegador solicita `Prefer: respond-async`, recibe HTTP 202 y consulta el trabajo con peticiones cortas: la espera en cola no mantiene una petición de análisis abierta frente a Cloudflare. Los clientes anteriores conservan la respuesta síncrona. Audio, fotos y texto mantienen la bandeja IndexedDB y sus hashes.

Cada usuario tiene 56 comidas nuevas, 56 entrenamientos y 168 aclaraciones compartidas entre ambos por semana. Los presupuestos cuentan el momento del envío en Uruguay y se renuevan los lunes a las 00:00, independientemente del día elegido en el calendario; eliminar registros no devuelve presupuesto. Repetir una comida ya confirmada no usa IA. Las reservas y los trabajos se guardan atómicamente; los reintentos no consumen otra reserva. La migración cuenta una sola vez los análisis y entrenamientos existentes, sin modificar sus datos.

El chat usa una cola separada de tres consultas simultáneas y cinco mensajes diarios por usuario, renovados a las 00:00 de Uruguay. Una misma persona conserva una sola consulta activa. Los turnos reenviados con el mismo hash no descuentan otra reserva; cerrar la conexión cancela el turno pendiente o en ejecución. El historial de chat sigue siendo temporal en el navegador. La migración incluye los turnos previos registrados en `token_usage`.

Configuración muestra los presupuestos restantes y totales de comidas, entrenamientos, aclaraciones y chat, junto con la fecha y hora de renovación en Uruguay. La lectura autenticada `/api/usage` consulta solamente las reservas del usuario de la sesión; no admite elegir otra cuenta. Se actualiza al entrar, al volver a la pestaña y cada minuto mientras la sección está visible, sin reemplazar el formulario ni perder sus cambios.

En Estadísticas (solo Alexis), el ranking muestra hasta diez usuarios según el consumo estimado del período. Cada fila permite consultar el total y el desglose diario de esa persona, conservando el ranking global y el período seleccionado; «Ver todos los usuarios» vuelve al agregado. El filtro por usuario se valida y autoriza en el servidor.

## Migración de SQLite a PostgreSQL con Prisma

`DATABASE_URL` es obligatoria: producción no vuelve a SQLite si falla PostgreSQL.
El esquema y sus relaciones están en `prisma/schema.prisma`; aplicar cambios con
`npm run db:migrate`. Prisma administra el pool y las transacciones. Las consultas
SQL existentes siguen parametrizadas mediante Prisma; no se interpolan datos de usuarios.
Los documentos JSON y fechas históricas conservan sus representaciones originales.

Crear una base vacía y un rol dedicado en la instancia existente. Instalar dependencias,
generar el cliente y aplicar las migraciones antes de importar. Para el cambio definitivo,
detener brevemente el servicio, crear un snapshot SQLite consistente e importar ese snapshot:

```sh
node --env-file=.env scripts/migrate-sqlite-to-postgres.mjs data/backups/pre-postgresql.sqlite
node --env-file=.env scripts/migrate-sqlite-to-postgres.mjs data/backups/pre-postgresql.sqlite --verify-only
```

El importador usa una transacción y rechaza destinos con datos; verifica integridad,
claves foráneas, cantidades, SHA-256 de todos los valores, orden de análisis y la vista
histórica `profile_timeline`. Reajusta las secuencias después de preservar los IDs.
No modifica ni elimina el SQLite original ni archivos de fotos y audios.
El archivo `.postgresql-verification.json` junto al snapshot conserva la evidencia.
Una vuelta a SQLite después de recibir escrituras nuevas requiere reconciliar esos datos;
no basta con cambiar la conexión.

`npm test` conserva pruebas de migraciones SQLite antiguas con fixtures explícitos.
Para pruebas reales de PostgreSQL, usar una base separada cuyo nombre termine en `_test`:

```sh
TEST_DATABASE_URL=postgresql://usuario:clave@127.0.0.1:5432/foodtrack_test npm run test:postgres
```

Estas pruebas crean y retiran esquemas aislados; cubren importación, rollback,
sesiones, cuotas concurrentes, cola de tres trabajos, reintentos, idempotencia,
entrenamientos, chat, estadísticas y persistencia tras reiniciar la aplicación.
