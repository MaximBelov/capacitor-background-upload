import Foundation
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

/// Writes a `multipart/form-data` body to a file, which is what a background `URLSession` uploads from. The file to
/// send is copied in chunks, so a large video is never held in memory.
public enum MultipartBody {
    static let chunkSize = 256 * 1024

    public static func makeBoundary() -> String {
        "BackgroundUpload-\(UUID().uuidString)"
    }

    public static func contentType(boundary: String) -> String {
        "multipart/form-data; boundary=\(boundary)"
    }

    /// The MIME type for a file name's extension, `application/octet-stream` when there is none or it is unknown.
    public static func mimeType(forFileName name: String) -> String {
        let ext = (name as NSString).pathExtension
        #if canImport(UniformTypeIdentifiers)
        if !ext.isEmpty, let type = UTType(filenameExtension: ext), let mime = type.preferredMIMEType {
            return mime
        }
        #endif
        return "application/octet-stream"
    }

    /// A field name or file name made safe for a quoted `Content-Disposition` value, the way browsers do it.
    static func escape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\"", with: "%22")
            .replacingOccurrences(of: "\r", with: "%0D")
            .replacingOccurrences(of: "\n", with: "%0A")
    }

    /// Writes the parameters, in the order given, and then the file. Returns the number of bytes written.
    @discardableResult
    public static func write(
        to destination: URL,
        boundary: String,
        parameters: [(String, String)],
        fileKey: String,
        fileURL: URL,
        fileName: String,
        mimeType: String
    ) throws -> Int64 {
        let manager = FileManager.default
        try manager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        if manager.fileExists(atPath: destination.path) {
            try manager.removeItem(at: destination)
        }
        guard manager.createFile(atPath: destination.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: destination.path])
        }
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        let input = try FileHandle(forReadingFrom: fileURL)
        defer { try? input.close() }

        var written: Int64 = 0
        func put(_ text: String) throws {
            let data = Data(text.utf8)
            try output.write(contentsOf: data)
            written += Int64(data.count)
        }

        for (name, value) in parameters {
            try put("--\(boundary)\r\n")
            try put("Content-Disposition: form-data; name=\"\(escape(name))\"\r\n\r\n")
            try put("\(value)\r\n")
        }
        try put("--\(boundary)\r\n")
        try put("Content-Disposition: form-data; name=\"\(escape(fileKey))\"; filename=\"\(escape(fileName))\"\r\n")
        try put("Content-Type: \(mimeType)\r\n\r\n")
        while true {
            guard let chunk = try input.read(upToCount: chunkSize), !chunk.isEmpty else {
                break
            }
            try output.write(contentsOf: chunk)
            written += Int64(chunk.count)
        }
        try put("\r\n--\(boundary)--\r\n")
        return written
    }
}
