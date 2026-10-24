import type { CapacitorConfig } from '@capacitor/cli';

// Live-reload URL is DEV ONLY. Release builds must load the bundled dist/;
// leaving `server.url` set ships an app that points at the phone's own
// localhost and renders nothing on real devices.
// Production-safe by default. Dev live-reload only when explicitly opted in
// via CAPACITOR_DEV=1, so a normal `npx cap sync` always ships bundled dist/.
const isDev = process.env.CAPACITOR_DEV === '1' || process.env.CAPACITOR_DEV === 'true';

const config: CapacitorConfig = {
  appId: 'equyvo.acronous.com',
  appName: 'Equyvo',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    iosScheme: 'https',
    ...(isDev
      ? {
          url: 'http://localhost:3000',
          cleartext: true,
        }
      : {}),
    allowNavigation: ['*']
  },
  android: {
    allowMixedContent: true,
    captureInput: true,
    webContentsDebuggingEnabled: isDev,
    backgroundColor: '#000000'
  },
  ios: {
    scrollEnabled: true,
    backgroundColor: '#000000'
  },
  plugins: {
    // Play Console Android-15 guidance (SDK 35+ target): the app handles
    // window insets itself — MainActivity.enableEdgeToEdge() + a real
    // ViewCompat insets listener forward measured system-bar/cutout insets
    // as --native-safe-top/bottom, which the web CSS consumes (globals.css).
    // Capacitor's own --safe-area-inset-* injection is therefore redundant:
    // disable it so the app has ONE deterministic insets source of truth on
    // Android 15 edge-to-edge, on every device class.
    SystemBars: {
      insetsHandling: 'disable',
    },
    SplashScreen: {
      // Native splash is disabled in favour of the in-app web splash
      // (SplashScreen.tsx), which carries the real logo and loading bar.
      // Keeping a native splash here caused a stale "bad header" overlay
      // above the WebView on Android. Auto-hide immediately, no dialog.
      launchShowDuration: 0,
      launchAutoHide: true,
      backgroundColor: '#000000',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
      useDialog: false,
      launchFadeOutDuration: 0
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0a0a0a',
      overlaysWebView: false
    },
    Keyboard: {
      resize: 'ionic'
    },
    App: {
      appendUserAgent: 'EquyvoApp/1.0',
      allowNavigation: ['*']
    }
  }
};

export default config;
