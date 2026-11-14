import Foundation
import Network

/// A one-file HTTP server on 127.0.0.1 for the tests. Each request is read whole (headers and `Content-Length` bytes)
/// and kept; what it answers is up to `respond`, which can also answer nil to close the connection without a response.
final class TestServer {
    struct Received {
        let method: String
        let headers: [String: String]
        let body: Data
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "test-server")
    private let lock = NSLock()
    private var receivedRequests: [Received] = []
    var respond: (Received, Int) -> (status: Int, body: String)? = { _, _ in (200, "ok") }
    /// Seconds to wait before answering, so that a test can act while a request is in flight.
    var delay: TimeInterval = 0

    private(set) var port: UInt16 = 0

    var url: String { "http://127.0.0.1:\(port)/upload" }

    var received: [Received] {
        lock.lock()
        defer { lock.unlock() }
        return receivedRequests
    }

    init() throws {
        listener = try NWListener(using: .tcp, on: .any)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state {
                ready.signal()
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 5)
        port = listener.port?.rawValue ?? 0
    }

    func stop() {
        listener.cancel()
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        read(connection, buffer: Data())
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            guard let self else {
                return
            }
            var buffer = buffer
            if let data {
                buffer.append(data)
            }
            if let request = Self.parse(buffer) {
                self.answer(connection, request)
            } else if isComplete || error != nil {
                connection.cancel()
            } else {
                self.read(connection, buffer: buffer)
            }
        }
    }

    private func answer(_ connection: NWConnection, _ request: Received) {
        lock.lock()
        receivedRequests.append(request)
        let index = receivedRequests.count - 1
        lock.unlock()
        queue.asyncAfter(deadline: .now() + delay) {
            guard let reply = self.respond(request, index) else {
                connection.cancel()
                return
            }
            let body = Data(reply.body.utf8)
            let head = "HTTP/1.1 \(reply.status) X\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
            connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }

    /// A whole request, or nil while more bytes are needed.
    static func parse(_ data: Data) -> Received? {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else {
            return nil
        }
        let head = String(decoding: data[data.startIndex..<end.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let method = lines.removeFirst().components(separatedBy: " ").first ?? ""
        var headers: [String: String] = [:]
        for line in lines {
            if let colon = line.firstIndex(of: ":") {
                let name = line[line.startIndex..<colon].lowercased()
                headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let body = data[end.upperBound...]
        guard body.count >= length else {
            return nil
        }
        return Received(method: method, headers: headers, body: Data(body.prefix(length)))
    }
}

/// A multipart body split into its parts, for checking what was sent.
struct MultipartParts {
    struct Part {
        let headers: String
        let body: Data
    }

    let parts: [Part]

    init?(body: Data, contentType: String) {
        guard let range = contentType.range(of: "boundary=") else {
            return nil
        }
        let boundary = String(contentType[range.upperBound...])
        let delimiter = Data("--\(boundary)".utf8)
        var parts: [Part] = []
        var cursor = body.startIndex
        var starts: [Data.Index] = []
        while let found = body.range(of: delimiter, in: cursor..<body.endIndex) {
            starts.append(found.lowerBound)
            cursor = found.upperBound
        }
        for (index, start) in starts.dropLast().enumerated() {
            let contentStart = start + delimiter.count + 2 // CRLF after the delimiter
            let contentEnd = starts[index + 1] - 2 // CRLF before the next delimiter
            let content = body[contentStart..<contentEnd]
            guard let split = content.range(of: Data("\r\n\r\n".utf8)) else {
                return nil
            }
            parts.append(Part(
                headers: String(decoding: content[content.startIndex..<split.lowerBound], as: UTF8.self),
                body: Data(content[split.upperBound...])
            ))
        }
        self.parts = parts
    }
}
