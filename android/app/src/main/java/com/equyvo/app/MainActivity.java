package com.equyvo.app;

import com.getcapacitor.BridgeActivity;

/**
 * Plain Capacitor activity. Safe-area handling (status bar / gesture bar
 * insets under Android 15/16 edge-to-edge) is owned entirely by the web
 * layer: Capacitor's SystemBars plugin injects --safe-area-inset-* CSS
 * variables, and Equyvo's CSS app-wide derives --equyvo-safe-* from them.
 * A native Content-view padding here would double-pad on top of that.
 */
public class MainActivity extends BridgeActivity {}
