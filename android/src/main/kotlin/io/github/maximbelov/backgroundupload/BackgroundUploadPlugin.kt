package io.github.maximbelov.backgroundupload

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.util.concurrent.Executors

@CapacitorPlugin(name = "BackgroundUpload")
class BackgroundUploadPlugin : Plugin() {
    private val executor = Executors.newSingleThreadExecutor()
    private val listener: (JSONObject) -> Unit = { event -> deliver(event) }

    override fun load() {
        // The uploader has one listener: this plugin. A plugin made later (a new bridge) takes it over.
        Uploads.listener = listener
        // Terminal events left from earlier runs are held until the first listener is added.
        executor.execute {
            for (event in Uploads.events(context).all()) {
                notifyListeners(EVENT, JSObject.fromJSONObject(event), true)
            }
        }
    }

    override fun handleOnDestroy() {
        if (Uploads.listener === listener) Uploads.listener = null
        executor.shutdown()
    }

    private fun deliver(event: JSONObject) {
        val terminal = event.optString("state") != "UPLOADING"
        notifyListeners(EVENT, JSObject.fromJSONObject(event), terminal)
    }

    @PluginMethod
    fun startUpload(call: PluginCall) {
        val id = call.getString("id").orEmpty()
        val serverUrl = call.getString("serverUrl").orEmpty()
        val rawPath = call.getString("filePath").orEmpty()
        when {
            id.isEmpty() -> return call.reject("id is required", "MISSING_OPTION")
            serverUrl.isEmpty() -> return call.reject("serverUrl is required", "MISSING_OPTION")
            rawPath.isEmpty() -> return call.reject("filePath is required", "MISSING_OPTION")
            !isHttpUrl(serverUrl) -> return call.reject("serverUrl is not an http(s) URL: $serverUrl", "INVALID_URL")
        }
        val path = FilePath.resolve(rawPath)
        if (path == null || !File(path).isFile) return call.reject("No file at $rawPath", "FILE_NOT_FOUND")

        val spec = UploadSpec(
            id = id,
            serverUrl = serverUrl,
            filePath = path,
            fileKey = call.getString("fileKey")?.takeIf { it.isNotEmpty() } ?: "file",
            parameters = strings(call.getObject("parameters")).toList().sortedBy { it.first },
            headers = strings(call.getObject("headers")),
            method = (call.getString("requestMethod")?.takeIf { it.isNotEmpty() } ?: "POST").uppercase(),
        )
        val title = call.getString("notificationTitle")?.takeIf { it.isNotEmpty() } ?: "Uploading files"
        executor.execute {
            try {
                Uploads.enqueue(context, spec, title)
                call.resolve()
            } catch (e: Exception) {
                call.reject(e.message ?: "Could not queue the upload", e)
            }
        }
    }

    @PluginMethod
    fun removeUpload(call: PluginCall) {
        val id = call.getString("id").orEmpty()
        if (id.isEmpty()) return call.reject("id is required", "MISSING_OPTION")
        executor.execute {
            try {
                Uploads.remove(context, id)
                call.resolve()
            } catch (e: Exception) {
                call.reject(e.message ?: "Could not remove the upload", e)
            }
        }
    }

    @PluginMethod
    fun acknowledgeEvent(call: PluginCall) {
        val eventId = call.getString("eventId").orEmpty()
        if (eventId.isEmpty()) return call.reject("eventId is required", "MISSING_OPTION")
        executor.execute {
            Uploads.events(context).remove(eventId)
            call.resolve()
        }
    }

    companion object {
        const val EVENT = "event"

        fun isHttpUrl(value: String): Boolean = try {
            val uri = URI(value)
            (uri.scheme?.lowercase() == "http" || uri.scheme?.lowercase() == "https") && !uri.host.isNullOrEmpty()
        } catch (e: Exception) {
            false
        }

        /** Form values arrive as strings, numbers or booleans; all are sent as text. */
        fun strings(obj: JSONObject?): Map<String, String> {
            if (obj == null) return emptyMap()
            return obj.keys().asSequence().mapNotNull { key ->
                when (val value = obj.opt(key)) {
                    is String -> key to value
                    is Number, is Boolean -> key to value.toString()
                    else -> null
                }
            }.toMap()
        }
    }
}
