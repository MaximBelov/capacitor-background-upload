package io.github.maximbelov.backgroundupload

import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Terminal events kept until JavaScript acknowledges them: one JSON file each, written to a temporary file and renamed,
 * so a kill at any moment leaves either the old file or the new one.
 */
class EventStore(private val directory: File) {
    init {
        directory.mkdirs()
    }

    /** Stores the event under a new `eventId` and returns it with that id set. */
    @Synchronized
    fun add(event: JSONObject, now: Long = System.currentTimeMillis()): JSONObject {
        val stored = JSONObject(event.toString())
        val eventId = UUID.randomUUID().toString()
        stored.put("eventId", eventId)
        val entry = JSONObject().put("t", now).put("event", stored)
        val target = file(eventId)
        val temporary = File(directory, "$eventId.tmp")
        temporary.writeText(entry.toString())
        if (!temporary.renameTo(target)) {
            target.writeText(entry.toString())
            temporary.delete()
        }
        return stored
    }

    @Synchronized
    fun remove(eventId: String) {
        file(eventId).delete()
    }

    /** Drops every stored event of one upload. */
    @Synchronized
    fun removeAll(uploadId: String) {
        for ((_, event) in entries()) {
            if (event.optString("id") == uploadId) file(event.optString("eventId")).delete()
        }
    }

    /** Every stored event, oldest first. */
    @Synchronized
    fun all(): List<JSONObject> = entries().sortedBy { it.first }.map { it.second }

    private fun entries(): List<Pair<Long, JSONObject>> =
        (directory.listFiles { f -> f.name.endsWith(".json") } ?: emptyArray()).mapNotNull { f ->
            try {
                val entry = JSONObject(f.readText())
                entry.optLong("t") to entry.getJSONObject("event")
            } catch (e: Exception) {
                null
            }
        }

    /** The event id in hex, so that nothing it contains can leave the directory. */
    private fun file(eventId: String): File =
        File(directory, eventId.toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it) } + ".json")
}
