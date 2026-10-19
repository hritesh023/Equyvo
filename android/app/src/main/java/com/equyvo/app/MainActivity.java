package com.equyvo.app;

import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // v1.0.1 layout contract:
        // • ALL clearance is owned by the WEB layer (fixed CSS floors:
        //   48px top / 28px bottom). The native layer adds NO padding at all.
        // • System-bar + display-cutout insets are zeroed downstream so
        //   Capacitor's SystemBars CSS injection / parent padding cannot
        //   double-apply on top of the web floors.
        // • IME (keyboard) insets pass through INTACT for Capacitor's own
        //   keyboard handling.
        // • Bottom: no native pad — the WebView reaches the physical bottom
        //   edge; the web layer's fixed 28px footer pad sits inside it.
        final View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, windowInsets) ->
                new WindowInsetsCompat.Builder(windowInsets)
                        .setInsets(
                                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                                Insets.of(0, 0, 0, 0))
                        .build());
    }
}
