# Empaquetado de Comida móvil

## Alcance y requisitos

Proyecto independiente en `apps/mobile/`, con Expo + React Native + WebView para
Android e iOS. No cambia la instalación ni el despliegue de la web. El binario carga
una URL HTTPS: no contiene el backend ni una copia de los recursos web.

Requiere una versión de Node compatible con el SDK y las dependencias instaladas
(consultar `engines` y avisos de `npm ci`), npm y acceso al servidor web. Usar el lockfile
local a `apps/mobile/`. Para builds remotos se necesita una cuenta Expo. Para probar
Android localmente se necesita Android Studio/SDK y Java compatibles; para compilar
iOS localmente se necesita macOS con Xcode. Desde Windows se pueden solicitar builds
iOS remotos con EAS.

Para distribuir iOS en dispositivos mediante firma ad hoc/TestFlight se requieren
credenciales Apple apropiadas; para publicar en Google Play, una cuenta Play Console.
EAS puede administrar las credenciales o recibir las del titular. No guardarlas en Git.

## Preparación local

Todos los comandos siguientes se ejecutan dentro de `apps/mobile/`:

```powershell
npm ci
Copy-Item .env.example .env.local
# Editar EXPO_PUBLIC_APP_URL en .env.local.
npm run typecheck
npm run lint
npx expo-doctor
npx expo start --go
```

La URL debe ser HTTPS con certificado válido y accesible desde el teléfono. Para
desarrollo usar un entorno HTTPS de pruebas o un túnel configurado explícitamente
para el servidor. `localhost` en el teléfono no representa esta PC. El túnel de Metro
no expone automáticamente el backend. Conservar `APP_ORIGIN` y cookies del servidor
coherentes con el origen utilizado; no hace falta cambiar CORS para envolver el sitio.

## Identidad y permisos

Revisar `app.json` antes de distribuir:

- Nombre `Comida`, slug `foodtrack-mobile` e identificadores propuestos `uy.gim.comida`.
- Versión visible, actualmente `1.0.0`. EAS administra los números internos con
  `appVersionSource: remote` y los incrementa en el perfil de producción.
- Reemplazar los íconos temporales de Expo por íconos propios adecuados para cada plataforma.
- Cámara y micrófono en Android; descripciones de cámara, micrófono y fotos en iOS.
- La declaración de cifrado iOS presupone solo el cifrado estándar HTTPS; revisarla
  si se incorpora criptografía adicional.

La WebView solicita los permisos al utilizar las funciones web. Verificar concesión,
rechazo y revocación en binarios propios. Los cambios de permisos/configuración nativa
requieren recompilar. No crear `android/` o `ios/` manualmente: Expo los genera.

## Vincular Expo y configurar ambientes (una vez)

Estos pasos son manuales del titular del proyecto; todavía no se ejecutaron:

```powershell
npx eas-cli@latest login
npx eas-cli@latest init
```

`init` vincula el proyecto y agrega su identificador real a la configuración. Revisar
ese cambio antes de guardarlo. No inventar un `projectId` ni reutilizar el de otra app.

Configurar `EXPO_PUBLIC_APP_URL` en cada ambiente de Expo, por panel o CLI. Ejemplo
para producción (el valor queda público dentro de la app):

```powershell
npx eas-cli@latest env:set --name EXPO_PUBLIC_APP_URL --value https://comida.gim.uy --environment production --visibility plaintext
```

Repetir para `development` y `preview` con la URL HTTPS de pruebas elegida. El archivo
`.env.local` sirve para desarrollo local: no confiar en él para builds remotos. No
guardar contraseñas, claves de servidor ni credenciales Codex en variables públicas.

## Perfiles y artefactos

| Perfil | Uso | Android | iOS |
| --- | --- | --- | --- |
| `development` | Desarrollo con Metro | Cliente de desarrollo | Cliente de desarrollo con firma interna |
| `preview` | QA sin Metro | APK instalable | Build interno ad hoc, dispositivos registrados |
| `production` | Preparación para tiendas | AAB | Build para App Store/TestFlight |

```powershell
npx eas-cli@latest build --platform android --profile development
npx eas-cli@latest build --platform android --profile preview
npx eas-cli@latest build --platform ios --profile preview
npx eas-cli@latest build --platform android --profile production
npx eas-cli@latest build --platform ios --profile production
```

Para el cliente de desarrollo ejecutar `npm run start:dev-client` y abrir el build
instalado. Para preview Android descargar el APK desde el resultado del build e
instalarlo en el dispositivo; el AAB es para Play Console, no para instalación directa.
Para preview iOS registrar previamente los dispositivos mediante
`npx eas-cli@latest device:create`, según indique EAS.

Los builds remotos pueden tener costos o límites de cuenta. Generar un build no lo
publica automáticamente. Tras aprobar el checklist de testing, el titular podrá
subir el artefacto a Play Console/App Store Connect o usar EAS Submit. No hay
publicación automática configurada en este repositorio.

## Actualizaciones y salida a tiendas

Cambios en la web se ven al cargar el contenido del servidor (sujetos a su caché).
Cambios en `App.tsx`, URL embebida, íconos o permisos requieren un nuevo build; no se
configuró Expo Update. Probar tanto instalación limpia como actualización conservando
sesión, y registrar versión, commit, ambiente y resultado de QA.

Antes de enviar a revisión preparar política de privacidad, capturas, textos de
tienda, declaraciones de datos y acceso de revisión. La aceptación de un contenedor
WebView debe evaluarse con los requisitos vigentes de cada tienda; no está garantizada.

## Referencias

- [WebView en Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/sdk/webview/)
- [Configuración Expo](https://docs.expo.dev/versions/v58.0.0/config/app/)
- [Builds](https://docs.expo.dev/build/introduction/)
- [Ambientes y variables](https://docs.expo.dev/eas/environment-variables/)
- [Permisos](https://docs.expo.dev/guides/permissions/)
