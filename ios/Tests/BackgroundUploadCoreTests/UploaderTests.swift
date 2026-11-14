import XCTest
@testable import BackgroundUploadCore

/// The uploader against a real HTTP server on 127.0.0.1. The session is an ordinary one here, because a background
/// session needs an app; everything else — the body file, the events, the retries, the stores — is what runs on a phone.
final class UploaderTests: XCTestCase {
    private var server: TestServer!
    private var directory: URL!
    private var events: [[String: Any]] = []
    private let lock = NSLock()

    override func setUpWithError() throws {
        server = try TestServer()
        directory = try temporaryDirectory()
        events = []
    }

    override func tearDown() {
        server.stop()
    }

    private func makeUploader() -> Uploader {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        let uploader = Uploader(configuration: configuration, directory: directory, retryDelay: { _ in 0 })
        uploader.listener = { [weak self] event in
            guard let self else {
                return
            }
            self.lock.lock()
            self.events.append(event)
            self.lock.unlock()
        }
        return uploader
    }

    private func recorded() -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return events
    }

    private func waitForTerminal(_ id: String, timeout: TimeInterval = 20) -> [String: Any]? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let event = recorded().first(where: { $0["id"] as? String == id && $0["state"] as? String != "UPLOADING" }) {
                return event
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return nil
    }

    private func makeFile(_ name: String, size: Int) throws -> (URL, Data) {
        let file = directory.appendingPathComponent(name)
        var generator = SystemRandomNumberGenerator()
        let bytes = Data((0..<size).map { _ in UInt8.random(in: 0...255, using: &generator) })
        try bytes.write(to: file)
        return (file, bytes)
    }

    func testAFileArrivesWholeWithItsFieldsAndTheResponseComesBack() throws {
        let (file, bytes) = try makeFile("photo.jpg", size: 3_000_000)
        server.respond = { _, _ in (201, "<PostResponse><Key>uploads/photo.jpg</Key></PostResponse>") }
        let uploader = makeUploader()

        try uploader.start(.init(
            id: "photo.jpg",
            filePath: file.absoluteString,
            serverUrl: server.url,
            parameters: [("key", "uploads/photo.jpg"), ("policy", "p")],
            headers: ["X-Test": "1"]
        ))

        let event = try XCTUnwrap(waitForTerminal("photo.jpg"))
        XCTAssertEqual(event["state"] as? String, "UPLOADED")
        XCTAssertEqual(event["statusCode"] as? Int, 201)
        XCTAssertEqual(event["serverResponse"] as? String, "<PostResponse><Key>uploads/photo.jpg</Key></PostResponse>")
        XCTAssertNotNil(event["uploadDuration"])
        let eventId = try XCTUnwrap(event["eventId"] as? String)

        let request = try XCTUnwrap(server.received.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.headers["x-test"], "1")
        let parts = try XCTUnwrap(MultipartParts(body: request.body, contentType: request.headers["content-type"] ?? ""))
        XCTAssertEqual(parts.parts.count, 3)
        XCTAssertTrue(parts.parts[2].headers.contains("filename=\"photo.jpg\""))
        XCTAssertEqual(parts.parts[2].body, bytes)

        let progress = recorded().filter { $0["state"] as? String == "UPLOADING" }.compactMap { $0["progress"] as? Int }
        XCTAssertFalse(progress.isEmpty)
        XCTAssertEqual(progress, progress.sorted())

        // Kept until acknowledged, also for an uploader made later (the next launch).
        XCTAssertEqual(makeUploader().pendingEvents().compactMap { $0["eventId"] as? String }, [eventId])
        uploader.acknowledge(eventId: eventId)
        XCTAssertTrue(makeUploader().pendingEvents().isEmpty)
        XCTAssertNil(uploader.uploads.get("photo.jpg"))
    }

    func testAResponseOutside2xxIsAFailureWithItsStatus() throws {
        let (file, _) = try makeFile("a.pdf", size: 10_000)
        server.respond = { _, _ in (403, "<Error><Code>AccessDenied</Code></Error>") }
        let uploader = makeUploader()

        try uploader.start(.init(id: "a.pdf", filePath: file.path, serverUrl: server.url))

        let event = try XCTUnwrap(waitForTerminal("a.pdf"))
        XCTAssertEqual(event["state"] as? String, "FAILED")
        XCTAssertEqual(event["statusCode"] as? Int, 403)
        XCTAssertEqual(event["errorCode"] as? Int, UploadErrorCode.httpStatus)
        XCTAssertEqual(event["serverResponse"] as? String, "<Error><Code>AccessDenied</Code></Error>")
        XCTAssertEqual(server.received.count, 1)
    }

    func testARequestThatGetsNoResponseIsSentAgain() throws {
        let (file, bytes) = try makeFile("b.jpg", size: 50_000)
        server.respond = { _, index in index == 0 ? nil : (200, "ok") }
        let uploader = makeUploader()

        try uploader.start(.init(id: "b.jpg", filePath: file.path, serverUrl: server.url))

        let event = try XCTUnwrap(waitForTerminal("b.jpg"))
        XCTAssertEqual(event["state"] as? String, "UPLOADED")
        XCTAssertGreaterThanOrEqual(server.received.count, 2)
        let last = try XCTUnwrap(server.received.last)
        let parts = try XCTUnwrap(MultipartParts(body: last.body, contentType: last.headers["content-type"] ?? ""))
        XCTAssertEqual(parts.parts.last?.body, bytes)
    }

    func testItGivesUpAfterTheLastAttempt() throws {
        let (file, _) = try makeFile("c.jpg", size: 1_000)
        server.respond = { _, _ in nil }
        let uploader = makeUploader()

        try uploader.start(.init(id: "c.jpg", filePath: file.path, serverUrl: server.url))

        let event = try XCTUnwrap(waitForTerminal("c.jpg", timeout: 60))
        XCTAssertEqual(event["state"] as? String, "FAILED")
        XCTAssertEqual(event["errorCode"] as? Int, UploadErrorCode.attemptsExhausted)
        XCTAssertEqual(server.received.count, Outcome.maxAttempts)
    }

    func testWhatCannotBeSentIsRefusedUpFront() throws {
        let (file, _) = try makeFile("d.jpg", size: 10)
        let uploader = makeUploader()
        XCTAssertThrowsError(try uploader.start(.init(id: "", filePath: file.path, serverUrl: server.url))) {
            XCTAssertEqual($0 as? Uploader.StartError, .missingOption("id"))
        }
        XCTAssertThrowsError(try uploader.start(.init(id: "d", filePath: file.path, serverUrl: "ftp://x/y"))) {
            XCTAssertEqual($0 as? Uploader.StartError, .invalidServerUrl("ftp://x/y"))
        }
        XCTAssertThrowsError(try uploader.start(.init(id: "d", filePath: file.path + ".missing", serverUrl: server.url))) {
            XCTAssertEqual($0 as? Uploader.StartError, .fileNotFound(file.path + ".missing"))
        }
        XCTAssertTrue(uploader.uploads.all().isEmpty)
    }

    func testARemovedUploadReportsNothing() throws {
        let (file, _) = try makeFile("e.jpg", size: 10_000)
        server.delay = 2
        let uploader = makeUploader()
        try uploader.start(.init(id: "e.jpg", filePath: file.path, serverUrl: server.url))

        let deadline = Date().addingTimeInterval(10)
        while server.received.isEmpty && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        let removed = expectation(description: "removed")
        uploader.remove(id: "e.jpg") { removed.fulfill() }
        wait(for: [removed], timeout: 5)

        XCTAssertNil(waitForTerminal("e.jpg", timeout: 4))
        XCTAssertNil(uploader.uploads.get("e.jpg"))
        XCTAssertTrue(uploader.pendingEvents().isEmpty)
    }

    func testAnUploadLeftOnDiskWithoutATaskIsSentAgain() throws {
        let (file, bytes) = try makeFile("f.jpg", size: 20_000)
        // What a killed app leaves behind when the system has dropped the task: the record and nothing else.
        UploadStore(directory: directory.appendingPathComponent("uploads")).put(UploadRecord(
            id: "f.jpg",
            serverUrl: server.url,
            method: "POST",
            filePath: file.path,
            fileKey: "file",
            parameters: [],
            headers: [:]
        ))
        let uploader = makeUploader()
        let resumed = expectation(description: "resumed")
        uploader.resumeOrphans { resumed.fulfill() }
        wait(for: [resumed], timeout: 5)

        let event = try XCTUnwrap(waitForTerminal("f.jpg"))
        XCTAssertEqual(event["state"] as? String, "UPLOADED")
        let request = try XCTUnwrap(server.received.first)
        let parts = try XCTUnwrap(MultipartParts(body: request.body, contentType: request.headers["content-type"] ?? ""))
        XCTAssertEqual(parts.parts.last?.body, bytes)
    }

    func testStartingTheSameIdAgainReplacesTheFirst() throws {
        let (first, _) = try makeFile("g1.jpg", size: 10_000)
        let (second, secondBytes) = try makeFile("g2.jpg", size: 10_000)
        server.delay = 1
        let uploader = makeUploader()
        try uploader.start(.init(id: "g", filePath: first.path, serverUrl: server.url))
        try uploader.start(.init(id: "g", filePath: second.path, serverUrl: server.url))

        let event = try XCTUnwrap(waitForTerminal("g"))
        XCTAssertEqual(event["state"] as? String, "UPLOADED")
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        XCTAssertEqual(recorded().filter { $0["state"] as? String != "UPLOADING" }.count, 1)
        let request = try XCTUnwrap(server.received.last)
        let parts = try XCTUnwrap(MultipartParts(body: request.body, contentType: request.headers["content-type"] ?? ""))
        XCTAssertEqual(parts.parts.last?.body, secondBytes)
    }
}
