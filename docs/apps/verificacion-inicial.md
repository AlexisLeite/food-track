# Verificación inicial

Fecha: 2026-11-25. Entorno: Windows, Node 22.14.0, npm 10.9.2.
Proyecto: `apps/mobile/`, Expo 58.0.26, React Native 0.88.1, WebView 14.0.1.

| Comprobación ejecutada | Resultado |
| --- | --- |
| Instalación de dependencias móviles | Aprobada; lockfile independiente generado. |
| `npm run typecheck` | Aprobado. |
| `npm run lint` | Aprobado. |
| `npx expo-doctor` | 20/20 comprobaciones aprobadas. |
| `npx expo install --check` | Dependencias compatibles con el SDK. |
| `npx expo config --type public` | Configuración resuelta para Android/iOS. |
| `npx expo export --platform android --platform ios` | Ambos bundles generados en `apps/mobile/dist/`, ignorado por Git. |
| `git diff --exit-code` | Sin modificaciones a archivos previamente versionados. |

Para exportar se definió `EXPO_PUBLIC_APP_URL=https://comida.gim.uy` solo en el proceso
de compilación. Exportar no abre la web ni ejecuta operaciones contra el servidor.
No se creó una cuenta Expo, no se generaron APK/IPA/AAB, no se publicaron artefactos
y no se modificó el despliegue existente.

## Avisos

`npm audit` informa tres entradas moderadas en la cadena Expo → `@expo/fingerprint`
→ `minimatch`: corresponden al aviso
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
El arreglo automático propuesto por npm cambia Expo a una versión mayor anterior;
no se aplicó `npm audit fix --force`. Revisar actualizaciones compatibles del SDK
antes de distribuir. La instalación también informa deprecación de ESLint 9.39.5,
versión resuelta por el instalador del SDK; lint funciona correctamente.

Metro emitió avisos de coexistencia de `NO_COLOR` y `FORCE_COLOR`; no impidieron la exportación.

## Pendiente

El usuario confirmó que la app abrió en Expo Go; Metro registró la carga iOS.
Se utilizó un túnel de Expo con sesión iniciada en la PC y la misma cuenta en Expo Go.
Esto valida la apertura inicial del contenedor, no el checklist completo de
[testing](testing.md). Los permisos reales, captura/subida de fotos, audio,
sesiones y comportamiento del teclado siguen pendientes. Los íconos son temporales
y la identidad de distribución debe confirmarse antes de firmar builds.
