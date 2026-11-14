import Foundation

/// What to do when an attempt ends. The same rules as on Android: any response ends the upload, a request that got no
/// response is tried again until the attempts run out.
public enum Outcome: Equatable {
    /// A 2xx response: `UPLOADED`.
    case uploaded(statusCode: Int)
    /// Any other response: `FAILED` with `errorCode` 0 and the status.
    case rejected(statusCode: Int)
    /// No response: send it again after the delay.
    case retry(after: TimeInterval)
    /// No response on the last attempt: `FAILED` with `errorCode` -2.
    case gaveUp

    public static let maxAttempts = 10

    public static func decide(statusCode: Int?, attempt: Int, maxAttempts: Int = maxAttempts) -> Outcome {
        if let statusCode {
            return (200...299).contains(statusCode) ? .uploaded(statusCode: statusCode) : .rejected(statusCode: statusCode)
        }
        return attempt >= maxAttempts ? .gaveUp : .retry(after: retryDelay(afterAttempt: attempt))
    }

    /// 30 s after the first attempt, doubling each time, at most an hour.
    public static func retryDelay(afterAttempt attempt: Int) -> TimeInterval {
        let exponent = max(0, min(attempt - 1, 7))
        return min(30 * pow(2, Double(exponent)), 3600)
    }
}

/// The error codes a `FAILED` event carries, the same on both platforms.
public enum UploadErrorCode {
    public static let httpStatus = 0
    public static let attemptsExhausted = -2
    public static let fileUnreadable = -3
}
