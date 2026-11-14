import XCTest
@testable import BackgroundUploadCore

final class FilePathTests: XCTestCase {
    func testAnAbsolutePathIsKept() {
        XCTAssertEqual(FilePath.resolve("/var/mobile/a b.jpg"), "/var/mobile/a b.jpg")
    }

    func testAFileUrlBecomesItsDecodedPath() {
        XCTAssertEqual(FilePath.resolve("file:///var/mobile/Library/files/a%20b.jpg"), "/var/mobile/Library/files/a b.jpg")
    }

    func testAConvertFileSrcUrlBecomesThePathItWraps() {
        XCTAssertEqual(FilePath.resolve("capacitor://localhost/_capacitor_file_/var/mobile/x.pdf"), "/var/mobile/x.pdf")
        XCTAssertEqual(FilePath.resolve("https://localhost/_capacitor_file_/data/user/0/x.pdf"), "/data/user/0/x.pdf")
    }

    func testAnythingElseIsRefused() {
        XCTAssertNil(FilePath.resolve("photo.jpg"))
        XCTAssertNil(FilePath.resolve("https://example.com/photo.jpg"))
        XCTAssertNil(FilePath.resolve("content://media/external/images/1"))
        XCTAssertNil(FilePath.resolve(""))
    }

    func testTheMultipartFileNameIsTheBareName() {
        XCTAssertEqual(FilePath.fileName(of: "/var/mobile/Library/files/task/1/photo.jpg"), "photo.jpg")
    }
}

final class OutcomeTests: XCTestCase {
    func testA2xxResponseIsUploaded() {
        XCTAssertEqual(Outcome.decide(statusCode: 204, attempt: 1), .uploaded(statusCode: 204))
    }

    func testAnyOtherResponseEndsTheUploadAsFailed() {
        XCTAssertEqual(Outcome.decide(statusCode: 403, attempt: 1), .rejected(statusCode: 403))
        XCTAssertEqual(Outcome.decide(statusCode: 500, attempt: 9), .rejected(statusCode: 500))
    }

    func testNoResponseIsRetriedUntilTheLastAttempt() {
        XCTAssertEqual(Outcome.decide(statusCode: nil, attempt: 1), .retry(after: 30))
        XCTAssertEqual(Outcome.decide(statusCode: nil, attempt: 9), .retry(after: Outcome.retryDelay(afterAttempt: 9)))
        XCTAssertEqual(Outcome.decide(statusCode: nil, attempt: 10), .gaveUp)
    }

    func testTheDelayDoublesUpToAnHour() {
        XCTAssertEqual(Outcome.retryDelay(afterAttempt: 1), 30)
        XCTAssertEqual(Outcome.retryDelay(afterAttempt: 2), 60)
        XCTAssertEqual(Outcome.retryDelay(afterAttempt: 7), 1920)
        XCTAssertEqual(Outcome.retryDelay(afterAttempt: 8), 3600)
        XCTAssertEqual(Outcome.retryDelay(afterAttempt: 50), 3600)
    }
}

final class MultipartBodyTests: XCTestCase {
    func testParametersComeFirstAndTheFileIsCopiedByteForByte() throws {
        let dir = try temporaryDirectory()
        let file = dir.appendingPathComponent("scan \"1\".pdf")
        let bytes = Data((0..<700_000).map { UInt8(truncatingIfNeeded: $0 &* 31) })
        try bytes.write(to: file)
        let body = dir.appendingPathComponent("out.body")
        let boundary = MultipartBody.makeBoundary()

        let written = try MultipartBody.write(
            to: body,
            boundary: boundary,
            parameters: [("key", "uploads/a.pdf"), ("policy", "abc")],
            fileKey: "file",
            fileURL: file,
            fileName: FilePath.fileName(of: file.path),
            mimeType: MultipartBody.mimeType(forFileName: file.lastPathComponent)
        )

        let data = try Data(contentsOf: body)
        XCTAssertEqual(Int64(data.count), written)
        let parts = try XCTUnwrap(MultipartParts(body: data, contentType: MultipartBody.contentType(boundary: boundary)))
        XCTAssertEqual(parts.parts.count, 3)
        XCTAssertTrue(parts.parts[0].headers.contains("name=\"key\""))
        XCTAssertEqual(String(decoding: parts.parts[0].body, as: UTF8.self), "uploads/a.pdf")
        XCTAssertTrue(parts.parts[1].headers.contains("name=\"policy\""))
        XCTAssertTrue(parts.parts[2].headers.contains("name=\"file\"; filename=\"scan %221%22.pdf\""))
        XCTAssertTrue(parts.parts[2].headers.contains("Content-Type: application/pdf"))
        XCTAssertEqual(parts.parts[2].body, bytes)
        XCTAssertTrue(data.suffix(boundary.count + 6) == Data("--\(boundary)--\r\n".utf8))
    }

    func testAnUnknownExtensionIsOctetStream() {
        XCTAssertEqual(MultipartBody.mimeType(forFileName: "a.zzzunknown"), "application/octet-stream")
        XCTAssertEqual(MultipartBody.mimeType(forFileName: "noext"), "application/octet-stream")
        XCTAssertEqual(MultipartBody.mimeType(forFileName: "a.jpg"), "image/jpeg")
    }

    func testAMissingFileThrows() throws {
        let dir = try temporaryDirectory()
        XCTAssertThrowsError(try MultipartBody.write(
            to: dir.appendingPathComponent("b"),
            boundary: "x",
            parameters: [],
            fileKey: "file",
            fileURL: dir.appendingPathComponent("missing.jpg"),
            fileName: "missing.jpg",
            mimeType: "image/jpeg"
        ))
    }
}

final class StoreTests: XCTestCase {
    func testEventsSurviveANewStoreUntilAcknowledged() throws {
        let dir = try temporaryDirectory()
        let first = EventStore(directory: dir)
        let a = first.add(["id": "a", "state": "UPLOADED"], now: Date(timeIntervalSince1970: 1))
        let b = first.add(["id": "b/../x", "state": "FAILED"], now: Date(timeIntervalSince1970: 2))
        XCTAssertNotNil(a["eventId"] as? String)

        let second = EventStore(directory: dir)
        XCTAssertEqual(second.all().compactMap { $0["id"] as? String }, ["a", "b/../x"])

        second.remove(eventId: try XCTUnwrap(a["eventId"] as? String))
        XCTAssertEqual(EventStore(directory: dir).all().compactMap { $0["id"] as? String }, ["b/../x"])
        second.removeAll(uploadId: "b/../x")
        XCTAssertTrue(EventStore(directory: dir).all().isEmpty)
        XCTAssertNotNil(b["eventId"])
    }

    func testUploadRecordsRoundTrip() throws {
        let dir = try temporaryDirectory()
        var record = UploadRecord(
            id: "a.jpg",
            serverUrl: "https://example.com",
            method: "POST",
            filePath: "/tmp/a.jpg",
            fileKey: "file",
            parameters: [("key", "k"), ("acl", "private")],
            headers: ["X-A": "1"]
        )
        record.attempt = 3
        UploadStore(directory: dir).put(record)
        let read = try XCTUnwrap(UploadStore(directory: dir).get("a.jpg"))
        XCTAssertEqual(read, record)
        XCTAssertEqual(read.parameterPairs.map { $0.0 }, ["key", "acl"])
        UploadStore(directory: dir).remove("a.jpg")
        XCTAssertNil(UploadStore(directory: dir).get("a.jpg"))
    }
}

func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("bgu-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
