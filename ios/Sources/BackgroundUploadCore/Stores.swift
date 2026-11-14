import Foundation

/// One JSON file per entry in a directory, written atomically. Small, and readable after the app has been killed at any
/// point: an entry is either the old file or the new one, never half of each.
final class JSONDirectory {
    let url: URL

    init(url: URL) {
        self.url = url
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    /// A file name for any key: the key's UTF-8 bytes in hex, so a `/` or `..` in an id cannot leave the directory.
    static func fileName(for key: String) -> String {
        Data(key.utf8).map { String(format: "%02x", $0) }.joined() + ".json"
    }

    func fileURL(for key: String) -> URL {
        url.appendingPathComponent(Self.fileName(for: key))
    }

    func write(_ object: [String: Any], key: String) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        try data.write(to: fileURL(for: key), options: .atomic)
    }

    func read(key: String) -> [String: Any]? {
        guard let data = try? Data(contentsOf: fileURL(for: key)) else {
            return nil
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    func remove(key: String) {
        try? FileManager.default.removeItem(at: fileURL(for: key))
    }

    func all() -> [[String: Any]] {
        let files = (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }.compactMap { file in
            guard let data = try? Data(contentsOf: file) else {
                return nil
            }
            return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
    }
}

/// Terminal events kept until JavaScript acknowledges them.
public final class EventStore {
    private let directory: JSONDirectory
    private let lock = NSLock()

    public init(directory: URL) {
        self.directory = JSONDirectory(url: directory)
    }

    /// Stores the event under a new `eventId` and returns it with that id set.
    public func add(_ event: [String: Any], now: Date = Date()) -> [String: Any] {
        var stored = event
        let eventId = UUID().uuidString
        stored["eventId"] = eventId
        lock.lock()
        defer { lock.unlock() }
        try? directory.write(["t": now.timeIntervalSince1970 * 1000, "event": stored], key: eventId)
        return stored
    }

    public func remove(eventId: String) {
        lock.lock()
        defer { lock.unlock() }
        directory.remove(key: eventId)
    }

    /// Drops every stored event of one upload.
    public func removeAll(uploadId: String) {
        lock.lock()
        defer { lock.unlock() }
        for entry in directory.all() {
            if let event = entry["event"] as? [String: Any], event["id"] as? String == uploadId,
               let eventId = event["eventId"] as? String {
                directory.remove(key: eventId)
            }
        }
    }

    /// Every stored event, oldest first.
    public func all() -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return directory.all()
            .sorted { ($0["t"] as? Double ?? 0) < ($1["t"] as? Double ?? 0) }
            .compactMap { $0["event"] as? [String: Any] }
    }
}

/// What an upload needs to be sent again after the app has been killed: everything `startUpload` was given, which
/// attempt is running, and the token of the task that is running it.
public struct UploadRecord: Codable, Equatable {
    public var id: String
    public var serverUrl: String
    public var method: String
    public var filePath: String
    public var fileKey: String
    public var parameters: [[String]]
    public var headers: [String: String]
    public var attempt: Int
    public var token: String
    public var attemptStartedAt: Double?

    public init(
        id: String,
        serverUrl: String,
        method: String,
        filePath: String,
        fileKey: String,
        parameters: [(String, String)],
        headers: [String: String]
    ) {
        self.id = id
        self.serverUrl = serverUrl
        self.method = method
        self.filePath = filePath
        self.fileKey = fileKey
        self.parameters = parameters.map { [$0.0, $0.1] }
        self.headers = headers
        self.attempt = 1
        self.token = UUID().uuidString
        self.attemptStartedAt = nil
    }

    public var parameterPairs: [(String, String)] {
        parameters.compactMap { $0.count == 2 ? ($0[0], $0[1]) : nil }
    }
}

public final class UploadStore {
    private let directory: JSONDirectory
    private let lock = NSLock()

    public init(directory: URL) {
        self.directory = JSONDirectory(url: directory)
    }

    public func put(_ record: UploadRecord) {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? JSONEncoder().encode(record),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return
        }
        try? directory.write(object, key: record.id)
    }

    public func get(_ id: String) -> UploadRecord? {
        lock.lock()
        defer { lock.unlock() }
        return directory.read(key: id).flatMap(Self.decode)
    }

    public func remove(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        directory.remove(key: id)
    }

    public func all() -> [UploadRecord] {
        lock.lock()
        defer { lock.unlock() }
        return directory.all().compactMap(Self.decode)
    }

    private static func decode(_ object: [String: Any]) -> UploadRecord? {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else {
            return nil
        }
        return try? JSONDecoder().decode(UploadRecord.self, from: data)
    }
}
