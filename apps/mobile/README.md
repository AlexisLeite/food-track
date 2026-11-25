# Comida móvil

Contenedor Android/iOS con Expo, React Native y WebView. La interfaz y el backend
siguen siendo los de la web existente. Este directorio tiene dependencias y lockfile
propios: ejecutar todos sus comandos desde `apps/mobile`, sin instalar nada en la raíz.

## Inicio rápido (PowerShell)

```powershell
cd C:\Development\dev\food-track\apps\mobile
npm ci
Copy-Item .env.example .env.local
# Editar .env.local para elegir la URL HTTPS del entorno deseado.
npx expo start --go
```

La URL de ejemplo es producción (`https://comida.gim.uy`): usar una cuenta de pruebas
o un entorno separado para evitar alterar datos reales. El contenedor exige HTTPS,
sin usuario/contraseña en la URL. Las variables `EXPO_PUBLIC_*` son públicas y se
incluyen en el binario. Nunca copiar aquí el `.env` del servidor.

Expo Go permite una primera comprobación de la WebView si soporta el SDK instalado.
En iPhone, iniciar sesión con la misma cuenta en Expo Go y en la PC (`npx expo login`).
Si la red local bloquea la conexión, usar `npx expo start --go --tunnel`; con sesión
iniciada genera un enlace de túnel de Expo. Mantener la terminal abierta durante la prueba.
Validar permisos, sesiones y distribución con un build propio; Expo Go no reproduce
la configuración nativa de esta app. No ejecutar `npm run web`: la web sigue en la raíz
del repositorio y WebView es el contenedor móvil.

```powershell
npm run typecheck
npm run lint
npx expo-doctor
```

## Comportamiento

- URL configurable mediante `EXPO_PUBLIC_APP_URL`; sin valor válido se muestra una indicación.
- Pantalla de carga, error de navegación/HTTP y reintento.
- Navegación del mismo origen dentro de la app; enlaces externos en el navegador.
- Ventanas nuevas (`target="_blank"`) se abren fuera del contenedor.
- Botón atrás de Android usa el historial de la WebView y sale al llegar al inicio.
- Sesiones y almacenamiento administrados por la propia WebView; el login se hace en ella.
- Permisos declarados para cámara/micrófono y textos de uso para iOS.

No incluye el servidor, PostgreSQL, Python ni Codex CLI dentro del teléfono. Necesita
conectividad al servidor y no agrega un modo offline nativo. No agrega rutas ni
pantallas de navegación nativa: la navegación pertenece a la web existente.

## Documentación

- [Empaquetado y firma](../../docs/apps/empaquetado.md)
- [Testing y registro de resultados](../../docs/apps/testing.md)

Los identificadores `uy.gim.comida` son una propuesta inicial: confirmar titularidad
y disponibilidad antes del primer build de distribución. Los íconos de Expo incluidos
son temporales y deben reemplazarse antes de publicar. No se ha vinculado ninguna
cuenta de Expo, generado credenciales ni publicado en tiendas.
