package io.github.maximbelov.backgroundupload

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class FilePathTest {
    @Test
    fun anAbsolutePathIsKept() = assertEquals("/data/user/0/a b.jpg", FilePath.resolve("/data/user/0/a b.jpg"))

    @Test
    fun aFileUrlBecomesItsDecodedPath() =
        assertEquals("/data/user/0/app/files/a b+c.jpg", FilePath.resolve("file:///data/user/0/app/files/a%20b+c.jpg"))

    @Test
    fun aConvertFileSrcUrlBecomesThePathItWraps() {
        assertEquals("/data/user/0/x.pdf", FilePath.resolve("https://localhost/_capacitor_file_/data/user/0/x.pdf"))
        assertEquals("/var/mobile/x.pdf", FilePath.resolve("capacitor://localhost/_capacitor_file_/var/mobile/x.pdf"))
    }

    @Test
    fun anythingElseIsRefused() {
        assertNull(FilePath.resolve("photo.jpg"))
        assertNull(FilePath.resolve("https://example.com/photo.jpg"))
        assertNull(FilePath.resolve("content://media/external/images/1"))
        assertNull(FilePath.resolve(""))
    }

    @Test
    fun theMultipartFileNameIsTheBareName() = assertEquals("photo.jpg", FilePath.fileName("/data/user/0/files/task/1/photo.jpg"))
}

class OutcomeTest {
    @Test
    fun a2xxResponseIsUploaded() = assertEquals(Outcome.Uploaded(204), Outcome.decide(204, 1))

    @Test
    fun anyOtherResponseEndsTheUploadAsFailed() {
        assertEquals(Outcome.Rejected(403), Outcome.decide(403, 1))
        assertEquals(Outcome.Rejected(500), Outcome.decide(500, 9))
    }

    @Test
    fun noResponseIsRetriedUntilTheLastAttempt() {
        assertEquals(Outcome.Retry, Outcome.decide(null, 1))
        assertEquals(Outcome.Retry, Outcome.decide(null, 9))
        assertEquals(Outcome.GaveUp, Outcome.decide(null, 10))
    }

    @Test
    fun theDelayMatchesIos() {
        assertEquals(30L, Outcome.retryDelaySeconds(1))
        assertEquals(60L, Outcome.retryDelaySeconds(2))
        assertEquals(3600L, Outcome.retryDelaySeconds(8))
    }
}

class EventStoreTest {
    @get:Rule
    val folder = TemporaryFolder()

    @Test
    fun eventsSurviveANewStoreUntilAcknowledged() {
        val dir = folder.newFolder("events")
        val first = EventStore(dir)
        val a = first.add(JSONObject().put("id", "a").put("state", "UPLOADED"), now = 1)
        first.add(JSONObject().put("id", "b/../x").put("state", "FAILED"), now = 2)
        assertTrue(a.getString("eventId").isNotEmpty())

        assertEquals(listOf("a", "b/../x"), EventStore(dir).all().map { it.getString("id") })
        first.remove(a.getString("eventId"))
        assertEquals(listOf("b/../x"), EventStore(dir).all().map { it.getString("id") })
        first.removeAll("b/../x")
        assertTrue(EventStore(dir).all().isEmpty())
        assertTrue(dir.listFiles()!!.isEmpty())
    }
}
