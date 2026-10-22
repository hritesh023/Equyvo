# ─────────────────────────────────────────────────────────────────────────────
# Equyvo release R8 configuration (AGP 8.13 line)
# Production build uses full R8: shrink (minifyEnabled) + optimize + obfuscate.
# The WebView JS↔native Capacitor bridge is REFLECTION-based, so every entry
# point the bridge can touch is kept explicitly below. Everything else is
# dead-code-eliminated, optimized and renamed — this is what lifts the Play
# Console obfuscation/size metrics away from "1% obfuscated".
# ─────────────────────────────────────────────────────────────────────────────

# Annotation metadata the Capacitor / AdMob / Cordova runtimes reflect on.
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations,RuntimeVisibleTypeAnnotations,AnnotationDefault,Signature,InnerClasses,EnclosingMethod,Exceptions,Deprecated

# Real line numbers on release crash traces (uploaded Play traces stay debuggable).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# ── Capacitor WebView bridge ────────────────────────────────────────────────
-keep class com.getcapacitor.** { *; }
-keep public class * extends com.getcapacitor.Plugin { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * { *; }
-keep public class com.equyvo.app.MainActivity { *; }

# JS-exposed bridge methods can never be renamed or stripped.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ── AdMob + UMP (user messaging) ────────────────────────────────────────────
# The SDK ships its own R8 rules; these guard the reflection-heavy surfaces.
-keep class com.google.android.gms.ads.** { public protected *; }
-keep class com.google.android.ump.** { public protected *; }
-keep class com.getcapacitor.community.admob.** { *; }

# ── Noise silencing (optional/condo dependencies referenced reflectively) ───
-dontwarn javax.annotation.**
-dontwarn javax.naming.**
-dontwarn org.apache.http.**
