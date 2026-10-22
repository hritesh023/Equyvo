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
    SplashScreen: {
      // Handoff timing: the web splash (SplashScreen.tsx) runs 1.5s + 0.3s
      // fade. The native splash auto-hides at exactly 1800ms so the launch
      // logo is shown ONCE in one continuous piece — never a second logo
      // popping after the first.
      launchShowDuration: 1800,
      launchAutoHide: true,
      backgroundColor: '#000000',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: true,
      spinnerStyle: 'default',
      spinnerColor: '#999999',
      splashFullScreen: true,
      splashImmersive: true,
      layoutName: 'launch_screen',
      useDialog: true,
      launchFadeOutDuration: 500
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
