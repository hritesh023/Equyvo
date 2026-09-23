import type { CapacitorConfig } from '@capacitor/cli';

// Live-reload URL is DEV ONLY. Release builds must load the bundled dist/;
// leaving `server.url` set ships an app that points at the phone's own
// localhost and renders nothing on real devices.
const isDev = process.env.NODE_ENV !== 'production' && !process.env.CAPACITOR_RELEASE;

const config: CapacitorConfig = {
  appId: 'com.equyvo.app',
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
    webContentsDebuggingEnabled: true,
    backgroundColor: '#000000'
  },
  ios: {
    scrollEnabled: true,
    backgroundColor: '#000000'
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 3000,
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
