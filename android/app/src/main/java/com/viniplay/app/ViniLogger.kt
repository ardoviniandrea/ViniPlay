package com.viniplay.app

import android.content.Context
import android.os.Build
import android.util.Log
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.PrintWriter
import java.io.StringWriter
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

object ViniLogger {
    private const val PREFS_NAME = "viniplay_prefs"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_SERVER_URL = "server_url"
    private const val KEY_LAST_CRASH = "last_crash_log"

    private val ringBuffer = ConcurrentLinkedQueue<String>()
    private val pendingServerLogs = ConcurrentLinkedQueue<JSONObject>()
    private val executor = Executors.newSingleThreadScheduledExecutor()

    @Volatile
    private var serverUrl: String = ""
    @Volatile
    private var activeOriginUrl: String = ""
    @Volatile
    private var deviceId: String = "android-app"
    @Volatile
    private var initialized = false

    fun init(context: Context) {
        val appCtx = context.applicationContext
        val prefs = appCtx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        serverUrl = prefs.getString(KEY_SERVER_URL, "") ?: ""
        if (activeOriginUrl.isEmpty()) {
            activeOriginUrl = serverUrl
        }
        var savedId = prefs.getString(KEY_DEVICE_ID, null)
        if (savedId.isNullOrBlank()) {
            val cleanModel = Build.MODEL.replace(Regex("[^a-zA-Z0-9_-]"), "")
            val shortUuid = UUID.randomUUID().toString().take(6)
            savedId = "android-${cleanModel.ifEmpty { "device" }}-$shortUuid"
            prefs.edit().putString(KEY_DEVICE_ID, savedId).apply()
        }
        deviceId = savedId

        // Check if previous session recorded an uncaught crash
        val prevCrash = prefs.getString(KEY_LAST_CRASH, null)
        if (!prevCrash.isNullOrBlank()) {
            prefs.edit().remove(KEY_LAST_CRASH).apply()
            log("CRASH_REPORT", "Previous session uncaught exception", prevCrash, immediate = false)
        }

        if (!initialized) {
            initialized = true
            val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
                try {
                    val sw = StringWriter()
                    throwable.printStackTrace(PrintWriter(sw))
                    val stackStr = sw.toString().take(2500)
                    Log.e("ViniPlay-CRASH", "Uncaught exception on ${thread.name}: $stackStr")
                    prefs.edit().putString(KEY_LAST_CRASH, "Thread ${thread.name}: $stackStr").commit()
                    val crashEntry = JSONObject().apply {
                        put("tag", "ANDROID:CRASH")
                        put("message", "Uncaught exception on thread ${thread.name}: ${throwable.message}")
                        put("data", stackStr)
                    }
                    pendingServerLogs.add(crashEntry)
                    flushToServer()
                } catch (_: Throwable) {}
                defaultHandler?.uncaughtException(thread, throwable)
            }
            executor.scheduleWithFixedDelay({ flushToServer() }, 2, 3, TimeUnit.SECONDS)
        }
    }

    fun updateServerUrl(context: Context, url: String) {
        val normalized = url.trim().trimEnd('/')
        serverUrl = normalized
        if (activeOriginUrl.isEmpty()) {
            activeOriginUrl = normalized
        }
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SERVER_URL, normalized)
            .apply()
    }

    fun updateActiveOriginFromWebView(url: String?) {
        if (url.isNullOrBlank()) return
        try {
            val parsed = URL(url)
            val scheme = parsed.protocol ?: return
            val host = parsed.host ?: return
            if ((scheme == "http" || scheme == "https") && host.isNotEmpty()) {
                val portPart = if (parsed.port != -1 && parsed.port != 80 && parsed.port != 443) ":${parsed.port}" else ""
                activeOriginUrl = "$scheme://$host$portPart"
            }
        } catch (_: Throwable) {}
    }

    fun getEffectiveBaseUrl(context: Context? = null): String {
        if (activeOriginUrl.isNotEmpty()) return activeOriginUrl
        if (serverUrl.isNotEmpty()) return serverUrl
        if (context != null) {
            val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            serverUrl = prefs.getString(KEY_SERVER_URL, "") ?: ""
        }
        return serverUrl
    }

    fun getServerUrl(context: Context): String {
        if (serverUrl.isNotEmpty()) return serverUrl
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        serverUrl = prefs.getString(KEY_SERVER_URL, "") ?: ""
        return serverUrl
    }

    fun resolveCookieForUrl(urlStr: String, context: Context? = null): String? {
        return try {
            val cm = CookieManager.getInstance()
            val direct = cm.getCookie(urlStr)
            if (!direct.isNullOrBlank()) return direct
            val parsed = URL(urlStr)
            val portPart = if (parsed.port != -1 && parsed.port != 80 && parsed.port != 443) ":${parsed.port}" else ""
            val origin = "${parsed.protocol}://${parsed.host}$portPart"
            val originCookie = cm.getCookie(origin)
            if (!originCookie.isNullOrBlank()) return originCookie
            val base = getEffectiveBaseUrl(context)
            if (base.isNotEmpty()) cm.getCookie(base) else null
        } catch (_: Throwable) {
            null
        }
    }

    fun log(tag: String, message: String, data: String? = null, immediate: Boolean = false) {
        Log.d("ViniPlay-$tag", if (data != null) "$message | $data" else message)
        val ts = SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date())
        val line = "[$ts] [$tag] $message" + (if (!data.isNullOrEmpty()) " ($data)" else "")
        ringBuffer.add(line)
        while (ringBuffer.size > 300) {
            ringBuffer.poll()
        }

        val entry = JSONObject().apply {
            put("tag", "ANDROID:$tag")
            put("message", message)
            if (!data.isNullOrEmpty()) {
                put("data", data)
            }
        }
        pendingServerLogs.add(entry)
        while (pendingServerLogs.size > 200) {
            pendingServerLogs.poll()
        }

        if (immediate) {
            flushNow()
        }
    }

    fun flushNow() {
        try {
            executor.execute { flushToServer() }
        } catch (_: Throwable) {}
    }

    private fun flushToServer() {
        val base = getEffectiveBaseUrl()
        if (base.isEmpty() || pendingServerLogs.isEmpty()) return

        val cookie = resolveCookieForUrl(base)
        if (cookie.isNullOrBlank()) {
            // Keep logs in pendingServerLogs until WebView session cookie is available
            return
        }

        val batch = JSONArray()
        val tempItems = mutableListOf<JSONObject>()
        while (batch.length() < 40) {
            val item = pendingServerLogs.poll() ?: break
            batch.put(item)
            tempItems.add(item)
        }
        if (batch.length() == 0) return

        var conn: HttpURLConnection? = null
        try {
            val payload = JSONObject().apply {
                put("deviceId", deviceId)
                put("logs", batch)
            }

            val targetUrl = URL("$base/api/logs/client")
            conn = (targetUrl.openConnection() as HttpURLConnection).apply {
                if (this is javax.net.ssl.HttpsURLConnection) {
                    val defaultVerifier = javax.net.ssl.HttpsURLConnection.getDefaultHostnameVerifier()
                    hostnameVerifier = javax.net.ssl.HostnameVerifier { host, session ->
                        defaultVerifier.verify(host, session) ||
                            (host.contains('_') && defaultVerifier.verify(host.replace('_', '-'), session)) ||
                            host.equals(targetUrl.host, ignoreCase = true)
                    }
                }
                requestMethod = "POST"
                connectTimeout = 8_000
                readTimeout = 8_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Cookie", cookie)
                val csrfMatch = Regex("(?:^|;\\s*)viniplay_csrf=([^;]+)").find(cookie)
                if (csrfMatch != null) {
                    setRequestProperty("X-CSRF-Token", java.net.URLDecoder.decode(csrfMatch.groupValues[1], "UTF-8"))
                }
                setRequestProperty("User-Agent", "ViniPlayAndroid/1.0")
            }
            conn.outputStream.use { os ->
                os.write(payload.toString().toByteArray(Charsets.UTF_8))
            }

            val code = conn.responseCode
            if (code == 401) {
                for (item in tempItems) {
                    if (pendingServerLogs.size < 200) pendingServerLogs.add(item)
                }
            }
        } catch (_: Exception) {
            for (item in tempItems) {
                if (pendingServerLogs.size < 200) pendingServerLogs.add(item)
            }
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) {}
        }
    }

    fun getRecentLogsText(): String {
        return ringBuffer.joinToString("\n")
    }
}
