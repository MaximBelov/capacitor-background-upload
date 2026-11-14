package io.github.maximbelov.backgroundupload

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.random.Random

/**
 * The request the plugin sends, received by a real HTTP server on 127.0.0.1: a plain socket that reads the request whole
 * and answers (android.jar on the test classpath hides the JDK's own com.sun.net.httpserver from Kotlin).
 */
class HttpUploaderTest {
    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var server: ServerSocket
    private val received = CopyOnWriteArrayList<Triple<String, Map<String, String>, ByteArray>>()

    /** What the server answers: a status and a body, or null to close the connection without answering. */
    @Volatile
    private var respond: (Int) -> Pair<Int, String>? = { 200 to "ok" }

    private val url get() = "http://127.0.0.1:${server.localPort}/upload"

    @Before
    fun start() {
        server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        Thread {
            while (!server.isClosed) {
                val socket = try {
                    server.accept()
                } catch (e: IOException) {
                    break
                }
                Thread { serve(socket) }.start()
            }
        }.start()
    }

    @After
    fun stop() = server.close()

    private fun serve(socket: Socket) = socket.use {
        val input = socket.getInputStream().buffered()
        val head = StringBuilder()
        while (!head.endsWith("\r\n\r\n")) {
            val b = input.read()
            if (b < 0) return
            head.append(b.toChar())
        }
        val lines = head.trim().split("\r\n")
        val method = lines.first().substringBefore(' ')
        val headers = lines.drop(1).associate { it.substringBefore(':').trim().lowercase() to it.substringAfter(':').trim() }
        val length = headers["content-length"]?.toInt() ?: 0
        val body = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(body, read, length - read)
            if (n < 0) return
            read += n
        }
        received.add(Triple(method, headers, body))
        val reply = respond(received.size - 1) ?: return
        val bytes = reply.second.toByteArray()
        val out = socket.getOutputStream()
        out.write("HTTP/1.1 ${reply.first} X\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
        out.write(bytes)
        out.flush()
    }

    private fun file(name: String, size: Int): Pair<File, ByteArray> {
        val bytes = Random(42).nextBytes(size)
        val file = folder.newFile(name)
        file.writeBytes(bytes)
        return file to bytes
    }

    @Test
    fun aFileArrivesWholeAfterItsFieldsWithItsBareName() {
        val (file, bytes) = file("photo.jpg", 3_000_000)
        respond = { 201 to "<PostResponse><Key>uploads/photo.jpg</Key></PostResponse>" }
        val progress = mutableListOf<Long>()

        val response = HttpUploader.send(
            UploadSpec(
                id = "photo.jpg",
                serverUrl = url,
                filePath = file.absolutePath,
                parameters = listOf("key" to "uploads/photo.jpg", "policy" to "p"),
                headers = mapOf("X-Test" to "1"),
            ),
            onProgress = { sent, _ -> progress.add(sent) },
        )

        assertEquals(201, response.statusCode)
        assertEquals("<PostResponse><Key>uploads/photo.jpg</Key></PostResponse>", response.body)
        val (method, headers, body) = received.single()
        assertEquals("POST", method)
        assertEquals("1", headers["x-test"])
        val parts = parse(body, headers.getValue("content-type"))
        assertEquals(3, parts.size)
        assertTrue(parts[0].first.contains("name=\"key\""))
        assertEquals("uploads/photo.jpg", String(parts[0].second))
        assertTrue(parts[1].first.contains("name=\"policy\""))
        assertTrue(parts[2].first, parts[2].first.contains("name=\"file\"; filename=\"photo.jpg\""))
        assertTrue(parts[2].first.contains("Content-Type: image/jpeg"))
        assertArrayEquals(bytes, parts[2].second)
        assertEquals(progress.sorted(), progress)
        assertEquals(body.size.toLong(), progress.last())
    }

    @Test
    fun aResponseOutside2xxIsReturnedWithItsBody() {
        val (file, _) = file("a.pdf", 1000)
        respond = { 403 to "<Error><Code>AccessDenied</Code></Error>" }
        val response = HttpUploader.send(UploadSpec("a.pdf", url, file.absolutePath))
        assertEquals(403, response.statusCode)
        assertEquals("<Error><Code>AccessDenied</Code></Error>", response.body)
        assertEquals(Outcome.Rejected(403), Outcome.decide(response.statusCode, 1))
    }

    @Test
    fun noResponseIsAnIOException() {
        val (file, _) = file("b.jpg", 1000)
        respond = { null }
        try {
            HttpUploader.send(UploadSpec("b.jpg", url, file.absolutePath))
            fail("expected an IOException")
        } catch (e: IOException) {
            assertEquals(Outcome.Retry, Outcome.decide(null, 1))
        }
    }

    @Test
    fun aCancelledUploadStopsWriting() {
        val (file, _) = file("c.jpg", 2_000_000)
        var calls = 0
        try {
            HttpUploader.send(UploadSpec("c.jpg", url, file.absolutePath), isCancelled = { ++calls > 3 })
            fail("expected the upload to stop")
        } catch (e: IOException) {
            assertTrue(calls > 3)
        }
    }

    @Test
    fun putIsSentAsPut() {
        val (file, _) = file("d.jpg", 10)
        HttpUploader.send(UploadSpec("d.jpg", url, file.absolutePath, method = "PUT"))
        assertEquals("PUT", received.single().first)
    }

    @Test
    fun theLengthIsKnownBeforeTheBodyIsWritten() {
        val (file, _) = file("e \"q\".bin", 70_000)
        val body = MultipartBody(listOf("a" to "1"), "file", file, mimeType = "application/octet-stream")
        val out = ByteArrayOutputStream()
        body.writeTo(out)
        assertEquals(body.contentLength, out.size().toLong())
        assertTrue(String(out.toByteArray(), Charsets.ISO_8859_1).contains("filename=\"e %22q%22.bin\""))
    }

    @Test
    fun knownExtensionsHaveTheirType() {
        assertEquals("application/pdf", MimeTypes.forFileName("a.PDF"))
        assertEquals("video/mp4", MimeTypes.forFileName("a.mp4"))
        assertEquals("application/octet-stream", MimeTypes.forFileName("noext"))
        assertEquals("application/octet-stream", MimeTypes.forFileName("a.zzzunknown"))
    }

    private fun parse(body: ByteArray, contentType: String): List<Pair<String, ByteArray>> {
        val boundary = contentType.substringAfter("boundary=").toByteArray()
        val delimiter = "--".toByteArray() + boundary
        val starts = mutableListOf<Int>()
        var i = 0
        while (i <= body.size - delimiter.size) {
            if (body.copyOfRange(i, i + delimiter.size).contentEquals(delimiter)) {
                starts.add(i)
                i += delimiter.size
            } else {
                i++
            }
        }
        return starts.zipWithNext { start, next ->
            val content = body.copyOfRange(start + delimiter.size + 2, next - 2)
            val split = (0..content.size - 4).first {
                content[it] == '\r'.code.toByte() && content[it + 1] == '\n'.code.toByte() &&
                    content[it + 2] == '\r'.code.toByte() && content[it + 3] == '\n'.code.toByte()
            }
            String(content.copyOfRange(0, split)) to content.copyOfRange(split + 4, content.size)
        }
    }
}
