import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

function getAppUrl(): URL | null {
  try {
    const url = new URL(process.env.EXPO_PUBLIC_APP_URL ?? '');
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

const appUrl = getAppUrl();

async function openExternal(url: string) {
  try {
    if (!['https:', 'http:', 'mailto:', 'tel:'].includes(new URL(url).protocol)) return;
    await Linking.openURL(url);
  } catch {
    Alert.alert('No se pudo abrir el enlace', 'Volvé a intentarlo desde el navegador.');
  }
}

function MobileApp() {
  // WebView's default generic is undefined; supply object for TypeScript 6.
  const webView = useRef<WebView<object>>(null);
  const canGoBack = useRef(false);
  const currentUrl = useRef(appUrl?.href);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!failed && canGoBack.current) {
        webView.current?.goBack();
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [failed]);

  if (!appUrl) {
    return <View style={styles.message}>
      <Text accessibilityRole="header" style={styles.title}>Falta configurar la dirección</Text>
      <Text style={styles.text}>Definí EXPO_PUBLIC_APP_URL con la URL HTTPS de Comida y reiniciá Expo.</Text>
    </View>;
  }

  if (failed) {
    return <View style={styles.message}>
      <Text accessibilityRole="header" style={styles.title}>No pudimos cargar Comida</Text>
      <Text style={styles.text}>Revisá tu conexión y volvé a intentarlo.</Text>
      <Pressable accessibilityRole="button" style={styles.button} onPress={() => {
        canGoBack.current = false;
        currentUrl.current = appUrl.href;
        setAttempt(value => value + 1);
        setFailed(false);
      }}>
        <Text style={styles.buttonText}>Reintentar</Text>
      </Pressable>
    </View>;
  }

  return <WebView<object>
    key={attempt}
    ref={webView}
    style={styles.webView}
    source={{ uri: appUrl.href }}
    // Route every scheme through our handler instead of WebView's implicit Linking fallback.
    originWhitelist={['*']}
    onShouldStartLoadWithRequest={request => {
      if (request.isTopFrame === false) return true;
      try {
        if (new URL(request.url).origin === appUrl.origin) return true;
      } catch {
        return false;
      }
      void openExternal(request.url);
      return false;
    }}
    onOpenWindow={({ nativeEvent }) => { void openExternal(nativeEvent.targetUrl); }}
    onLoadStart={({ nativeEvent }) => { currentUrl.current = nativeEvent.url; }}
    onNavigationStateChange={state => { canGoBack.current = state.canGoBack; }}
    onError={() => setFailed(true)}
    onHttpError={({ nativeEvent }) => {
      if (nativeEvent.url === currentUrl.current) setFailed(true);
    }}
    onContentProcessDidTerminate={() => setFailed(true)}
    onRenderProcessGone={() => setFailed(true)}
    startInLoadingState
    renderLoading={() => <View style={styles.loading}>
      <ActivityIndicator size="large" color="#90cfaa" accessibilityLabel="Cargando Comida" />
    </View>}
    javaScriptEnabled
    domStorageEnabled
    thirdPartyCookiesEnabled={false}
    allowFileAccess={false}
    mixedContentMode="never"
    allowsInlineMediaPlayback
    mediaCapturePermissionGrantType="prompt"
  />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <MobileApp />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#161616' },
  webView: { flex: 1, backgroundColor: '#161616' },
  message: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 16 },
  title: { color: '#fff', fontSize: 22, fontWeight: '600', textAlign: 'center' },
  text: { color: '#ccc', fontSize: 16, textAlign: 'center' },
  button: { backgroundColor: '#90cfaa', borderRadius: 10, minHeight: 48, paddingHorizontal: 24, justifyContent: 'center' },
  buttonText: { color: '#161616', fontSize: 16, fontWeight: '600' },
  loading: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: '#161616', justifyContent: 'center', alignItems: 'center' },
});
