package io.github.maximbelov.backgroundupload

import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLConnection
import java.util.UUID

/** Everything one multipart request needs. */
data class UploadSpec(
    val id: String,
    val serverUrl: String,
    val filePath: String,
    val fileKey: String = "file",
    val parameters: List<Pair<String, String>> = emptyList(),
    val headers: Map<String, String> = emptyMap(),
    val method: String = "POST",
)

data class HttpResponse(val statusCode: Int, val body: String)

/**
 * A `multipart/form-data` body: the parameters in order, then the file. Its length is known before anything is sent,
 * so the request is streamed with a fixed length and the file is never held in memory.
 */
class MultipartBody(
    private val parameters: List<Pair<String, String>>,
    private val fileKey: String,
    private val file: File,
    val boundary: String = "BackgroundUpload-" + UUID.randomUUID(),
    mimeType: String = MimeTypes.forFileName(file.name),
) {
    private val head: ByteArray
    private val tail: ByteArray = "\r\n--$boundary--\r\n".toByteArray(Charsets.UTF_8)

    init {
        val text = StringBuilder()
        for ((name, value) in parameters) {
            text.append("--").append(boundary).append("\r\n")
            text.append("Content-Disposition: form-data; name=\"").append(escape(name)).append("\"\r\n\r\n")
            text.append(value).append("\r\n")
        }
        text.append("--").append(boundary).append("\r\n")
        text.append("Content-Disposition: form-data; name=\"").append(escape(fileKey))
            .append("\"; filename=\"").append(escape(file.name)).append("\"\r\n")
        text.append("Content-Type: ").append(mimeType).append("\r\n\r\n")
        head = text.toString().toByteArray(Charsets.UTF_8)
    }

    val contentType: String get() = "multipart/form-data; boundary=$boundary"

    val contentLength: Long get() = head.size + file.length() + tail.size

    /** Writes the body, telling [onProgress] how many bytes are out, and stops with an exception once [isCancelled]. */
    fun writeTo(output: OutputStream, onProgress: (Long, Long) -> Unit = { _, _ -> }, isCancelled: () -> Boolean = { false }) {
        val total = contentLength
        var sent = 0L
        output.write(head)
        sent += head.size
        FileInputStream(file).use { input -> sent = copy(input, output, sent, total, onProgress, isCancelled) }
        output.write(tail)
        sent += tail.size
        onProgress(sent, total)
    }

    private fun copy(
        input: InputStream,
        output: OutputStream,
        start: Long,
        total: Long,
        onProgress: (Long, Long) -> Unit,
        isCancelled: () -> Boolean,
    ): Long {
        val buffer = ByteArray(64 * 1024)
        var sent = start
        while (true) {
            if (isCancelled()) throw InterruptedIOException("cancelled")
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            sent += read
            onProgress(sent, total)
        }
        return sent
    }

    companion object {
        /** A field or file name made safe for a quoted `Content-Disposition` value, the way browsers do it. */
        fun escape(value: String): String = value.replace("\"", "%22").replace("\r", "%0D").replace("\n", "%0A")
    }
}

object MimeTypes {
    private val known = mapOf(
        "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "png" to "image/png", "gif" to "image/gif",
        "heic" to "image/heic", "webp" to "image/webp", "pdf" to "application/pdf",
        "xls" to "application/vnd.ms-excel",
        "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "csv" to "text/csv", "txt" to "text/plain", "json" to "application/json",
        "mp4" to "video/mp4", "mov" to "video/quicktime",
    )

    fun forFileName(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        if (ext.isEmpty()) return "application/octet-stream"
        return known[ext] ?: URLConnection.guessContentTypeFromName(name) ?: "application/octet-stream"
    }
}

/** Sends one multipart request with `HttpURLConnection`: no third-party HTTP client. Pure JVM, so JUnit runs it. */
object HttpUploader {
    var connectTimeoutMs = 15_000
    var readTimeoutMs = 60_000

    /** The server's response, whatever its status; an [IOException] when there was none. */
    @Throws(IOException::class)
    fun send(
        spec: UploadSpec,
        onProgress: (Long, Long) -> Unit = { _, _ -> },
        isCancelled: () -> Boolean = { false },
        mimeType: (String) -> String = MimeTypes::forFileName,
    ): HttpResponse {
        val file = File(spec.filePath)
        if (!file.isFile) throw java.io.FileNotFoundException(spec.filePath)
        val body = MultipartBody(spec.parameters, spec.fileKey, file, mimeType = mimeType(file.name))
        val connection = URL(spec.serverUrl).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = spec.method.uppercase()
            connection.doOutput = true
            connection.useCaches = false
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.instanceFollowRedirects = true
            for ((name, value) in spec.headers) connection.setRequestProperty(name, value)
            connection.setRequestProperty("Content-Type", body.contentType)
            connection.setFixedLengthStreamingMode(body.contentLength)
            connection.outputStream.use { output -> body.writeTo(output, onProgress, isCancelled) }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            return HttpResponse(status, text)
        } finally {
            connection.disconnect()
        }
    }
}
