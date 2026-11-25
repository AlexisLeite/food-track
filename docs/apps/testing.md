# Testing de las apps

## Estrategia

Verificar primero el proyecto móvil de forma independiente. Después ejecutar los
flujos reales en Android e iOS con un build `preview`. Expo Go sirve como primera
exploración, pero no valida los permisos y firma del binario propio.

Usar una cuenta y datos de pruebas, preferentemente en un servidor HTTPS de QA.
La URL de `.env.example` es producción: las operaciones realizadas allí son reales.
No publicar ni borrar comidas de otras cuentas durante una prueba.

## Verificación estática y del bundle

Desde `apps/mobile/`:

```powershell
npm ci
npm run typecheck
npm run lint
npx expo-doctor
npx expo install --check
npx expo config --type public
# Elegir primero EXPO_PUBLIC_APP_URL en .env.local.
npx expo export --platform android --platform ios
```

La exportación valida el bundle JavaScript, no compila APK/IPA ni prueba código nativo.
Revisar que la URL sea la del ambiente seleccionado antes de compilar. Probar también
con la variable ausente o inválida: debe aparecer la indicación de configuración.
Reiniciar Metro y recargar la app al cambiar la variable.

Los tests existentes de la web conservan sus comandos y entorno originales; no forman
parte de `npm ci` ni de la instalación móvil. Si se ejecutan como regresión adicional,
seguir los requisitos del README de la raíz.

## Matriz mínima

Completar en un Android físico y un iPhone físico con versiones de sistema soportadas
por el SDK. Anotar versión de Android System WebView/Chrome en Android. Usar emulador
o simulador como complemento para navegación, pantalla pequeña y teclado.

| Caso | Resultado esperado |
| --- | --- |
| Primera apertura | Carga el sitio HTTPS sin pantalla vacía ni contenido bajo las barras del sistema. |
| Configuración ausente/HTTP | Explica que falta una URL HTTPS válida. |
| Login válido/inválido | Conserva los mensajes y comportamiento de la web. |
| Cerrar y reabrir | La sesión se conserva según la política y expiración del servidor. |
| Logout y cambio de usuario | No muestra datos de la cuenta anterior; cerrar/reabrir no recupera su sesión. |
| Comida, historia y configuración | Fechas, desplazamiento, formularios y totales funcionan. |
| Foto de galería y cámara | Permite elegir/capturar, cancelar y subir; registra la comida correcta. |
| Micrófono permitido | Graba, detiene, envía y transcribe; la cancelación libera el micrófono. |
| Permisos rechazados/revocados | La web explica el fallo y permite seguir usando texto; reintentar tras habilitarlos funciona. |
| Chat, si la cuenta está habilitada | Texto incremental, enlaces, detener respuesta y audio funcionan. |
| Teclado y áreas seguras | Campo y envío visibles, sin doble margen excesivo ni botones tapados. |
| Enlace interno | Permanece en la WebView. |
| Enlace externo y ventana nueva | Abre el navegador; volver conserva la app. |
| Botón atrás Android | Retrocede en el historial web; en la primera página deja salir. |
| Sin conexión al abrir | Muestra error y permite reintentar al recuperar conectividad. |
| Sin conexión durante un envío | Conserva el comportamiento de la cola/reintento web sin duplicar comidas. |
| Error HTTP en la página principal | Muestra error y el botón de reintento vuelve a intentar cargar el sitio. |
| Suspender y volver | No mantiene grabaciones inadvertidas ni duplica operaciones. |
| Build preview sin Metro | Abre y funciona con Metro detenido. |
| Actualización sobre un build previo | Conserva la sesión según su vigencia y carga la URL correcta. |

Especial atención al audio: la web utiliza `getUserMedia` y `MediaRecorder`, cuyo
comportamiento y formatos dependen de la WebView y del sistema. No dar por validada
la grabación por tener permisos declarados o por funcionar en Chrome/Safari. Si una
plataforma necesita captura nativa, registrarlo como trabajo posterior: esta primera
versión no incorpora un puente de audio ni modifica el código web.

## Evidencia por ejecución

```text
Fecha:
Responsable:
Commit:
Versión / número de build:
Perfil y URL del servidor:
Dispositivo / sistema / versión WebView:
Instalación limpia o actualización:
Caso:
Resultado: aprobado / fallido / pendiente
Evidencia y pasos para reproducir:
```

No incluir contraseñas, cookies, audios personales ni datos de terceros en evidencias.

## Criterio de entrega

Typecheck, lint, comprobación de dependencias y exportación aprobados. Builds propios
Android/iOS instalados y checklist completado; cualquier fallo en login, fotos, audio,
privacidad entre cuentas o envío de datos bloquea la distribución. Registrar cada
pendiente explícitamente: un checklist documentado no significa que ya fue ejecutado.

La evidencia de comprobaciones realizadas al crear esta base se registra en
[verificación inicial](verificacion-inicial.md). Las pruebas físicas siguen pendientes
hasta disponer de dispositivos y builds firmados.
