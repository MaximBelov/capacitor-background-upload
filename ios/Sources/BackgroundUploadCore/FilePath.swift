import Foundation

/// Turns what JavaScript passes as `filePath` into a path on disk.
public enum FilePath {
    /// The prefix `Capacitor.convertFileSrc()` puts in front of a path.
    static let capacitorFilePrefix = "/_capacitor_file_"

    /// An absolute path for an absolute path, a `file://` URL or a `convertFileSrc()` URL; nil for anything else.
    public static func resolve(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("/") {
            return trimmed
        }
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else {
            return nil
        }
        if scheme == "file" {
            let path = url.path
            return path.isEmpty ? nil : path
        }
        if ["capacitor", "http", "https", "ionic"].contains(scheme) {
            let path = url.path
            guard path.hasPrefix(capacitorFilePrefix) else {
                return nil
            }
            let rest = String(path.dropFirst(capacitorFilePrefix.count))
            return rest.hasPrefix("/") ? rest : nil
        }
        return nil
    }

    /// The bare file name, which is what the multipart part carries on both platforms.
    public static func fileName(of path: String) -> String {
        (path as NSString).lastPathComponent
    }
}
