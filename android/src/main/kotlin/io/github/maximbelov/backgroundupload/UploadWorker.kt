package io.github.maximbelov.backgroundupload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException

/**
 * One attempt at one upload. Any response ends the upload; no response (`IOException`) asks WorkManager to run it again
 * after its backoff, until [Outcome.MAX_ATTEMPTS] attempts have been made.
 */
class UploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    companion object {
        const val KEY_ID = "id"
        const val KEY_URL = "serverUrl"
        const val KEY_FILE = "filePath"
        const val KEY_FILE_KEY = "fileKey"
        const val KEY_METHOD = "method"
        const val KEY_PARAMETERS = "parameters"
        const val KEY_HEADERS = "headers"
        const val KEY_TITLE = "notificationTitle"
        const val CHANNEL_ID = "background-upload"
        private const val LOG_TAG = "BackgroundUpload"
        private const val PROGRESS_INTERVAL_MS = 1000L
    }

    private val id: String = inputData.getString(KEY_ID) ?: ""
    private val title: String = inputData.getString(KEY_TITLE) ?: "Uploading files"
    private val notificationId: Int = (Uploads.TAG + id).hashCode()

    override fun doWork(): Result {
        if (id.isEmpty()) return Result.failure()
        val attempt = runAttemptCount + 1
        val spec = readSpec()
        val file = File(spec.filePath)
        if (!file.isFile || !file.canRead()) {
            return terminal(failed("Could not read ${spec.filePath}", UploadErrorCode.FILE_UNREADABLE))
        }
        try {
            setForegroundAsync(foregroundInfo(0)).get()
        } catch (e: Exception) {
            // Android 12 and later refuse a foreground service started from the background; the upload still runs.
            Log.i(LOG_TAG, "running without a foreground notification: ${e.message}")
        }

        var lastPercent = -1
        var lastSent = 0L
        val started = System.currentTimeMillis()
        val response = try {
            HttpUploader.send(
                spec,
                onProgress = { sent, total ->
                    val percent = if (total > 0) (sent * 100 / total).toInt() else 0
                    val now = System.currentTimeMillis()
                    if (percent != lastPercent && (percent == 100 || now - lastSent >= PROGRESS_INTERVAL_MS)) {
                        lastPercent = percent
                        lastSent = now
                        Uploads.emit(JSONObject().put("id", id).put("state", "UPLOADING").put("progress", percent))
                        notify(percent)
                    }
                },
                isCancelled = { isStopped },
                mimeType = ::mimeTypeFromAndroid,
            )
        } catch (e: IOException) {
            if (isStopped) return Result.retry() // cancelled or stopped by the system: WorkManager decides what follows
            return when (Outcome.decide(null, attempt)) {
                is Outcome.GaveUp -> terminal(
                    failed("Gave up after $attempt attempts: ${e.message ?: e.javaClass.simpleName}", UploadErrorCode.ATTEMPTS_EXHAUSTED),
                )
                else -> {
                    Log.i(LOG_TAG, "attempt $attempt of $id got no response, retrying: ${e.message}")
                    Result.retry()
                }
            }
        }
        if (isStopped) return Result.retry()
        val finished = System.currentTimeMillis()
        val event = when (val outcome = Outcome.decide(response.statusCode, attempt)) {
            is Outcome.Uploaded -> JSONObject()
                .put("id", id)
                .put("state", "UPLOADED")
                .put("statusCode", outcome.statusCode)
                .put("serverResponse", response.body)
                .put("uploadDuration", finished - started)
                .put("finishUploadTime", finished)
            else -> failed("The server answered ${response.statusCode}", UploadErrorCode.HTTP_STATUS)
                .put("statusCode", response.statusCode)
                .put("serverResponse", response.body)
        }
        return terminal(event)
    }

    override fun getForegroundInfo(): ForegroundInfo = foregroundInfo(0)

    private fun terminal(event: JSONObject): Result {
        Uploads.finish(applicationContext, event)
        return Result.success()
    }

    private fun failed(error: String, code: Int): JSONObject =
        JSONObject().put("id", id).put("state", "FAILED").put("error", error).put("errorCode", code)

    private fun readSpec(): UploadSpec {
        val parameters = JSONArray(inputData.getString(KEY_PARAMETERS) ?: "[]").let { array ->
            (0 until array.length()).map { array.getJSONArray(it).let { pair -> pair.getString(0) to pair.getString(1) } }
        }
        val headers = JSONObject(inputData.getString(KEY_HEADERS) ?: "{}").let { obj ->
            obj.keys().asSequence().associateWith { obj.getString(it) }
        }
        return UploadSpec(
            id = id,
            serverUrl = inputData.getString(KEY_URL) ?: "",
            filePath = inputData.getString(KEY_FILE) ?: "",
            fileKey = inputData.getString(KEY_FILE_KEY) ?: "file",
            parameters = parameters,
            headers = headers,
            method = inputData.getString(KEY_METHOD) ?: "POST",
        )
    }

    private fun notification(percent: Int): Notification {
        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Uploads", NotificationManager.IMPORTANCE_LOW))
        }
        return NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(title)
            .setContentText(File(inputData.getString(KEY_FILE) ?: "").name)
            .setProgress(100, percent, false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build()
    }

    private fun foregroundInfo(percent: Int): ForegroundInfo =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(notificationId, notification(percent), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(notificationId, notification(percent))
        }

    private fun notify(percent: Int) {
        try {
            setForegroundAsync(foregroundInfo(percent))
        } catch (e: Exception) {
            // not in the foreground: nothing to update
        }
    }
}

internal fun mimeTypeFromAndroid(name: String): String {
    val ext = name.substringAfterLast('.', "").lowercase()
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: MimeTypes.forFileName(name)
}
