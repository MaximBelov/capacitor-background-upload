package io.github.maximbelov.backgroundupload

import java.io.File
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/** Turns what JavaScript passes as `filePath` into a path on disk; the same rules as on iOS. */
object FilePath {
    private const val CAPACITOR_FILE_PREFIX = "/_capacitor_file_"

    /** An absolute path for an absolute path, a `file://` URL or a `convertFileSrc()` URL; null for anything else. */
    fun resolve(value: String): String? {
        val trimmed = value.trim()
        if (trimmed.startsWith("/")) return trimmed
        val uri = try {
            URI(trimmed.replace(" ", "%20"))
        } catch (e: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        val path = uri.rawPath?.let { decode(it) } ?: return null
        return when (scheme) {
            "file" -> path.takeIf { it.startsWith("/") }
            "capacitor", "http", "https", "ionic" ->
                if (path.startsWith(CAPACITOR_FILE_PREFIX)) {
                    path.removePrefix(CAPACITOR_FILE_PREFIX).takeIf { it.startsWith("/") }
                } else {
                    null
                }
            else -> null
        }
    }

    /** The bare file name, which is what the multipart part carries on both platforms. */
    fun fileName(path: String): String = File(path).name

    private fun decode(value: String): String = URLDecoder.decode(value.replace("+", "%2B"), StandardCharsets.UTF_8.name())
}
