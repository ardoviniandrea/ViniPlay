package com.viniplay.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.text.InputType
import android.util.Rational
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import org.json.JSONObject
import kotlin.math.abs

class MainActivity : AppCompatActivity() {

    companion object {
        private const val ACTION_PIP_CONTROL = "com.viniplay.app.ACTION_PIP_CONTROL"
        private const val EXTRA_PIP_CMD = "pip_cmd"
        private const val CMD_PLAY_PAUSE = 1
        private const val CMD_AUDIO_ONLY = 2
        private const val REQ_POST_NOTIFICATIONS = 1001
    }

    private lateinit var rootContainer: FrameLayout
    private lateinit var webView: ViniWebView
    private lateinit var connectionErrorOverlay: LinearLayout
    private lateinit var fullscreenCustomViewContainer: FrameLayout

    private var customFullscreenView: View? = null
    private var customFullscreenCallback: WebChromeClient.CustomViewCallback? = null
    @Volatile
    private var lastVideoContentRect: Rect? = null

    private val uiHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var isWebVideoActive: Boolean = false
    @Volatile
    private var isWebVideoPlaying: Boolean = false
    @Volatile
    private var isWebAudioOnly: Boolean = false
    @Volatile
    private var audioOnlyTransitionUntilMs: Long = 0L
    @Volatile
    private var currentWebMediaTitle: String = "ViniPlay"
    @Volatile
    private var currentWebMediaSubtitle: String = ""
    @Volatile
    private var currentWebArtworkUrl: String = ""
    @Volatile
    private var currentWebDurationMs: Long = -1L
    @Volatile
    private var currentWebSeekable: Boolean = false
    @Volatile
    private var lastReportedPositionMs: Long = 0L
    @Volatile
    private var lastReportedPositionWallMs: Long = 0L

    /**
     * Custom WebView subclass that keeps Chromium's document visibility state active
     * even when the app enters Picture-in-Picture, background, or screen-lock mode.
     * This prevents Chromium from auto-pausing `<video>`, `mpegts.js`, `Hls.js`, or Multi-View streams.
     */
    private inner class ViniWebView(context: Context) : WebView(context) {
        override fun onWindowVisibilityChanged(visibility: Int) {
            super.onWindowVisibilityChanged(View.VISIBLE)
        }

        override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
            super.onWindowFocusChanged(true)
        }
    }

    private val pipReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != ACTION_PIP_CONTROL) return
            when (intent.getIntExtra(EXTRA_PIP_CMD, 0)) {
                CMD_PLAY_PAUSE -> {
                    webView.evaluateJavascript(
                        "if (window.__viniAndroidTogglePlayPause) window.__viniAndroidTogglePlayPause();",
                        null
                    )
                }
                CMD_AUDIO_ONLY -> {
                    // Mark Audio-Only immediately BEFORE dismissing PiP so surface teardown neither stops nor pauses VODs
                    exitCustomFullscreenIfActive()
                    isWebAudioOnly = true
                    audioOnlyTransitionUntilMs = System.currentTimeMillis() + 6500L
                    updateKeepScreenOnFlag()
                    updatePipParams()
                    webView.evaluateJavascript(
                        "if (window.__viniAndroidEnableAudioOnly) window.__viniAndroidEnableAudioOnly();",
                        null
                    )
                    uiHandler.postDelayed({
                        moveTaskToBack(true)
                        val resumeJs = "if (window.__viniAndroidResumeAudioOnlyIfPaused) window.__viniAndroidResumeAudioOnlyIfPaused();"
                        uiHandler.postDelayed({ webView.evaluateJavascript(resumeJs, null) }, 150)
                        uiHandler.postDelayed({ webView.evaluateJavascript(resumeJs, null) }, 450)
                        uiHandler.postDelayed({ webView.evaluateJavascript(resumeJs, null) }, 1200)
                        uiHandler.postDelayed({ webView.evaluateJavascript(resumeJs, null) }, 5300)
                    }, 80)
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ViniLogger.init(this)
        ViniLogger.log("LIFECYCLE", "MainActivity onCreate (WebView-native player mode)")

        buildUi()
        setContentView(rootContainer)

        val filter = IntentFilter(ACTION_PIP_CONTROL)
        ContextCompat.registerReceiver(
            this,
            pipReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )

        ViniPlaybackService.onRemoteAction = { action ->
            uiHandler.post {
                when (action) {
                    ViniPlaybackService.ACTION_PLAY -> {
                        webView.evaluateJavascript("if (window.__viniAndroidPlay) window.__viniAndroidPlay();", null)
                    }
                    ViniPlaybackService.ACTION_PAUSE -> {
                        webView.evaluateJavascript("if (window.__viniAndroidPause) window.__viniAndroidPause();", null)
                    }
                    ViniPlaybackService.ACTION_PLAY_PAUSE -> {
                        webView.evaluateJavascript("if (window.__viniAndroidTogglePlayPause) window.__viniAndroidTogglePlayPause();", null)
                    }
                    ViniPlaybackService.ACTION_STOP -> {
                        exitCustomFullscreenIfActive()
                        audioOnlyTransitionUntilMs = 0L
                        isWebAudioOnly = false
                        webView.evaluateJavascript("if (window.__viniAndroidStopPlayback) window.__viniAndroidStopPlayback();", null)
                    }
                }
            }
        }

        ViniPlaybackService.onRemoteSeekMs = { posMs ->
            uiHandler.post {
                val targetSeconds = posMs / 1000.0
                webView.evaluateJavascript(
                    "if (window.__viniAndroidSeekTo) window.__viniAndroidSeekTo($targetSeconds);",
                    null
                )
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (customFullscreenView != null) {
                    exitCustomFullscreenIfActive()
                    return
                }
                webView.evaluateJavascript(
                    "(function() { " +
                        "if (document.fullscreenElement || document.webkitFullscreenElement) { " +
                            "if (document.exitFullscreen) document.exitFullscreen(); " +
                            "else if (document.webkitExitFullscreen) document.webkitExitFullscreen(); " +
                            "return 'fullscreen'; " +
                        "} " +
                        "var vm = document.getElementById('video-modal'); " +
                        "if (vm && !vm.classList.contains('hidden')) { " +
                            "if (vm.classList.contains('player-locked')) return 'locked'; " +
                            "var closeBtn = document.getElementById('close-modal'); " +
                            "if (closeBtn) closeBtn.click(); " +
                            "return 'closed_modal'; " +
                        "} " +
                        "var pm = document.getElementById('program-details-modal'); " +
                        "if (pm && !pm.classList.contains('hidden')) { " +
                            "var pClose = document.getElementById('details-close-btn'); " +
                            "if (pClose) pClose.click(); " +
                            "return 'closed_details'; " +
                        "} " +
                        "return 'none'; " +
                    "})()"
                ) { result ->
                    val clean = result?.trim('"') ?: "none"
                    when (clean) {
                        "locked" -> Toast.makeText(this@MainActivity, "🔒 Player is locked", Toast.LENGTH_SHORT).show()
                        "fullscreen", "closed_modal", "closed_details" -> { /* Handled in WebView */ }
                        else -> {
                            if (webView.canGoBack()) {
                                webView.goBack()
                            } else {
                                moveTaskToBack(true)
                            }
                        }
                    }
                }
            }
        })

        requestNotificationPermissionIfNeeded()

        val savedUrl = ViniLogger.getServerUrl(this)
        if (savedUrl.isEmpty()) {
            showServerUrlDialog(isInitialSetup = true)
        } else {
            loadViniPlayServer(savedUrl)
        }

        handleDeepLinkIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        ViniLogger.log("LIFECYCLE", "MainActivity onNewIntent (resuming existing instance)")
        handleDeepLinkIntent(intent)
    }

    private fun handleDeepLinkIntent(intent: Intent?) {
        if (intent == null) return
        val channelId = intent.getStringExtra("navigate_channel_id")
        val programStart = intent.getStringExtra("navigate_program_start")
        val programId = intent.getStringExtra("navigate_program_id")
        if (!channelId.isNullOrEmpty()) {
            intent.removeExtra("navigate_channel_id")
            intent.removeExtra("navigate_program_start")
            intent.removeExtra("navigate_program_id")
            ViniLogger.log("LIFECYCLE", "Deep-linking to program reminder: channel=$channelId, program=$programId")
            uiHandler.postDelayed({
                val safeChan = JSONObject.quote(channelId)
                val safeStart = JSONObject.quote(programStart ?: "")
                val safeProg = JSONObject.quote(programId ?: "")
                webView.evaluateJavascript(
                    "if (window.__viniAndroidNavigateToProgram) { window.__viniAndroidNavigateToProgram($safeChan, $safeStart, $safeProg); }",
                    null
                )
            }, 600)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildUi() {
        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density).toInt()

        rootContainer = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0F172A"))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        // 1. Persistent ViniWebView (uses 100% of the browser's player, EPG, and VOD logic)
        webView = ViniWebView(this).apply {
            setBackgroundColor(Color.parseColor("#0F172A"))
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                cacheMode = WebSettings.LOAD_DEFAULT
                useWideViewPort = true
                loadWithOverviewMode = true
                setSupportZoom(false)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    offscreenPreRaster = true
                }
                userAgentString = "$userAgentString ViniPlayAndroid/1.0"
            }

            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

            addJavascriptInterface(ViniJsBridge(), "ViniAndroid")

            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    ViniLogger.updateActiveOriginFromWebView(url)
                    injectAndroidRuntimeBridge(view)
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    CookieManager.getInstance().flush()
                    ViniLogger.updateActiveOriginFromWebView(url)
                    injectAndroidRuntimeBridge(view)
                    ViniLogger.flushNow()
                    connectionErrorOverlay.visibility = View.GONE
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?
                ) {
                    super.onReceivedError(view, request, error)
                    if (request?.isForMainFrame == true) {
                        ViniLogger.log("WEBVIEW", "Main frame load error: ${error?.description}", request.url?.toString())
                        connectionErrorOverlay.visibility = View.VISIBLE
                    }
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                    if (customFullscreenView != null) {
                        callback?.onCustomViewHidden()
                        return
                    }
                    customFullscreenView = view
                    customFullscreenCallback = callback
                    if (view != null) {
                        fullscreenCustomViewContainer.addView(
                            view,
                            FrameLayout.LayoutParams(
                                FrameLayout.LayoutParams.MATCH_PARENT,
                                FrameLayout.LayoutParams.MATCH_PARENT
                            )
                        )
                        fullscreenCustomViewContainer.visibility = View.VISIBLE
                        hideSystemBars(true)
                        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    }
                }

                override fun onHideCustomView() {
                    exitCustomFullscreenIfActive()
                }

                override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                    if (consoleMessage != null) {
                        val msg = consoleMessage.message() ?: ""
                        val lvl = consoleMessage.messageLevel()
                        if (lvl == ConsoleMessage.MessageLevel.ERROR ||
                            msg.contains("[PLAYER]") ||
                            msg.contains("[VOD_PLAYER]") ||
                            msg.contains("[MULTIVIEW]") ||
                            msg.contains("[ANDROID]")
                        ) {
                            ViniLogger.log("WEBVIEW", msg, "${consoleMessage.sourceId()}:${consoleMessage.lineNumber()}")
                        }
                    }
                    return super.onConsoleMessage(consoleMessage)
                }
            }
        }
        rootContainer.addView(webView)

        // 2. HTML5 Fullscreen Container (for container.requestFullscreen() inside WebView)
        fullscreenCustomViewContainer = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        rootContainer.addView(fullscreenCustomViewContainer)

        // 3. Connection Error / Server Settings Overlay
        connectionErrorOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#0F172A"))
            setPadding(dp(24), dp(24), dp(24), dp(24))
            visibility = View.GONE

            val title = TextView(this@MainActivity).apply {
                text = "Cannot Reach ViniPlay Server"
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
                setTypeface(typeface, Typeface.BOLD)
                gravity = Gravity.CENTER
            }
            val sub = TextView(this@MainActivity).apply {
                text = "Check that your ViniPlay server is running and your phone is connected to the network."
                setTextColor(Color.parseColor("#94A3B8"))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                gravity = Gravity.CENTER
                setPadding(0, dp(8), 0, dp(20))
            }
            val btnRow = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
            }
            val retryBtn = Button(this@MainActivity).apply {
                text = "Retry"
                setBackgroundColor(Color.parseColor("#2563EB"))
                setTextColor(Color.WHITE)
                setOnClickListener {
                    connectionErrorOverlay.visibility = View.GONE
                    webView.reload()
                }
            }
            val changeServerBtn = Button(this@MainActivity).apply {
                text = "Change Server"
                setBackgroundColor(Color.parseColor("#334155"))
                setTextColor(Color.WHITE)
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { leftMargin = dp(12) }
                layoutParams = lp
                setOnClickListener {
                    showServerUrlDialog(isInitialSetup = false)
                }
            }
            btnRow.addView(retryBtn)
            btnRow.addView(changeServerBtn)
            addView(title)
            addView(sub)
            addView(btnRow)
        }
        rootContainer.addView(
            connectionErrorOverlay,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
    }

    private fun exitCustomFullscreenIfActive() {
        val view = customFullscreenView
        if (view != null) {
            fullscreenCustomViewContainer.removeView(view)
            fullscreenCustomViewContainer.visibility = View.GONE
            customFullscreenView = null
            val cb = customFullscreenCallback
            customFullscreenCallback = null
            try {
                cb?.onCustomViewHidden()
            } catch (_: Exception) {}
            hideSystemBars(false)
        }
        if (requestedOrientation != ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED) {
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    private fun hideSystemBars(hide: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val controller = window.insetsController ?: return
            if (hide) {
                controller.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else {
                controller.show(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
            }
        } else {
            @Suppress("DEPRECATION")
            if (hide) {
                window.decorView.systemUiVisibility = (
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        or View.SYSTEM_UI_FLAG_FULLSCREEN
                        or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                )
            } else {
                window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
            }
        }
    }

    // --- Picture-in-Picture (PiP) Support ---

    private fun buildPipParams(): PictureInPictureParams {
        val builder = PictureInPictureParams.Builder()
            .setAspectRatio(Rational(16, 9))

        val playPauseIcon = Icon.createWithResource(
            this,
            if (isWebVideoPlaying) R.drawable.ic_pip_pause else R.drawable.ic_pip_play
        )
        val playPausePi = PendingIntent.getBroadcast(
            this,
            101,
            Intent(ACTION_PIP_CONTROL).setPackage(packageName).putExtra(EXTRA_PIP_CMD, CMD_PLAY_PAUSE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val playPauseAction = RemoteAction(
            playPauseIcon,
            if (isWebVideoPlaying) "Pause" else "Play",
            "Toggle playback",
            playPausePi
        )

        val audioOnlyIcon = Icon.createWithResource(this, R.drawable.ic_pip_headphones)
        val audioOnlyPi = PendingIntent.getBroadcast(
            this,
            102,
            Intent(ACTION_PIP_CONTROL).setPackage(packageName).putExtra(EXTRA_PIP_CMD, CMD_AUDIO_ONLY),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val audioOnlyAction = RemoteAction(
            audioOnlyIcon,
            "Audio Only",
            "Continue listening in background audio-only mode",
            audioOnlyPi
        )

        builder.setActions(listOf(playPauseAction, audioOnlyAction))

        if (!isInPictureInPictureMode && customFullscreenView == null) {
            val hint = lastVideoContentRect
            if (hint != null &&
                hint.width() > 60 &&
                hint.height() > 60 &&
                hint.left >= 0 &&
                hint.top >= 0 &&
                webView.width > 0 &&
                webView.height > 0 &&
                hint.right <= webView.width &&
                hint.bottom <= webView.height
            ) {
                builder.setSourceRectHint(hint)
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val shouldAutoPip = isWebVideoActive && !isWebAudioOnly && (System.currentTimeMillis() >= audioOnlyTransitionUntilMs)
            builder.setAutoEnterEnabled(shouldAutoPip)
            builder.setSeamlessResizeEnabled(true)
        }
        return builder.build()
    }

    private fun updatePipParams() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                setPictureInPictureParams(buildPipParams())
            } catch (_: Exception) {}
        }
    }

    private fun enterPipNow() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                isWebAudioOnly = false
                audioOnlyTransitionUntilMs = 0L
                val entered = enterPictureInPictureMode(buildPipParams())
                if (entered) {
                    webView.evaluateJavascript(
                        "if (window.__viniSetPipMode) window.__viniSetPipMode(true); else document.body.classList.add('android-pip-mode');",
                        null
                    )
                }
                ViniLogger.log("PIP", "enterPipNow invoked -> entered=$entered")
            } catch (e: Exception) {
                ViniLogger.log("PIP", "Failed to enter PiP", e.message)
            }
        }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!powerManager.isInteractive) {
            // Screen was locked directly — let audio continue in background without entering PiP
            return
        }

        val inAudioOnlyMode = isWebAudioOnly || (System.currentTimeMillis() < audioOnlyTransitionUntilMs)
        if (isWebVideoActive && !inAudioOnlyMode && !isInPictureInPictureMode) {
            enterPipNow()
        }
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: Configuration
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        val inAudioOnlyMode = isWebAudioOnly || (System.currentTimeMillis() < audioOnlyTransitionUntilMs)
        ViniLogger.log(
            "PIP",
            "onPictureInPictureModeChanged: $isInPictureInPictureMode (lifecycle=${lifecycle.currentState}, audioOnly=$inAudioOnlyMode)"
        )

        if (isInPictureInPictureMode) {
            webView.evaluateJavascript(
                "if (window.__viniSetPipMode) window.__viniSetPipMode(true); else document.body.classList.add('android-pip-mode');",
                null
            )
            updateKeepScreenOnFlag()
        } else {
            webView.evaluateJavascript(
                "if (window.__viniSetPipMode) window.__viniSetPipMode(false); else document.body.classList.remove('android-pip-mode');",
                null
            )

            if (inAudioOnlyMode) {
                // Transitioning from PiP to background Audio-Only: ensure VOD/Live audio stays uninterrupted
                webView.evaluateJavascript(
                    "if (window.__viniAndroidResumeAudioOnlyIfPaused) window.__viniAndroidResumeAudioOnlyIfPaused();",
                    null
                )
            } else {
                // Returning to full app OR closed via PiP 'X' button
                val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
                if (lifecycle.currentState == Lifecycle.State.CREATED && powerManager.isInteractive) {
                    ViniLogger.log("PIP", "User closed PiP window via X button — stopping playback")
                    exitCustomFullscreenIfActive()
                    webView.evaluateJavascript(
                        "if (window.__viniAndroidStopPlayback) window.__viniAndroidStopPlayback();",
                        null
                    )
                } else {
                    webView.evaluateJavascript(
                        "if (window.__viniAndroidEnsurePlayingAfterPip) window.__viniAndroidEnsurePlayingAfterPip();",
                        null
                    )
                }
            }
            updateKeepScreenOnFlag()
        }
    }

    private fun updateKeepScreenOnFlag() {
        val inAudioOnlyMode = isWebAudioOnly || (System.currentTimeMillis() < audioOnlyTransitionUntilMs)
        if ((isWebVideoActive && !inAudioOnlyMode) || isInPictureInPictureMode) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            webView.keepScreenOn = true
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            webView.keepScreenOn = false
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        webView.evaluateJavascript(
            "if (window.__viniAndroidEnsurePlayingAfterPip) window.__viniAndroidEnsurePlayingAfterPip();",
            null
        )
        updateKeepScreenOnFlag()
    }

    override fun onDestroy() {
        ViniPlaybackService.onRemoteAction = null
        ViniPlaybackService.onRemoteSeekMs = null
        ViniPlaybackService.stopPlaybackSession(this)
        try {
            unregisterReceiver(pipReceiver)
        } catch (_: Exception) {}
        super.onDestroy()
    }

    /**
     * Minimal, non-invasive runtime bridge injected into the WebView:
     * 1. Does NOT intercept or replace `playChannel`, `playVOD`, `mpegts.js`, `Hls.js`, or `<video>` —
     *    100% of playback uses the exact same ViniPlay web player (`player.js`, `vod.js`, `dvr.js`, `multiview.js`) as the browser.
     * 2. Polyfills `window.Notification` and `pushManager` so `#program-details-modal` opens and reminders sync to Android alarms.
     * 3. Keeps `document.visibilityState === 'visible'` and protects VOD Audio-Only transitions from surface-loss pauses.
     * 4. Reports rich metadata, artwork URL, and timeline position to `ViniPlaybackService` (`MediaSession` + `MediaStyle`).
     * 5. Ensures the "Change Server" button is available on the Login / Setup screen.
     * 6. Defers hidden Multi-View drawer logos and guards modal backdrop touch ghost-clicks.
     */
    private fun injectAndroidRuntimeBridge(view: WebView?) {
        val wv = view ?: return
        val script = """
            (function() {
                // 1. Polyfill window.Notification so guide.js openProgramDetails() never throws ReferenceError
                if (typeof window.Notification === 'undefined') {
                    window.Notification = function(title, options) {
                        this.title = title;
                        this.options = options || {};
                    };
                    window.Notification.permission = 'granted';
                    window.Notification.requestPermission = function(cb) {
                        if (window.ViniAndroid && typeof window.ViniAndroid.requestNotificationPermission === 'function') {
                            try { window.ViniAndroid.requestNotificationPermission(); } catch (e) {}
                        }
                        if (typeof cb === 'function') cb('granted');
                        return Promise.resolve('granted');
                    };
                }

                // 2. Polyfill ServiceWorkerRegistration.prototype.pushManager so "Notify Me" works in Android WebView
                if (typeof ServiceWorkerRegistration !== 'undefined' && !('pushManager' in ServiceWorkerRegistration.prototype)) {
                    try {
                        Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', {
                            configurable: true,
                            get: function() {
                                var fakeSub = {
                                    endpoint: 'https://android.native.viniplay/local-alarm',
                                    expirationTime: null,
                                    options: { userVisibleOnly: true },
                                    getKey: function() { return new ArrayBuffer(0); },
                                    toJSON: function() {
                                        return {
                                            endpoint: 'https://android.native.viniplay/local-alarm',
                                            keys: { p256dh: 'android', auth: 'android' }
                                        };
                                    },
                                    unsubscribe: function() { return Promise.resolve(true); }
                                };
                                return {
                                    getSubscription: function() { return Promise.resolve(fakeSub); },
                                    subscribe: function() { return Promise.resolve(fakeSub); },
                                    permissionState: function() { return Promise.resolve('granted'); }
                                };
                            }
                        });
                    } catch (e) {}
                }

                // 0. Always verify PiP full-bleed stylesheet is attached in <head> (survives cached onPageStarted <head> resets)
                function ensureAndroidPipStyles() {
                    try {
                        var existing = document.getElementById('vini-android-pip-styles');
                        if (existing && existing.parentNode) return;
                        var styleEl = document.createElement('style');
                        styleEl.id = 'vini-android-pip-styles';
                        styleEl.textContent = [
                            'body.android-pip-mode { overflow: hidden !important; background: #000 !important; }',
                            'body.android-pip-mode #video-modal:not(.hidden) {',
                            '  position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;',
                            '  padding: 0 !important; margin: 0 !important; background: #000 !important; z-index: 99999 !important;',
                            '}',
                            'body.android-pip-mode #video-modal:not(.hidden) #video-modal-container {',
                            '  position: fixed !important; inset: 0 !important; top: 0 !important; left: 0 !important;',
                            '  width: 100vw !important; height: 100vh !important; min-width: 100vw !important; min-height: 100vh !important;',
                            '  max-width: none !important; max-height: none !important; margin: 0 !important; padding: 0 !important;',
                            '  border: none !important; border-radius: 0 !important; transform: none !important; background: #000 !important;',
                            '}',
                            'body.android-pip-mode #video-modal:not(.hidden) #video-modal-header,',
                            'body.android-pip-mode #video-modal:not(.hidden) #vod-controls-overlay,',
                            'body.android-pip-mode #video-modal:not(.hidden) #timeshift-controls-overlay,',
                            'body.android-pip-mode #video-modal:not(.hidden) #player-lock-overlay,',
                            'body.android-pip-mode #video-modal:not(.hidden) #stream-info-overlay,',
                            'body.android-pip-mode #video-modal:not(.hidden) .resize-handle {',
                            '  display: none !important;',
                            '}',
                            'body.android-pip-mode #video-modal:not(.hidden) #video-content {',
                            '  position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;',
                            '  padding: 0 !important; margin: 0 !important; border-radius: 0 !important; background: #000 !important;',
                            '}',
                            'body.android-pip-mode #video-modal:not(.hidden) #videoElement {',
                            '  width: 100% !important; height: 100% !important; object-fit: contain !important;',
                            '}',
                            'body.android-pip-mode #videoElement::-webkit-media-controls,',
                            'body.android-pip-mode #videoElement::-webkit-media-controls-enclosure {',
                            '  display: none !important; opacity: 0 !important;',
                            '}',
                            'body.android-pip-mode #page-multiview:not(.hidden) #multiview-header,',
                            'body.android-pip-mode #main-header,',
                            'body.android-pip-mode #page-multiview:not(.hidden) .player-header,',
                            'body.android-pip-mode #page-multiview:not(.hidden) .player-bottom-hud {',
                            '  display: none !important;',
                            '}'
                        ].join('\n');
                        (document.head || document.documentElement).appendChild(styleEl);
                    } catch (e) {}
                }
                ensureAndroidPipStyles();
                window.__viniEnsurePipStyles = ensureAndroidPipStyles;
                window.__viniSetPipMode = function(enabled) {
                    ensureAndroidPipStyles();
                    if (!document.body) return;
                    if (enabled) {
                        document.body.classList.add('android-pip-mode');
                    } else {
                        document.body.classList.remove('android-pip-mode');
                    }
                };

                if (window.__viniRuntimeBridgeInstalled) return;
                window.__viniRuntimeBridgeInstalled = true;
                window.__viniSuppressPauseUntil = 0;
                window.__viniExplicitlyPausedByUser = false;
                window.__viniDirectAudioSession = null;
                window.__viniResumeVideoIntent = false;
                console.log('[ANDROID] Installed ViniPlay WebView Bridge (Browser Player Mode)');

                // 3. Keep document.visibilityState === 'visible' so Multi-View & single player never pause in PiP/background
                try {
                    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: function() { return false; } });
                    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: function() { return 'visible'; } });
                    document.addEventListener('visibilitychange', function(e) {
                        e.stopImmediatePropagation();
                    }, true);
                } catch (e) {}

                // 4. Fallback Direct-Play VOD/DVR -> #audioElement handoff (when server player.js hasn't been rebuilt yet)
                function syncFallbackAudioOnlyHandoff() {
                    if (window.__viniNativeAudioHandoffReady) return;
                    var modal = document.getElementById('video-modal');
                    var aoOverlay = document.getElementById('audio-only-overlay');
                    var vodOverlay = document.getElementById('vod-controls-overlay');
                    var tsOverlay = document.getElementById('timeshift-controls-overlay');
                    var vid = document.getElementById('videoElement');
                    var aud = document.getElementById('audioElement');
                    if (!vid || !aud) return;

                    var isModalOpen = !!(modal && !modal.classList.contains('hidden'));
                    var isAoVisible = !!(isModalOpen && aoOverlay && !aoOverlay.classList.contains('hidden'));

                    if (isAoVisible) {
                        if (!window.__viniDirectAudioSession) {
                            var isVodTranscode = !!(vodOverlay && !vodOverlay.classList.contains('hidden'));
                            var isTimeshift = !!(tsOverlay && !tsOverlay.classList.contains('hidden'));
                            var rawUrl = vid.currentSrc || vid.getAttribute('src') || '';
                            if (!isVodTranscode && !isTimeshift && rawUrl &&
                                rawUrl.indexOf('blob:') !== 0 &&
                                rawUrl.indexOf('data:') !== 0 &&
                                rawUrl.indexOf('/stream?') === -1) {
                                var savedSec = vid.currentTime || 0;
                                var savedDur = (isFinite(vid.duration) && vid.duration > 0) ? vid.duration : 0;
                                var savedVol = vid.volume;
                                var savedMuted = vid.muted;
                                window.__viniDirectAudioSession = {
                                    url: rawUrl,
                                    duration: savedDur,
                                    lastTime: savedSec
                                };
                                window.__viniSuppressPauseUntil = Date.now() + 6000;
                                vid.pause();
                                vid.removeAttribute('src');
                                vid.load();

                                aud.volume = savedVol;
                                aud.muted = savedMuted;
                                aud.src = rawUrl;
                                aud.load();
                                var applyAudioSeek = function() {
                                    if (window.__viniDirectAudioSession && savedSec > 0) {
                                        try { aud.currentTime = savedSec; } catch (e) {}
                                    }
                                };
                                if (aud.readyState >= 1) applyAudioSeek();
                                else aud.addEventListener('loadedmetadata', applyAudioSeek, { once: true });

                                if (!window.__viniExplicitlyPausedByUser) {
                                    aud.play().catch(function() {});
                                }
                            }
                        }
                    } else if (window.__viniDirectAudioSession) {
                        var sess = window.__viniDirectAudioSession;
                        window.__viniDirectAudioSession = null;
                        var wantRestore = !!window.__viniResumeVideoIntent && isModalOpen;
                        window.__viniResumeVideoIntent = false;

                        var resumeSec = (aud && aud.currentTime > 0) ? aud.currentTime : (sess.lastTime || 0);
                        var resumeVol = aud ? aud.volume : 1;
                        var resumeMuted = aud ? aud.muted : false;

                        aud.pause();
                        aud.removeAttribute('src');
                        aud.load();

                        if (wantRestore && sess.url) {
                            window.__viniExplicitlyPausedByUser = false;
                            vid.volume = resumeVol;
                            vid.muted = resumeMuted;
                            vid.src = sess.url;
                            vid.load();
                            var applyVidSeek = function() {
                                if (resumeSec > 0) {
                                    try { vid.currentTime = resumeSec; } catch (e) {}
                                }
                            };
                            if (vid.readyState >= 1) applyVidSeek();
                            else vid.addEventListener('loadedmetadata', applyVidSeek, { once: true });
                            vid.play().catch(function() {});
                        }
                    }
                }

                // 5. Ensure "Change Server" button is visible on the Login & Setup forms (even before server Docker rebuild)
                function ensureLoginChangeServerButtons() {
                    ['login-form', 'setup-form'].forEach(function(formId) {
                        var form = document.getElementById(formId);
                        if (!form) return;
                        var btn = form.querySelector('.android-change-server-btn');
                        if (!btn) {
                            btn = document.createElement('button');
                            btn.type = 'button';
                            btn.className = 'android-change-server-btn w-full bg-gray-700 hover:bg-gray-600 border border-gray-600 text-gray-200 font-medium py-2 px-4 rounded-md transition-colors text-sm';
                            btn.textContent = 'Change Server';
                            form.appendChild(btn);
                        } else {
                            btn.classList.remove('hidden');
                        }
                        if (!btn.__viniServerBound) {
                            btn.__viniServerBound = true;
                            btn.addEventListener('click', function(e) {
                                e.preventDefault();
                                if (window.ViniAndroid && typeof window.ViniAndroid.openServerSettings === 'function') {
                                    window.ViniAndroid.openServerSettings();
                                }
                            });
                        }
                    });
                }

                // 6. Fallback ghost-click shield for #program-details-modal & #video-modal (if server ui.js hasn't been rebuilt yet)
                function attachModalBackdropShield() {
                    if (window.__viniModalTouchShieldActive) return;
                    ['program-details-modal', 'video-modal'].forEach(function(id) {
                        var modal = document.getElementById(id);
                        if (!modal || modal.__viniBackdropShielded) return;
                        modal.__viniBackdropShielded = true;
                        var sx = 0, sy = 0, st = 0, validStart = false;
                        modal.addEventListener('touchstart', function(e) {
                            validStart = (e.target === modal) && !modal.classList.contains('player-locked');
                            if (validStart && e.touches && e.touches[0]) {
                                sx = e.touches[0].clientX;
                                sy = e.touches[0].clientY;
                                st = Date.now();
                            }
                        }, { passive: true });
                        modal.addEventListener('touchend', function(e) {
                            if (!validStart || window.__viniModalTouchShieldActive) return;
                            validStart = false;
                            var t = e.changedTouches && e.changedTouches[0];
                            if (!t) return;
                            var ex = t.clientX, ey = t.clientY;
                            if (Math.hypot(ex - sx, ey - sy) <= 10 && (Date.now() - st) <= 400 && sy <= window.innerHeight - 36) {
                                var startedAt = Date.now();
                                var swallow = function(ev) {
                                    if (Date.now() - startedAt > 450) {
                                        window.removeEventListener('click', swallow, true);
                                        return;
                                    }
                                    if (Math.hypot((ev.clientX || 0) - ex, (ev.clientY || 0) - ey) <= 32) {
                                        if (ev.cancelable) ev.preventDefault();
                                        ev.stopPropagation();
                                        ev.stopImmediatePropagation();
                                        window.removeEventListener('click', swallow, true);
                                    }
                                };
                                window.addEventListener('click', swallow, true);
                                setTimeout(function() { window.removeEventListener('click', swallow, true); }, 450);
                            }
                        }, { passive: true });
                    });
                }

                // 7. Defer hidden #multiview-drawer-channel-list images until the drawer is opened
                function setupMultiviewDrawerLazyGuard() {
                    var drawer = document.getElementById('multiview-channel-drawer');
                    var listEl = document.getElementById('multiview-drawer-channel-list');
                    if (!drawer || !listEl || listEl.__viniLazyGuarded) return;
                    listEl.__viniLazyGuarded = true;

                    function hydrateDrawerImages() {
                        var imgs = listEl.querySelectorAll('img[data-deferred-src]');
                        imgs.forEach(function(img) {
                            var s = img.getAttribute('data-deferred-src');
                            if (s) {
                                img.setAttribute('loading', 'lazy');
                                img.setAttribute('src', s);
                                img.removeAttribute('data-deferred-src');
                            }
                        });
                    }

                    var obs = new MutationObserver(function() {
                        var isDrawerHidden = drawer.classList.contains('hidden');
                        if (isDrawerHidden) {
                            var eagerImgs = listEl.querySelectorAll('img[src]');
                            eagerImgs.forEach(function(img) {
                                var srcVal = img.getAttribute('src');
                                if (srcVal && srcVal.indexOf('/api/proxy/image') !== -1) {
                                    img.setAttribute('data-deferred-src', srcVal);
                                    img.removeAttribute('src');
                                }
                            });
                        } else {
                            hydrateDrawerImages();
                        }
                    });
                    obs.observe(listEl, { childList: true });
                    obs.observe(drawer, { attributes: true, attributeFilter: ['class'] });
                }

                // 8. Wire up #videoElement & #audioElement state tracking, Audio-Only handoff, and PiP button
                function attachVideoPlayerHooks() {
                    ensureAndroidPipStyles();
                    ensureLoginChangeServerButtons();
                    attachModalBackdropShield();
                    setupMultiviewDrawerLazyGuard();
                    syncFallbackAudioOnlyHandoff();

                    var aoOverlay = document.getElementById('audio-only-overlay');
                    if (aoOverlay && !aoOverlay.__viniAoObserved) {
                        aoOverlay.__viniAoObserved = true;
                        var aoObs = new MutationObserver(function() {
                            syncFallbackAudioOnlyHandoff();
                            reportPlaybackState();
                        });
                        aoObs.observe(aoOverlay, { attributes: true, attributeFilter: ['class'] });
                    }

                    var modalEl = document.getElementById('video-modal');
                    if (modalEl && !modalEl.__viniModalObserved) {
                        modalEl.__viniModalObserved = true;
                        var modalObs = new MutationObserver(function() {
                            if (modalEl.classList.contains('hidden')) {
                                window.__viniResumeVideoIntent = false;
                                syncFallbackAudioOnlyHandoff();
                            }
                            reportPlaybackState();
                        });
                        modalObs.observe(modalEl, { attributes: true, attributeFilter: ['class'] });
                    }

                    var resumeBtn = document.getElementById('resume-video-btn');
                    if (resumeBtn && !resumeBtn.__viniResumeHooked) {
                        resumeBtn.__viniResumeHooked = true;
                        var markResumeIntent = function() {
                            window.__viniResumeVideoIntent = true;
                            window.__viniExplicitlyPausedByUser = false;
                        };
                        resumeBtn.addEventListener('touchstart', markResumeIntent, { capture: true, passive: true });
                        resumeBtn.addEventListener('click', markResumeIntent, true);
                    }

                    var aoBtn = document.getElementById('audio-only-btn');
                    if (aoBtn && !aoBtn.__viniAoBtnHooked) {
                        aoBtn.__viniAoBtnHooked = true;
                        var checkToggleOffIntent = function() {
                            var ao = document.getElementById('audio-only-overlay');
                            if (ao && !ao.classList.contains('hidden')) {
                                window.__viniResumeVideoIntent = true;
                                window.__viniExplicitlyPausedByUser = false;
                            }
                        };
                        aoBtn.addEventListener('touchstart', checkToggleOffIntent, { capture: true, passive: true });
                        aoBtn.addEventListener('click', checkToggleOffIntent, true);
                    }

                    var vid = document.getElementById('videoElement');
                    if (!vid || vid.__viniAndroidHooked) return;
                    vid.__viniAndroidHooked = true;
                    vid.setAttribute('poster', 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=');

                    function isAudioOnlyActive() {
                        var ao = document.getElementById('audio-only-overlay');
                        return !!(ao && !ao.classList.contains('hidden'));
                    }

                    vid.addEventListener('emptied', function() {
                        if (!isAudioOnlyActive()) vid.style.opacity = '0';
                        reportPlaybackState();
                    });
                    vid.addEventListener('loadstart', function() {
                        if (!isAudioOnlyActive()) vid.style.opacity = '0';
                    });
                    vid.addEventListener('loadeddata', function() {
                        if (!isAudioOnlyActive()) vid.style.opacity = '1';
                    });
                    vid.addEventListener('playing', function() {
                        window.__viniExplicitlyPausedByUser = false;
                        if (!isAudioOnlyActive()) vid.style.opacity = '1';
                        reportPlaybackState();
                    });
                    vid.addEventListener('play', function() {
                        window.__viniExplicitlyPausedByUser = false;
                        reportPlaybackState();
                    });
                    vid.addEventListener('pause', function() {
                        var audEl = document.getElementById('audioElement');
                        var audHasSrc = !!(audEl && (audEl.currentSrc || audEl.getAttribute('src')));
                        if (!audHasSrc && !window.__viniDirectAudioSession) {
                            var shouldAutoResume = !window.__viniExplicitlyPausedByUser && (
                                isAudioOnlyActive() ||
                                (window.__viniSuppressPauseUntil && Date.now() < window.__viniSuppressPauseUntil)
                            );
                            if (shouldAutoResume && !vid.ended && (vid.currentSrc || vid.getAttribute('src'))) {
                                setTimeout(function() {
                                    if (vid.paused && !vid.ended && !window.__viniExplicitlyPausedByUser && (vid.currentSrc || vid.getAttribute('src'))) {
                                        vid.play().catch(function() {});
                                    }
                                }, 40);
                            }
                        }
                        reportPlaybackState();
                    });
                    vid.addEventListener('seeked', reportPlaybackState);
                    vid.addEventListener('durationchange', reportPlaybackState);
                    vid.addEventListener('ended', reportPlaybackState);

                    var aud = document.getElementById('audioElement');
                    if (aud && !aud.__viniAndroidHooked) {
                        aud.__viniAndroidHooked = true;
                        aud.addEventListener('timeupdate', function() {
                            if (window.__viniDirectAudioSession && aud.currentTime > 0) {
                                window.__viniDirectAudioSession.lastTime = aud.currentTime;
                            }
                        });
                        aud.addEventListener('playing', function() {
                            window.__viniExplicitlyPausedByUser = false;
                            reportPlaybackState();
                        });
                        aud.addEventListener('play', function() {
                            window.__viniExplicitlyPausedByUser = false;
                            reportPlaybackState();
                        });
                        aud.addEventListener('pause', reportPlaybackState);
                        aud.addEventListener('seeked', reportPlaybackState);
                        aud.addEventListener('durationchange', reportPlaybackState);
                        aud.addEventListener('ended', reportPlaybackState);
                    }

                    // Hook #pip-btn inside #video-modal on both touchend and click (capture phase)
                    // because player.js bindTap() calls e.preventDefault() on touchend, suppressing synthetic click events!
                    var pipBtn = document.getElementById('pip-btn');
                    if (pipBtn && !pipBtn.__viniAndroidPipHooked) {
                        pipBtn.__viniAndroidPipHooked = true;
                        var lastPipTapAt = 0;
                        var pipStartX = 0, pipStartY = 0;
                        pipBtn.addEventListener('touchstart', function(e) {
                            if (e.touches && e.touches[0]) {
                                pipStartX = e.touches[0].clientX;
                                pipStartY = e.touches[0].clientY;
                            }
                        }, { capture: true, passive: true });
                        pipBtn.addEventListener('touchend', function(e) {
                            if (!window.ViniAndroid || typeof window.ViniAndroid.enterPip !== 'function') return;
                            var t = e.changedTouches && e.changedTouches[0];
                            if (t && Math.hypot(t.clientX - pipStartX, t.clientY - pipStartY) > 24) return;
                            if (e.cancelable) e.preventDefault();
                            e.stopPropagation();
                            e.stopImmediatePropagation();
                            lastPipTapAt = Date.now();
                            var ao = document.getElementById('audio-only-overlay');
                            var resumeBtn = document.getElementById('resume-video-btn');
                            if (ao && !ao.classList.contains('hidden') && resumeBtn) {
                                resumeBtn.click();
                            }
                            window.ViniAndroid.enterPip();
                        }, { capture: true, passive: false });
                        pipBtn.addEventListener('click', function(e) {
                            if (!window.ViniAndroid || typeof window.ViniAndroid.enterPip !== 'function') return;
                            e.preventDefault();
                            e.stopPropagation();
                            e.stopImmediatePropagation();
                            if (Date.now() - lastPipTapAt < 500) return;
                            lastPipTapAt = Date.now();
                            var ao = document.getElementById('audio-only-overlay');
                            var resumeBtn = document.getElementById('resume-video-btn');
                            if (ao && !ao.classList.contains('hidden') && resumeBtn) {
                                resumeBtn.click();
                            }
                            window.ViniAndroid.enterPip();
                        }, true);
                    }
                }

                function resolveAbsoluteUrl(rawUrl) {
                    if (!rawUrl || rawUrl.indexOf('data:') === 0 || rawUrl.indexOf('blob:') === 0) return '';
                    try {
                        return new URL(rawUrl, window.location.origin).href;
                    } catch (e) {
                        return '';
                    }
                }

                function getActiveModalMediaElement() {
                    var vid = document.getElementById('videoElement');
                    var aud = document.getElementById('audioElement');
                    var aoOverlay = document.getElementById('audio-only-overlay');
                    var isAudioOnly = !!(aoOverlay && !aoOverlay.classList.contains('hidden'));
                    var audHasSrc = !!(aud && (aud.currentSrc || aud.getAttribute('src')));
                    return (isAudioOnly && audHasSrc) ? aud : vid;
                }

                function reportPlaybackState() {
                    try {
                        var modal = document.getElementById('video-modal');
                        var vid = document.getElementById('videoElement');
                        var aud = document.getElementById('audioElement');
                        var mvPage = document.getElementById('page-multiview');
                        var aoOverlay = document.getElementById('audio-only-overlay');
                        var vodOverlay = document.getElementById('vod-controls-overlay');
                        var tsOverlay = document.getElementById('timeshift-controls-overlay');

                        var isModalOpen = !!(modal && !modal.classList.contains('hidden'));
                        var isAudioOnly = !!(isModalOpen && aoOverlay && !aoOverlay.classList.contains('hidden'));
                        var audHasSrc = !!(aud && (aud.currentSrc || aud.getAttribute('src')));
                        var activeMedia = (isAudioOnly && audHasSrc) ? aud : vid;
                        var isSinglePlaying = !!(isModalOpen && activeMedia && !activeMedia.paused && !activeMedia.ended);

                        var isMvOpen = !!(mvPage && !mvPage.classList.contains('hidden'));
                        var mvPlayingCount = 0;
                        if (isMvOpen) {
                            document.querySelectorAll('#multiview-grid video').forEach(function(v) {
                                if (!v.paused && !v.classList.contains('hidden')) mvPlayingCount++;
                            });
                        }

                        var active = isModalOpen || (mvPlayingCount > 0);
                        var playing = isSinglePlaying || (mvPlayingCount > 0);
                        var titleEl = document.getElementById('video-title');
                        var title = isModalOpen && titleEl && titleEl.textContent
                            ? titleEl.textContent.trim()
                            : (mvPlayingCount > 0 ? ('Multi-View (' + mvPlayingCount + ' streams)') : 'ViniPlay');

                        var subtitle = '';
                        var artworkUrl = '';
                        var positionMs = 0;
                        var durationMs = -1;
                        var seekable = false;
                        var rectL = 0, rectT = 0, rectR = 0, rectB = 0;

                        if (isModalOpen) {
                            var vc = document.getElementById('video-content');
                            if (vc && (!document.body || !document.body.classList.contains('android-pip-mode'))) {
                                var r = vc.getBoundingClientRect();
                                var dpr = window.devicePixelRatio || 1;
                                if (r && r.width > 40 && r.height > 40) {
                                    rectL = Math.max(0, Math.round(r.left * dpr));
                                    rectT = Math.max(0, Math.round(r.top * dpr));
                                    rectR = Math.max(0, Math.round(r.right * dpr));
                                    rectB = Math.max(0, Math.round(r.bottom * dpr));
                                }
                            }

                            var msMeta = (navigator.mediaSession && navigator.mediaSession.metadata) ? navigator.mediaSession.metadata : null;
                            if (msMeta) {
                                if (msMeta.artist && msMeta.artist !== 'ViniPlay') {
                                    subtitle = msMeta.artist;
                                }
                                if (msMeta.artwork && msMeta.artwork.length > 0 && msMeta.artwork[0].src) {
                                    artworkUrl = resolveAbsoluteUrl(msMeta.artwork[0].src);
                                }
                            }
                            if (!artworkUrl) {
                                var aoLogo = document.getElementById('audio-only-logo');
                                if (aoLogo && aoLogo.getAttribute('src')) {
                                    artworkUrl = resolveAbsoluteUrl(aoLogo.getAttribute('src'));
                                }
                            }

                            var isVodTranscode = !!(vodOverlay && !vodOverlay.classList.contains('hidden'));
                            var isTimeshift = !!(tsOverlay && !tsOverlay.classList.contains('hidden'));
                            var activeSrc = activeMedia ? (activeMedia.currentSrc || activeMedia.getAttribute('src') || '') : '';
                            var fallbackDur = (window.__viniDirectAudioSession && window.__viniDirectAudioSession.duration > 0)
                                ? window.__viniDirectAudioSession.duration
                                : 0;
                            var resolvedDur = (activeMedia && isFinite(activeMedia.duration) && activeMedia.duration > 0)
                                ? activeMedia.duration
                                : fallbackDur;
                            var isDirectSeekable = !!(activeMedia && resolvedDur > 0 && (!activeSrc || activeSrc.indexOf('blob:') !== 0));

                            if (isVodTranscode) {
                                var vodBar = document.getElementById('vod-progress-bar');
                                var curVal = vodBar ? parseFloat(vodBar.value) : 0;
                                var maxVal = vodBar ? parseFloat(vodBar.max) : 0;
                                if (maxVal > 0) {
                                    seekable = true;
                                    positionMs = Math.max(0, Math.round((curVal || 0) * 1000));
                                    durationMs = Math.round(maxVal * 1000);
                                }
                                if (!subtitle) subtitle = 'VOD • ViniPlay';
                            } else if (isDirectSeekable) {
                                seekable = true;
                                var curSec = (activeMedia.currentTime > 0)
                                    ? activeMedia.currentTime
                                    : ((window.__viniDirectAudioSession && activeMedia === aud) ? (window.__viniDirectAudioSession.lastTime || 0) : 0);
                                positionMs = Math.max(0, Math.round(curSec * 1000));
                                durationMs = Math.round(resolvedDur * 1000);
                                if (!subtitle) subtitle = 'VOD • ViniPlay';
                            } else if (isTimeshift && vid && vid.seekable && vid.seekable.length > 0) {
                                var tsEnd = vid.seekable.end(vid.seekable.length - 1);
                                if (tsEnd > 0) {
                                    seekable = true;
                                    positionMs = Math.max(0, Math.round((vid.currentTime || 0) * 1000));
                                    durationMs = Math.round(tsEnd * 1000);
                                }
                                if (!subtitle) subtitle = 'Live Timeshift • ViniPlay';
                            } else {
                                if (!subtitle) subtitle = 'Live TV • ViniPlay';
                            }

                            if (isAudioOnly && subtitle.indexOf('Audio Only') === -1) {
                                subtitle = subtitle + ' • Audio Only';
                            }
                        } else if (mvPlayingCount > 0) {
                            subtitle = 'Multi-View • ViniPlay';
                        }

                        if (window.ViniAndroid && typeof window.ViniAndroid.onPlaybackStateChanged === 'function') {
                            window.ViniAndroid.onPlaybackStateChanged(
                                active,
                                playing,
                                isAudioOnly,
                                title,
                                subtitle,
                                artworkUrl,
                                positionMs,
                                durationMs,
                                seekable,
                                rectL,
                                rectT,
                                rectR,
                                rectB
                            );
                        }
                    } catch (e) {}
                }

                setInterval(function() {
                    attachVideoPlayerHooks();
                    reportPlaybackState();
                }, 1000);

                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', attachVideoPlayerHooks);
                } else {
                    attachVideoPlayerHooks();
                }

                // Helpers invoked by Android PiP & MediaSession Notification controls
                window.__viniAndroidPlay = function() {
                    window.__viniExplicitlyPausedByUser = false;
                    var modal = document.getElementById('video-modal');
                    if (modal && !modal.classList.contains('hidden')) {
                        var target = getActiveModalMediaElement();
                        if (target && target.paused) {
                            target.play().catch(function() {});
                            reportPlaybackState();
                        }
                    }
                };

                window.__viniAndroidPause = function() {
                    window.__viniSuppressPauseUntil = 0;
                    window.__viniExplicitlyPausedByUser = true;
                    var modal = document.getElementById('video-modal');
                    if (modal && !modal.classList.contains('hidden')) {
                        var target = getActiveModalMediaElement();
                        if (target && !target.paused) {
                            target.pause();
                            reportPlaybackState();
                        }
                    }
                };

                window.__viniAndroidTogglePlayPause = function() {
                    var modal = document.getElementById('video-modal');
                    if (modal && !modal.classList.contains('hidden')) {
                        var target = getActiveModalMediaElement();
                        if (target) {
                            if (target.paused) {
                                window.__viniExplicitlyPausedByUser = false;
                                target.play().catch(function() {});
                            } else {
                                window.__viniSuppressPauseUntil = 0;
                                window.__viniExplicitlyPausedByUser = true;
                                target.pause();
                            }
                            reportPlaybackState();
                        }
                    }
                };

                window.__viniAndroidSeekTo = function(seconds) {
                    var sec = Math.max(0, Number(seconds) || 0);
                    var vodOverlay = document.getElementById('vod-controls-overlay');
                    var vodBar = document.getElementById('vod-progress-bar');
                    if (vodOverlay && !vodOverlay.classList.contains('hidden') && vodBar) {
                        vodBar.value = sec;
                        vodBar.dispatchEvent(new Event('change'));
                        reportPlaybackState();
                        return;
                    }
                    var target = getActiveModalMediaElement();
                    if (target && isFinite(target.duration) && target.duration > 0) {
                        target.currentTime = Math.min(target.duration, sec);
                        if (window.__viniDirectAudioSession && target.id === 'audioElement') {
                            window.__viniDirectAudioSession.lastTime = target.currentTime;
                        }
                        reportPlaybackState();
                    }
                };

                window.__viniAndroidEnableAudioOnly = function() {
                    window.__viniSuppressPauseUntil = Date.now() + 6500;
                    window.__viniExplicitlyPausedByUser = false;
                    var aoBtn = document.getElementById('audio-only-btn');
                    var aoOverlay = document.getElementById('audio-only-overlay');
                    if (aoBtn && (!aoOverlay || aoOverlay.classList.contains('hidden'))) {
                        aoBtn.click();
                    }
                    syncFallbackAudioOnlyHandoff();
                    var target = getActiveModalMediaElement();
                    if (target && target.paused && !target.ended && (target.currentSrc || target.getAttribute('src'))) {
                        target.play().catch(function() {});
                    }
                    reportPlaybackState();
                };

                window.__viniAndroidResumeAudioOnlyIfPaused = function() {
                    if (window.__viniExplicitlyPausedByUser) return;
                    syncFallbackAudioOnlyHandoff();
                    var modal = document.getElementById('video-modal');
                    var target = getActiveModalMediaElement();
                    if (modal && !modal.classList.contains('hidden') && target && target.paused && !target.ended && (target.currentSrc || target.getAttribute('src'))) {
                        target.play().catch(function() {});
                        reportPlaybackState();
                    }
                };

                window.__viniAndroidStopPlayback = function() {
                    window.__viniSuppressPauseUntil = 0;
                    window.__viniExplicitlyPausedByUser = false;
                    window.__viniResumeVideoIntent = false;
                    var closeBtn = document.getElementById('close-modal');
                    var modal = document.getElementById('video-modal');
                    if (modal && !modal.classList.contains('hidden') && closeBtn) {
                        closeBtn.click();
                    }
                    syncFallbackAudioOnlyHandoff();
                    reportPlaybackState();
                };

                window.__viniAndroidEnsurePlayingAfterPip = function() {
                    if (window.__viniExplicitlyPausedByUser) return;
                    var modal = document.getElementById('video-modal');
                    var target = getActiveModalMediaElement();
                    if (modal && !modal.classList.contains('hidden') && target && target.paused && !target.ended && (target.currentSrc || target.getAttribute('src'))) {
                        target.play().catch(function() {});
                    }
                    var mvPage = document.getElementById('page-multiview');
                    if (mvPage && !mvPage.classList.contains('hidden')) {
                        document.querySelectorAll('#multiview-grid video').forEach(function(v) {
                            if (v.paused && !v.classList.contains('hidden')) {
                                v.play().catch(function() {});
                            }
                        });
                    }
                };

                // 9. Observe /api/notifications to sync push reminders, preserve Audio-Only watch progress, and silence transient 500s on /api/activity/stop-redirect
                var origFetch = window.fetch;
                if (origFetch && !origFetch.__viniNotifWrapped) {
                    var wrappedFetch = function(input, init) {
                        var urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
                        var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
                        if (!window.__viniNativeAudioHandoffReady &&
                            window.__viniDirectAudioSession &&
                            method === 'POST' &&
                            urlStr.indexOf('/api/progress') !== -1 &&
                            init && typeof init.body === 'string') {
                            try {
                                var parsed = JSON.parse(init.body);
                                var audEl = document.getElementById('audioElement');
                                var realSec = Math.floor((audEl && audEl.currentTime > 0) ? audEl.currentTime : (window.__viniDirectAudioSession.lastTime || 0));
                                if (parsed && realSec >= 5 && (!parsed.progressSeconds || parsed.progressSeconds < 2)) {
                                    parsed.progressSeconds = realSec;
                                    if (!parsed.durationSeconds && window.__viniDirectAudioSession.duration > 0) {
                                        parsed.durationSeconds = Math.floor(window.__viniDirectAudioSession.duration);
                                    }
                                    init = Object.assign({}, init, { body: JSON.stringify(parsed) });
                                }
                            } catch (e) {}
                        }
                        var p = origFetch.call(this, input, init);
                        if (method === 'GET' && urlStr.indexOf('/api/notifications') !== -1) {
                            p.then(function(resp) {
                                if (resp && resp.ok) {
                                    resp.clone().json().then(function(list) {
                                        if (Array.isArray(list) && window.ViniAndroid && typeof window.ViniAndroid.syncNotifications === 'function') {
                                            window.ViniAndroid.syncNotifications(JSON.stringify(list));
                                        }
                                    }).catch(function() {});
                                }
                            }).catch(function() {});
                        } else if (method === 'POST' && urlStr.indexOf('/api/activity/stop-redirect') !== -1) {
                            return p.then(function(resp) {
                                if (resp && !resp.ok && resp.status >= 500) {
                                    return new Response('{"success":true}', {
                                        status: 200,
                                        headers: { 'Content-Type': 'application/json' }
                                    });
                                }
                                return resp;
                            }).catch(function() {
                                return new Response('{"success":true}', {
                                    status: 200,
                                    headers: { 'Content-Type': 'application/json' }
                                });
                            });
                        }
                        return p;
                    };
                    wrappedFetch.__viniNotifWrapped = true;
                    window.fetch = wrappedFetch;
                }
            })();
        """.trimIndent()
        wv.evaluateJavascript(script, null)
    }

    // --- Server URL Configuration & Permissions ---

    private fun loadViniPlayServer(url: String) {
        val normalized = url.trim().trimEnd('/')
        isWebVideoActive = false
        isWebVideoPlaying = false
        isWebAudioOnly = false
        audioOnlyTransitionUntilMs = 0L
        ViniPlaybackService.stopPlaybackSession(this)
        ViniLogger.updateServerUrl(this, normalized)
        ViniLogger.log("LIFECYCLE", "Loading ViniPlay Server URL: $normalized")
        connectionErrorOverlay.visibility = View.GONE
        webView.loadUrl(normalized)
    }

    private fun showServerUrlDialog(isInitialSetup: Boolean) {
        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density).toInt()

        val currentUrl = ViniLogger.getServerUrl(this)
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(14), dp(20), dp(6))
        }
        val hintText = TextView(this).apply {
            text = "Enter your ViniPlay server address (e.g. http://192.168.1.50:3000 or https://tv.example.com):"
            setTextColor(Color.parseColor("#CBD5E1"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(0, 0, 0, dp(10))
        }
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(currentUrl.ifEmpty { "http://" })
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#64748B"))
            setSelection(text.length)
            setSingleLine(true)
        }
        container.addView(hintText)
        container.addView(input)

        val builder = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle(if (isInitialSetup) "Connect to ViniPlay Server" else "Change ViniPlay Server")
            .setView(container)
            .setCancelable(!isInitialSetup)
            .setPositiveButton("Connect") { _, _ ->
                var raw = input.text.toString().trim()
                if (raw.isNotEmpty() && !raw.startsWith("http://") && !raw.startsWith("https://")) {
                    raw = "http://$raw"
                }
                if (raw.isNotEmpty()) {
                    loadViniPlayServer(raw)
                }
            }

        if (!isInitialSetup) {
            builder.setNeutralButton("View Logs") { _, _ ->
                showDiagnosticLogsDialog()
            }
            builder.setNegativeButton("Cancel", null)
        }

        builder.show()
    }

    private fun showDiagnosticLogsDialog() {
        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density).toInt()
        val scroll = ScrollView(this).apply {
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        val tv = TextView(this).apply {
            text = ViniLogger.getRecentLogsText().ifEmpty { "No logs recorded yet." }
            setTextColor(Color.parseColor("#E2E8F0"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
        }
        scroll.addView(tv)
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Android Native & Player Logs")
            .setView(scroll)
            .setPositiveButton("Send to Server Logs") { _, _ ->
                ViniLogger.flushNow()
                Toast.makeText(this, "Flushed logs to ViniPlay Server (/api/logs/client)", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    REQ_POST_NOTIFICATIONS
                )
            }
        }
    }

    // --- JavaScript Bridge (`window.ViniAndroid`) ---
    // Note: Intentionally does NOT expose `playMedia` or `stopMedia` so `player.js`, `vod.js`,
    // `dvr.js`, and `multiview.js` always use 100% of the standard browser player logic.

    inner class ViniJsBridge {

        @JavascriptInterface
        fun onPlaybackStateChanged(
            active: Boolean,
            playing: Boolean,
            audioOnly: Boolean,
            title: String,
            subtitle: String,
            artworkUrl: String,
            positionMs: Long,
            durationMs: Long,
            seekable: Boolean,
            rectLeft: Int,
            rectTop: Int,
            rectRight: Int,
            rectBottom: Int
        ) {
            val nowElapsed = SystemClock.elapsedRealtime()
            val effectiveAudioOnly = audioOnly || (System.currentTimeMillis() < audioOnlyTransitionUntilMs)
            val cleanTitle = title.ifBlank { "ViniPlay" }

            val newRect = if (rectRight > rectLeft + 60 && rectBottom > rectTop + 60) {
                Rect(rectLeft, rectTop, rectRight, rectBottom)
            } else {
                null
            }
            val rectChanged = (lastVideoContentRect != newRect)
            lastVideoContentRect = newRect

            val expectedPosMs = if (isWebVideoPlaying) {
                lastReportedPositionMs + (nowElapsed - lastReportedPositionWallMs)
            } else {
                lastReportedPositionMs
            }
            val positionJumped = seekable && abs(positionMs - expectedPosMs) > 2500L

            val stateChanged = (isWebVideoActive != active) ||
                (isWebVideoPlaying != playing) ||
                (isWebAudioOnly != effectiveAudioOnly) ||
                (currentWebMediaTitle != cleanTitle) ||
                (currentWebMediaSubtitle != subtitle) ||
                (currentWebArtworkUrl != artworkUrl) ||
                (currentWebDurationMs != durationMs) ||
                (currentWebSeekable != seekable) ||
                positionJumped

            if (!stateChanged && !rectChanged) return

            if (!stateChanged && rectChanged) {
                uiHandler.post { updatePipParams() }
                return
            }

            isWebVideoActive = active
            isWebVideoPlaying = playing
            isWebAudioOnly = effectiveAudioOnly
            currentWebMediaTitle = cleanTitle
            currentWebMediaSubtitle = subtitle
            currentWebArtworkUrl = artworkUrl
            currentWebDurationMs = durationMs
            currentWebSeekable = seekable
            lastReportedPositionMs = positionMs
            lastReportedPositionWallMs = nowElapsed

            uiHandler.post {
                updateKeepScreenOnFlag()
                updatePipParams()
                if (active) {
                    ViniPlaybackService.updatePlaybackSession(
                        context = this@MainActivity,
                        isPlaying = playing,
                        title = cleanTitle,
                        subtitle = subtitle,
                        artworkUrl = artworkUrl,
                        positionMs = positionMs,
                        durationMs = durationMs,
                        isSeekable = seekable
                    )
                } else {
                    audioOnlyTransitionUntilMs = 0L
                    ViniPlaybackService.stopPlaybackSession(this@MainActivity)
                }
            }
        }

        @JavascriptInterface
        fun enterPip() {
            uiHandler.post {
                enterPipNow()
            }
        }

        @JavascriptInterface
        fun syncNotifications(jsonArrayPayload: String) {
            NotificationScheduler.syncFromJson(this@MainActivity, jsonArrayPayload)
        }

        @JavascriptInterface
        fun requestNotificationPermission() {
            uiHandler.post {
                requestNotificationPermissionIfNeeded()
            }
        }

        @JavascriptInterface
        fun openServerSettings() {
            uiHandler.post {
                showServerUrlDialog(isInitialSetup = false)
            }
        }

        @JavascriptInterface
        fun openNativeLogs() {
            uiHandler.post {
                showDiagnosticLogsDialog()
            }
        }
    }
}
