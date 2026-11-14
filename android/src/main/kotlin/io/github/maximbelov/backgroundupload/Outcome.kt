package io.github.maximbelov.backgroundupload

import kotlin.math.min
import kotlin.math.pow

/** What to do when an attempt ends: any response ends the upload, no response is retried until the attempts run out. */
sealed class Outcome {
    data class Uploaded(val statusCode: Int) : Outcome()

    data class Rejected(val statusCode: Int) : Outcome()

    object Retry : Outcome()

    object GaveUp : Outcome()

    companion object {
        const val MAX_ATTEMPTS = 10

        fun decide(statusCode: Int?, attempt: Int, maxAttempts: Int = MAX_ATTEMPTS): Outcome = when {
            statusCode != null && statusCode in 200..299 -> Uploaded(statusCode)
            statusCode != null -> Rejected(statusCode)
            attempt >= maxAttempts -> GaveUp
            else -> Retry
        }

        /** 30 s after the first attempt, doubling each time, at most an hour (what WorkManager's backoff does). */
        fun retryDelaySeconds(afterAttempt: Int): Long {
            val exponent = (afterAttempt - 1).coerceIn(0, 7)
            return min(30.0 * 2.0.pow(exponent), 3600.0).toLong()
        }
    }
}

/** The error codes a `FAILED` event carries, the same on both platforms. */
object UploadErrorCode {
    const val HTTP_STATUS = 0
    const val ATTEMPTS_EXHAUSTED = -2
    const val FILE_UNREADABLE = -3
}
