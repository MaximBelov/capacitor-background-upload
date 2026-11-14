package io.github.maximbelov.backgroundupload

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The one uploader of the process. WorkManager owns the queue and runs it after the app has been killed; this object
 * owns the stored events and the single listener, the plugin. There is no init call to make twice: a second plugin
 * instance simply replaces the listener.
 */
object Uploads {
    const val TAG = "background-upload"
    private const val UNIQUE_PREFIX = "background-upload:"

    @Volatile
    var listener: ((JSONObject) -> Unit)? = null

    @Volatile
    private var store: EventStore? = null

    fun events(context: Context): EventStore =
        store ?: synchronized(this) {
            store ?: EventStore(File(context.applicationContext.filesDir, "background-upload/events")).also { store = it }
        }

    fun uniqueName(id: String) = UNIQUE_PREFIX + id

    /** Queues the upload; an upload with the same id that is queued or running is replaced. */
    fun enqueue(context: Context, spec: UploadSpec, notificationTitle: String) {
        val input = Data.Builder()
            .putString(UploadWorker.KEY_ID, spec.id)
            .putString(UploadWorker.KEY_URL, spec.serverUrl)
            .putString(UploadWorker.KEY_FILE, spec.filePath)
            .putString(UploadWorker.KEY_FILE_KEY, spec.fileKey)
            .putString(UploadWorker.KEY_METHOD, spec.method)
            .putString(UploadWorker.KEY_PARAMETERS, JSONArray(spec.parameters.map { JSONArray(listOf(it.first, it.second)) }).toString())
            .putString(UploadWorker.KEY_HEADERS, JSONObject(spec.headers as Map<*, *>).toString())
            .putString(UploadWorker.KEY_TITLE, notificationTitle)
            .build()
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setInputData(input)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            // Started at once where the quota allows. Measured on a Pixel 10a (Android 16): the system refuses the
            // foreground service the worker asks for (ForegroundServiceStartNotAllowedException) with the job expedited
            // or not, and the upload runs as a job without it.
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .addTag(TAG)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(uniqueName(spec.id), ExistingWorkPolicy.REPLACE, request)
    }

    /** Cancels and forgets an upload, and drops its stored events. */
    fun remove(context: Context, id: String) {
        WorkManager.getInstance(context).cancelUniqueWork(uniqueName(id)).result.get()
        events(context).removeAll(id)
    }

    /** Stores a terminal event, then reports it. */
    fun finish(context: Context, event: JSONObject) {
        emit(events(context).add(event))
    }

    fun emit(event: JSONObject) {
        listener?.invoke(event)
    }
}
