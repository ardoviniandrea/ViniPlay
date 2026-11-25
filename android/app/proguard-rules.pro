# Keep JavaScriptInterface methods
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.viniplay.app.** { *; }
