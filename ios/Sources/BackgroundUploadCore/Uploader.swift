import Foundation

/// The one uploader of the process. It owns the background `URLSession`, the uploads that are queued and the terminal
/// events not yet acknowledged, and reports every event to a single listener, the plugin. There is no init call to
/// make twice: `Uploader.shared` is created on first use, and a second plugin instance simply replaces the listener.
public final class Uploader: NSObject, URLSessionDataDelegate {
    public enum StartError: Error, Equatable {
        case missingOption(String)
        case invalidServerUrl(String)
        case fileNotFound(String)
    }

    public struct Request {
        public var id: String
        public var filePath: String
        public var serverUrl: String
        public var fileKey: String
        public var parameters: [(String, String)]
        public var headers: [String: String]
        public var method: String

        public init(
            id: String,
            filePath: String,
            serverUrl: String,
            fileKey: String = "file",
            parameters: [(String, String)] = [],
            headers: [String: String] = [:],
            method: String = "POST"
        ) {
            self.id = id
            self.filePath = filePath
            self.serverUrl = serverUrl
            self.fileKey = fileKey
            self.parameters = parameters
            self.headers = headers
            self.method = method
        }
    }

    /// `UPLOADING` events are sent at most this often for one upload, and always at 100.
    static let progressInterval: TimeInterval = 1

    public let events: EventStore
    public let uploads: UploadStore
    private let bodies: URL
    private let queue = DispatchQueue(label: "background-upload")
    private let delegateQueue = OperationQueue()
    private var session: URLSession!
    private let retryDelay: (Int) -> TimeInterval
    private var responses: [Int: Data] = [:]
    private var lastProgress: [String: (time: TimeInterval, percent: Int)] = [:]
    private let listenerLock = NSLock()
    private var listenerBlock: (([String: Any]) -> Void)?

    /// Receives every event, on a background queue. Terminal events have been written to disk before it is called.
    public var listener: (([String: Any]) -> Void)? {
        get {
            listenerLock.lock()
            defer { listenerLock.unlock() }
            return listenerBlock
        }
        set {
            listenerLock.lock()
            listenerBlock = newValue
            listenerLock.unlock()
        }
    }

    public static let shared: Uploader = {
        let identifier = (Bundle.main.bundleIdentifier ?? "app") + ".background-upload"
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        // As the Cordova plugin did: the app is not woken to hear about a finished upload; the session delivers the
        // outcome when the app next runs, and the upload itself carries on in the system while the app is not running.
        configuration.sessionSendsLaunchEvents = false
        configuration.isDiscretionary = false
        configuration.httpMaximumConnectionsPerHost = 1
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return Uploader(
            configuration: configuration,
            directory: support.appendingPathComponent("BackgroundUpload", isDirectory: true),
            resumeOrphansAfter: 5
        )
    }()

    /// - Parameters:
    ///   - resumeOrphansAfter: when set, uploads that are on disk but have no task in the session (the system dropped
    ///     it, for example after the user swiped the app away) are queued again this many seconds after start-up. The
    ///     wait lets the session first deliver what finished while the app was not running.
    public init(
        configuration: URLSessionConfiguration,
        directory: URL,
        retryDelay: @escaping (Int) -> TimeInterval = Outcome.retryDelay(afterAttempt:),
        resumeOrphansAfter: TimeInterval? = nil
    ) {
        events = EventStore(directory: directory.appendingPathComponent("events", isDirectory: true))
        uploads = UploadStore(directory: directory.appendingPathComponent("uploads", isDirectory: true))
        bodies = directory.appendingPathComponent("bodies", isDirectory: true)
        self.retryDelay = retryDelay
        super.init()
        try? FileManager.default.createDirectory(at: bodies, withIntermediateDirectories: true)
        delegateQueue.maxConcurrentOperationCount = 1
        delegateQueue.underlyingQueue = queue
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
        if let delay = resumeOrphansAfter {
            queue.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.resumeOrphans()
            }
        }
    }

    // MARK: - API

    /// Checks the request and queues it. Throws, and queues nothing, when it cannot be sent at all.
    public func start(_ request: Request) throws {
        guard !request.id.isEmpty else {
            throw StartError.missingOption("id")
        }
        guard !request.serverUrl.isEmpty else {
            throw StartError.missingOption("serverUrl")
        }
        guard !request.filePath.isEmpty else {
            throw StartError.missingOption("filePath")
        }
        guard let url = URL(string: request.serverUrl), let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme), url.host != nil else {
            throw StartError.invalidServerUrl(request.serverUrl)
        }
        var isDirectory: ObjCBool = false
        guard let path = FilePath.resolve(request.filePath),
              FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            throw StartError.fileNotFound(request.filePath)
        }
        let record = UploadRecord(
            id: request.id,
            serverUrl: request.serverUrl,
            method: request.method.isEmpty ? "POST" : request.method.uppercased(),
            filePath: path,
            fileKey: request.fileKey.isEmpty ? "file" : request.fileKey,
            parameters: request.parameters,
            headers: request.headers
        )
        queue.async {
            // Starting an id that is already queued replaces it: the old task no longer matches the record's token,
            // so its outcome is ignored, and it is cancelled so it stops using the network.
            self.cancelTasks(forId: request.id)
            self.uploads.put(record)
            self.enqueue(record, delay: 0)
        }
    }

    /// Cancels and forgets an upload, and drops its stored events.
    public func remove(id: String, completion: @escaping () -> Void) {
        queue.async {
            self.uploads.remove(id)
            self.events.removeAll(uploadId: id)
            self.lastProgress[id] = nil
            self.cancelTasks(forId: id)
            completion()
        }
    }

    public func acknowledge(eventId: String) {
        events.remove(eventId: eventId)
    }

    /// The terminal events not yet acknowledged, oldest first.
    public func pendingEvents() -> [[String: Any]] {
        events.all()
    }

    /// Queues again every upload on disk that has no task in the session.
    public func resumeOrphans(completion: (() -> Void)? = nil) {
        session.getAllTasks { tasks in
            self.queue.async {
                let live = Set(tasks.compactMap { Self.parse($0.taskDescription)?.token })
                for var record in self.uploads.all() where !live.contains(record.token) {
                    record.token = UUID().uuidString
                    self.uploads.put(record)
                    self.enqueue(record, delay: 0)
                }
                completion?()
            }
        }
    }

    // MARK: - Tasks

    /// A task's description is the record's token (a UUID, always 36 characters) followed by the upload id.
    static func describe(token: String, id: String) -> String {
        token + id
    }

    static func parse(_ description: String?) -> (token: String, id: String)? {
        guard let description, description.count > 36 else {
            return nil
        }
        return (String(description.prefix(36)), String(description.dropFirst(36)))
    }

    private func bodyURL(token: String) -> URL {
        bodies.appendingPathComponent("\(token).body")
    }

    private func cancelTasks(forId id: String) {
        session.getAllTasks { tasks in
            for task in tasks where Self.parse(task.taskDescription)?.id == id {
                task.cancel()
            }
        }
    }

    /// Writes the body for the record's current attempt and hands it to the session. Runs on `queue`.
    private func enqueue(_ record: UploadRecord, delay: TimeInterval) {
        var record = record
        guard let url = URL(string: record.serverUrl) else {
            return finish(record, event: failed(record, error: "Invalid server URL", code: UploadErrorCode.fileUnreadable))
        }
        let boundary = MultipartBody.makeBoundary()
        let body = bodyURL(token: record.token)
        let fileName = FilePath.fileName(of: record.filePath)
        do {
            try MultipartBody.write(
                to: body,
                boundary: boundary,
                parameters: record.parameterPairs,
                fileKey: record.fileKey,
                fileURL: URL(fileURLWithPath: record.filePath),
                fileName: fileName,
                mimeType: MultipartBody.mimeType(forFileName: fileName)
            )
        } catch {
            try? FileManager.default.removeItem(at: body)
            return finish(record, event: failed(
                record,
                error: "Could not read \(record.filePath): \(error.localizedDescription)",
                code: UploadErrorCode.fileUnreadable
            ))
        }

        var request = URLRequest(url: url)
        request.httpMethod = record.method
        for (name, value) in record.headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.setValue(MultipartBody.contentType(boundary: boundary), forHTTPHeaderField: "Content-Type")

        let task = session.uploadTask(with: request, fromFile: body)
        task.taskDescription = Self.describe(token: record.token, id: record.id)
        let begin = Date().addingTimeInterval(delay)
        if delay > 0 {
            task.earliestBeginDate = begin
        }
        record.attemptStartedAt = begin.timeIntervalSince1970 * 1000
        uploads.put(record)
        task.resume()
    }

    private func failed(_ record: UploadRecord, error: String, code: Int) -> [String: Any] {
        ["id": record.id, "state": "FAILED", "error": error, "errorCode": code]
    }

    /// Ends an upload: forgets it, stores its terminal event and reports it. Runs on `queue`.
    private func finish(_ record: UploadRecord, event: [String: Any]) {
        uploads.remove(record.id)
        lastProgress[record.id] = nil
        emit(events.add(event))
    }

    private func emit(_ event: [String: Any]) {
        listener?(event)
    }

    // MARK: - URLSessionDataDelegate

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        guard let (token, id) = Self.parse(task.taskDescription), totalBytesExpectedToSend > 0,
              uploads.get(id)?.token == token else {
            return
        }
        let percent = Int(min(100, totalBytesSent * 100 / totalBytesExpectedToSend))
        let now = Date().timeIntervalSince1970
        if let last = lastProgress[id] {
            if last.percent == percent || (percent < 100 && now - last.time < Self.progressInterval) {
                return
            }
        }
        lastProgress[id] = (now, percent)
        emit(["id": id, "state": "UPLOADING", "progress": percent])
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        responses[dataTask.taskIdentifier, default: Data()].append(data)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let data = responses.removeValue(forKey: task.taskIdentifier)
        guard let (token, id) = Self.parse(task.taskDescription) else {
            return
        }
        try? FileManager.default.removeItem(at: bodyURL(token: token))
        // Removed, replaced, or already finished: nothing to report.
        guard var record = uploads.get(id), record.token == token else {
            return
        }
        let statusCode = error == nil ? (task.response as? HTTPURLResponse)?.statusCode : nil
        let responseText = data.map { String(decoding: $0, as: UTF8.self) } ?? ""
        switch Outcome.decide(statusCode: statusCode, attempt: record.attempt) {
        case .uploaded(let status):
            let finished = Date().timeIntervalSince1970 * 1000
            var event: [String: Any] = [
                "id": id,
                "state": "UPLOADED",
                "statusCode": status,
                "serverResponse": responseText,
                "finishUploadTime": finished
            ]
            if let started = record.attemptStartedAt {
                event["uploadDuration"] = max(0, finished - started)
            }
            finish(record, event: event)
        case .rejected(let status):
            var event = failed(record, error: "The server answered \(status)", code: UploadErrorCode.httpStatus)
            event["statusCode"] = status
            event["serverResponse"] = responseText
            finish(record, event: event)
        case .retry:
            let delay = retryDelay(record.attempt)
            record.attempt += 1
            record.token = UUID().uuidString
            uploads.put(record)
            enqueue(record, delay: delay)
        case .gaveUp:
            let reason = error?.localizedDescription ?? "No response from the server"
            finish(record, event: failed(
                record,
                error: "Gave up after \(record.attempt) attempts: \(reason)",
                code: UploadErrorCode.attemptsExhausted
            ))
        }
    }
}
