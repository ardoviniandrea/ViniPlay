package com.viniplay.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.Icon
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.LruCache
import androidx.core.app.ServiceCompat
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection

/**
 * Native MediaSession + MediaStyle Foreground Service that displays ViniPlay inside Android's
 * Quick Settings & Lock Screen Media Player Carousel (with artwork, metadata, Play/Pause, Stop,
 * audio output switcher, and timeline scrubbing for VOD/DVR) while keeping CPU and Wi-Fi awake.
 * Does NOT open any media stream connections — 100% of playback remains in the WebView player.
 */
class ViniPlaybackService : Service() {

    companion object {
        private const val NOTIFICATION_ID = 4001
        private const val CHANNEL_ID = "viniplay_playback_service"

        const val ACTION_START_OR_UPDATE = "com.viniplay.app.ACTION_SERVICE_START_OR_UPDATE"
        const val ACTION_PLAY = "com.viniplay.app.ACTION_SERVICE_PLAY"
        const val ACTION_PAUSE = "com.viniplay.app.ACTION_SERVICE_PAUSE"
        const val ACTION_PLAY_PAUSE = "com.viniplay.app.ACTION_SERVICE_PLAY_PAUSE"
        const val ACTION_STOP = "com.viniplay.app.ACTION_SERVICE_STOP"
        private const val CUSTOM_ACTION_STOP = "com.viniplay.app.CUSTOM_ACTION_STOP"

        const val EXTRA_TITLE = "extra_title"
        const val EXTRA_SUBTITLE = "extra_subtitle"
        const val EXTRA_ARTWORK_URL = "extra_artwork_url"
        const val EXTRA_IS_PLAYING = "extra_is_playing"
        const val EXTRA_POSITION_MS = "extra_position_ms"
        const val EXTRA_DURATION_MS = "extra_duration_ms"
        const val EXTRA_IS_SEEKABLE = "extra_is_seekable"

        @Volatile
        var isPlayingMedia: Boolean = false
            private set

        @Volatile
        var currentTitle: String = "ViniPlay"
            private set

        var onRemoteAction: ((String) -> Unit)? = null
        var onRemoteSeekMs: ((Long) -> Unit)? = null

        private val artworkCache = object : LruCache<String, Bitmap>(12) {}
        private val artworkExecutor = Executors.newSingleThreadExecutor()

        fun updatePlaybackSession(
            context: Context,
            isPlaying: Boolean,
            title: String,
            subtitle: String = "",
            artworkUrl: String = "",
            positionMs: Long = 0L,
            durationMs: Long = -1L,
            isSeekable: Boolean = false
        ) {
            val cleanTitle = title.ifBlank { "ViniPlay Stream" }
            isPlayingMedia = isPlaying
            currentTitle = cleanTitle
            val appCtx = context.applicationContext
            val intent = Intent(appCtx, ViniPlaybackService::class.java).apply {
                action = ACTION_START_OR_UPDATE
                putExtra(EXTRA_TITLE, cleanTitle)
                putExtra(EXTRA_SUBTITLE, subtitle)
                putExtra(EXTRA_ARTWORK_URL, artworkUrl)
                putExtra(EXTRA_IS_PLAYING, isPlaying)
                putExtra(EXTRA_POSITION_MS, positionMs)
                putExtra(EXTRA_DURATION_MS, durationMs)
                putExtra(EXTRA_IS_SEEKABLE, isSeekable)
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    appCtx.startForegroundService(intent)
                } else {
                    appCtx.startService(intent)
                }
            } catch (e: Throwable) {
                ViniLogger.log("SERVICE", "Could not start/update foreground service", e.message)
            }
        }

        fun stopPlaybackSession(context: Context) {
            isPlayingMedia = false
            val appCtx = context.applicationContext
            try {
                appCtx.stopService(Intent(appCtx, ViniPlaybackService::class.java))
            } catch (_: Throwable) {}
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var mediaSession: MediaSession? = null
    private var defaultLogoBitmap: Bitmap? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    private var currentSubtitle: String = "ViniPlay"
    private var currentArtworkUrl: String = ""
    private var currentArtworkBitmap: Bitmap? = null
    private var currentPositionMs: Long = 0L
    private var currentDurationMs: Long = -1L
    private var currentIsSeekable: Boolean = false
    @Volatile
    private var inFlightArtworkUrl: String = ""

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        defaultLogoBitmap = try {
            BitmapFactory.decodeResource(resources, R.drawable.viniplay_logo)
        } catch (_: Throwable) {
            null
        }
        initMediaSession()
        acquireLocks()
    }

    private fun initMediaSession() {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val sessionActivityPi = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        mediaSession = MediaSession(this, "ViniPlayMediaSession").apply {
            setSessionActivity(sessionActivityPi)
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() {
                    isPlayingMedia = true
                    refreshSessionAndNotification()
                    onRemoteAction?.invoke(ACTION_PLAY)
                }

                override fun onPause() {
                    isPlayingMedia = false
                    refreshSessionAndNotification()
                    onRemoteAction?.invoke(ACTION_PAUSE)
                }

                override fun onStop() {
                    handleStopCommand()
                }

                override fun onSeekTo(pos: Long) {
                    currentPositionMs = pos.coerceAtLeast(0L)
                    refreshSessionAndNotification()
                    onRemoteSeekMs?.invoke(currentPositionMs)
                }

                override fun onCustomAction(action: String, extras: Bundle?) {
                    if (action == CUSTOM_ACTION_STOP) {
                        handleStopCommand()
                    }
                }
            })
            isActive = true
        }
    }

    private fun handleStopCommand() {
        isPlayingMedia = false
        onRemoteAction?.invoke(ACTION_STOP)
        releaseMediaSession()
        releaseLocks()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PLAY -> {
                isPlayingMedia = true
                refreshSessionAndNotification()
                onRemoteAction?.invoke(ACTION_PLAY)
                return START_STICKY
            }
            ACTION_PAUSE -> {
                isPlayingMedia = false
                refreshSessionAndNotification()
                onRemoteAction?.invoke(ACTION_PAUSE)
                return START_STICKY
            }
            ACTION_PLAY_PAUSE -> {
                onRemoteAction?.invoke(ACTION_PLAY_PAUSE)
                return START_STICKY
            }
            ACTION_STOP -> {
                handleStopCommand()
                return START_NOT_STICKY
            }
            ACTION_START_OR_UPDATE -> {
                currentTitle = intent.getStringExtra(EXTRA_TITLE) ?: currentTitle
                val sub = intent.getStringExtra(EXTRA_SUBTITLE) ?: ""
                currentSubtitle = sub.ifBlank { if (isPlayingMedia) "Playing in ViniPlay" else "ViniPlay" }
                isPlayingMedia = intent.getBooleanExtra(EXTRA_IS_PLAYING, true)
                currentPositionMs = intent.getLongExtra(EXTRA_POSITION_MS, 0L)
                currentDurationMs = intent.getLongExtra(EXTRA_DURATION_MS, -1L)
                currentIsSeekable = intent.getBooleanExtra(EXTRA_IS_SEEKABLE, false)

                val nextArtUrl = (intent.getStringExtra(EXTRA_ARTWORK_URL) ?: "").trim()
                if (nextArtUrl != currentArtworkUrl) {
                    currentArtworkUrl = nextArtUrl
                    resolveArtworkAsync(nextArtUrl)
                }
            }
        }

        if (mediaSession == null) {
            initMediaSession()
        } else if (mediaSession?.isActive == false) {
            mediaSession?.isActive = true
        }

        acquireLocks()
        updateMediaSessionState()
        val notification = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceCompat.startForeground(
                    this,
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Throwable) {
            ViniLogger.log("SERVICE", "startForeground failed", e.message)
        }

        return START_STICKY
    }

    private fun refreshSessionAndNotification() {
        updateMediaSessionState()
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIFICATION_ID, buildNotification())
        } catch (_: Throwable) {}
    }

    private fun updateMediaSessionState() {
        val session = mediaSession ?: return
        val art = currentArtworkBitmap ?: defaultLogoBitmap

        val metaBuilder = MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, currentTitle)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, currentTitle)
            .putString(
                MediaMetadata.METADATA_KEY_ARTIST,
                currentSubtitle.ifBlank { if (isPlayingMedia) "Playing in ViniPlay" else "Paused" }
            )
            .putString(
                MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE,
                currentSubtitle.ifBlank { if (isPlayingMedia) "Playing in ViniPlay" else "Paused" }
            )

        if (currentIsSeekable && currentDurationMs > 0L) {
            metaBuilder.putLong(MediaMetadata.METADATA_KEY_DURATION, currentDurationMs)
        } else {
            metaBuilder.putLong(MediaMetadata.METADATA_KEY_DURATION, -1L)
        }

        if (art != null) {
            metaBuilder.putBitmap(MediaMetadata.METADATA_KEY_ART, art)
            metaBuilder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art)
        }
        session.setMetadata(metaBuilder.build())

        var actions = PlaybackState.ACTION_PLAY or
            PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_STOP
        if (currentIsSeekable && currentDurationMs > 0L) {
            actions = actions or PlaybackState.ACTION_SEEK_TO
        }

        val stateCode = if (isPlayingMedia) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED
        val pos = if (currentIsSeekable && currentPositionMs >= 0L) {
            currentPositionMs
        } else {
            PlaybackState.PLAYBACK_POSITION_UNKNOWN
        }
        val speed = if (isPlayingMedia) 1.0f else 0.0f

        val pbState = PlaybackState.Builder()
            .setActions(actions)
            .setState(stateCode, pos, speed, SystemClock.elapsedRealtime())
            .addCustomAction(CUSTOM_ACTION_STOP, "Stop", R.drawable.ic_notif_stop)
            .build()

        session.setPlaybackState(pbState)
    }

    private fun resolveArtworkAsync(urlStr: String) {
        if (urlStr.isEmpty() || urlStr.endsWith("/viniplay.png")) {
            currentArtworkBitmap = defaultLogoBitmap
            return
        }
        val cached = synchronized(artworkCache) { artworkCache.get(urlStr) }
        if (cached != null) {
            currentArtworkBitmap = cached
            return
        }
        // Show default logo immediately while fetching channel logo / VOD poster
        currentArtworkBitmap = defaultLogoBitmap
        inFlightArtworkUrl = urlStr

        artworkExecutor.execute {
            val downloaded = downloadAndFrameArtwork(urlStr)
            if (downloaded != null) {
                synchronized(artworkCache) {
                    artworkCache.put(urlStr, downloaded)
                }
                mainHandler.post {
                    if (currentArtworkUrl == urlStr && mediaSession != null) {
                        currentArtworkBitmap = downloaded
                        refreshSessionAndNotification()
                    }
                }
            }
        }
    }

    private fun downloadAndFrameArtwork(urlStr: String): Bitmap? {
        var conn: HttpURLConnection? = null
        return try {
            val targetUrl = URL(urlStr)
            conn = (targetUrl.openConnection() as HttpURLConnection).apply {
                if (this is HttpsURLConnection) {
                    val defaultVerifier = HttpsURLConnection.getDefaultHostnameVerifier()
                    hostnameVerifier = HostnameVerifier { host, session ->
                        defaultVerifier.verify(host, session) ||
                            (host.contains('_') && defaultVerifier.verify(host.replace('_', '-'), session)) ||
                            host.equals(targetUrl.host, ignoreCase = true)
                    }
                }
                requestMethod = "GET"
                connectTimeout = 6_000
                readTimeout = 6_000
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "ViniPlayAndroid/1.0")
                val cookie = ViniLogger.resolveCookieForUrl(urlStr, this@ViniPlaybackService)
                if (!cookie.isNullOrBlank()) {
                    setRequestProperty("Cookie", cookie)
                }
            }
            if (conn.responseCode !in 200..299) return null
            val bytes = conn.inputStream.use { it.readBytes() }
            if (bytes.isEmpty()) return null

            val boundsOpts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, boundsOpts)
            if (boundsOpts.outWidth <= 0 || boundsOpts.outHeight <= 0) return null

            var sampleSize = 1
            while (boundsOpts.outWidth / sampleSize > 512 || boundsOpts.outHeight / sampleSize > 512) {
                sampleSize *= 2
            }
            val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sampleSize }
            val raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, decodeOpts) ?: return null
            frameBitmapOnDarkSquare(raw, 256)
        } catch (_: Throwable) {
            null
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }

    /**
     * Centers channel logos (including transparent white PNGs) or VOD posters onto a clean 256x256
     * dark slate card so artwork never looks cropped or invisible on Android's media notification card.
     */
    private fun frameBitmapOnDarkSquare(src: Bitmap, targetPx: Int): Bitmap {
        val out = Bitmap.createBitmap(targetPx, targetPx, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        canvas.drawColor(Color.parseColor("#0F172A"))

        val aspect = src.width.toFloat() / src.height.toFloat().coerceAtLeast(1f)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)

        // If the image is nearly square and opaque (e.g. album/channel tile), fill cleanly; otherwise aspect-fit with subtle padding
        val margin = if (src.hasAlpha()) targetPx * 0.10f else if (aspect in 0.85f..1.18f) 0f else targetPx * 0.04f
        val avail = targetPx - margin * 2f
        val scale = minOf(avail / src.width.toFloat(), avail / src.height.toFloat())
        val dw = src.width * scale
        val dh = src.height * scale
        val left = (targetPx - dw) / 2f
        val top = (targetPx - dh) / 2f

        canvas.drawBitmap(src, null, RectF(left, top, left + dw, top + dh), paint)
        if (src != out) {
            try { src.recycle() } catch (_: Throwable) {}
        }
        return out
    }

    override fun onDestroy() {
        isPlayingMedia = false
        releaseMediaSession()
        releaseLocks()
        super.onDestroy()
    }

    private fun releaseMediaSession() {
        try {
            mediaSession?.isActive = false
            mediaSession?.release()
        } catch (_: Throwable) {}
        mediaSession = null
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun acquireLocks() {
        try {
            if (wakeLock == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ViniPlay::MediaWakeLock").apply {
                    setReferenceCounted(false)
                }
            }
            if (wakeLock?.isHeld == false) {
                wakeLock?.acquire(6 * 60 * 60 * 1000L)
            }
        } catch (_: Throwable) {}

        try {
            if (wifiLock == null) {
                val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                @Suppress("DEPRECATION")
                val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                } else {
                    WifiManager.WIFI_MODE_FULL_HIGH_PERF
                }
                wifiLock = wm.createWifiLock(mode, "ViniPlay::MediaWifiLock").apply {
                    setReferenceCounted(false)
                }
            }
            if (wifiLock?.isHeld == false) {
                wifiLock?.acquire()
            }
        } catch (_: Throwable) {}
    }

    private fun releaseLocks() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Throwable) {}
        try {
            if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (_: Throwable) {}
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                CHANNEL_ID,
                "ViniPlay Media Player",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Active media playback controls for Live TV, VOD, DVR, and Audio-Only mode"
                setShowBadge(false)
                setSound(null, null)
            }
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val contentPi = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val playPauseActionCode = if (isPlayingMedia) ACTION_PAUSE else ACTION_PLAY
        val playPausePi = PendingIntent.getService(
            this,
            1,
            Intent(this, ViniPlaybackService::class.java).apply { action = playPauseActionCode },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopPi = PendingIntent.getService(
            this,
            2,
            Intent(this, ViniPlaybackService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val playPauseAction = Notification.Action.Builder(
            Icon.createWithResource(this, if (isPlayingMedia) R.drawable.ic_pip_pause else R.drawable.ic_pip_play),
            if (isPlayingMedia) "Pause" else "Play",
            playPausePi
        ).build()

        val stopAction = Notification.Action.Builder(
            Icon.createWithResource(this, R.drawable.ic_notif_stop),
            "Stop",
            stopPi
        ).build()

        val mediaStyle = Notification.MediaStyle()
            .setShowActionsInCompactView(0, 1)
        mediaSession?.sessionToken?.let { token ->
            mediaStyle.setMediaSession(token)
        }

        val art = currentArtworkBitmap ?: defaultLogoBitmap
        val subtitleText = currentSubtitle.ifBlank { if (isPlayingMedia) "Playing in ViniPlay" else "Paused" }

        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_viniplay)
            .apply {
                if (art != null) setLargeIcon(art)
            }
            .setContentTitle(currentTitle)
            .setContentText(subtitleText)
            .setContentIntent(contentPi)
            .setDeleteIntent(stopPi)
            .setOngoing(isPlayingMedia)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .addAction(playPauseAction)
            .addAction(stopAction)
            .setStyle(mediaStyle)
            .build()
    }
}
