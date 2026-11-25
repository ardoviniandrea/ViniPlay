package com.viniplay.app

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class NotificationAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        ViniLogger.init(context)
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            ViniLogger.log("ALARM", "Device rebooted, rescheduling saved notifications")
            NotificationScheduler.rescheduleSaved(context)
            return
        }

        if (intent.action == NotificationScheduler.ACTION_PROGRAM_REMINDER) {
            val notifId = intent.getIntExtra("notif_id", (System.currentTimeMillis() % 100000).toInt())
            val programTitle = intent.getStringExtra("program_title") ?: "Upcoming Program"
            val channelName = intent.getStringExtra("channel_name") ?: "ViniPlay"
            val channelId = intent.getStringExtra("channel_id") ?: ""
            val programStart = intent.getStringExtra("program_start") ?: ""
            val programId = intent.getStringExtra("program_id") ?: ""

            val formattedStart = try {
                val instant = Instant.parse(programStart)
                val formatter = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())
                formatter.format(instant)
            } catch (e: Exception) {
                ""
            }

            val bodyText = if (formattedStart.isNotEmpty()) {
                "Starting at $formattedStart on $channelName"
            } else {
                "Upcoming on $channelName"
            }

            ViniLogger.log("ALARM", "Firing native reminder notification: $programTitle ($bodyText)")

            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channelKey = "viniplay_reminders"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val chan = NotificationChannel(
                    channelKey,
                    "TV Guide Reminders",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Reminders for scheduled TV programs"
                    enableVibration(true)
                }
                nm.createNotificationChannel(chan)
            }

            val tapIntent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("navigate_channel_id", channelId)
                putExtra("navigate_program_start", programStart)
                putExtra("navigate_program_id", programId)
            }
            val pendingTap = PendingIntent.getActivity(
                context,
                notifId,
                tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val largeIconBitmap = try {
                BitmapFactory.decodeResource(context.resources, R.drawable.viniplay_notif_large)
            } catch (_: Throwable) {
                null
            }

            val notification = NotificationCompat.Builder(context, channelKey)
                .setSmallIcon(R.drawable.ic_stat_viniplay)
                .apply {
                    if (largeIconBitmap != null) setLargeIcon(largeIconBitmap)
                }
                .setContentTitle("Upcoming: $programTitle")
                .setContentText(bodyText)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setContentIntent(pendingTap)
                .build()

            nm.notify(notifId, notification)
        }
    }
}

object NotificationScheduler {
    const val ACTION_PROGRAM_REMINDER = "com.viniplay.app.ACTION_PROGRAM_REMINDER"
    private const val PREFS_NAME = "viniplay_prefs"
    private const val KEY_SAVED_NOTIFS = "saved_notifications_json"
    private const val KEY_SCHEDULED_IDS = "scheduled_notif_ids"

    fun syncFromJson(context: Context, jsonArrayString: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_SAVED_NOTIFS, jsonArrayString).apply()
        scheduleAll(context, jsonArrayString)
    }

    fun rescheduleSaved(context: Context) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_SAVED_NOTIFS, null) ?: return
        scheduleAll(context, saved)
    }

    private fun scheduleAll(context: Context, jsonArrayString: String) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        // Cancel previously scheduled alarms
        val oldIds = prefs.getStringSet(KEY_SCHEDULED_IDS, emptySet()) ?: emptySet()
        for (idStr in oldIds) {
            val reqCode = idStr.toIntOrNull() ?: continue
            val cancelIntent = Intent(context, NotificationAlarmReceiver::class.java).apply {
                action = ACTION_PROGRAM_REMINDER
            }
            val pi = PendingIntent.getBroadcast(
                context,
                reqCode,
                cancelIntent,
                PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
            )
            if (pi != null) {
                alarmManager.cancel(pi)
                pi.cancel()
            }
        }

        val newIds = mutableSetOf<String>()
        val nowMs = System.currentTimeMillis()
        var scheduledCount = 0

        try {
            val arr = JSONArray(jsonArrayString)
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                val scheduledTimeStr = obj.optString("scheduledTime", "")
                if (scheduledTimeStr.isEmpty()) continue

                val triggerMs = try {
                    Instant.parse(scheduledTimeStr).toEpochMilli()
                } catch (e: Exception) {
                    continue
                }

                // Skip past reminders
                if (triggerMs <= nowMs - 30_000L) continue

                val rawId = obj.optInt("id", ( obj.optString("programId", "").hashCode() and 0x7FFFFFFF ))
                val reqCode = 20000 + (rawId % 50000)

                val alarmIntent = Intent(context, NotificationAlarmReceiver::class.java).apply {
                    action = ACTION_PROGRAM_REMINDER
                    putExtra("notif_id", reqCode)
                    putExtra("program_title", obj.optString("programTitle", "Upcoming Program"))
                    putExtra("channel_name", obj.optString("channelName", "ViniPlay"))
                    putExtra("channel_id", obj.optString("channelId", ""))
                    putExtra("program_start", obj.optString("programStart", ""))
                    putExtra("program_id", obj.optString("programId", ""))
                }

                val pi = PendingIntent.getBroadcast(
                    context,
                    reqCode,
                    alarmIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )

                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) {
                        alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi)
                    } else {
                        alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi)
                    }
                    newIds.add(reqCode.toString())
                    scheduledCount++
                } catch (se: SecurityException) {
                    alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi)
                    newIds.add(reqCode.toString())
                    scheduledCount++
                }
            }
        } catch (e: Exception) {
            ViniLogger.log("ALARM", "Error parsing notifications JSON", e.message)
        }

        prefs.edit().putStringSet(KEY_SCHEDULED_IDS, newIds).apply()
        ViniLogger.log("ALARM", "Synced $scheduledCount upcoming native program alarms")
    }
}
