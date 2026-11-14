import Foundation
import Capacitor
#if SWIFT_PACKAGE
// With CocoaPods both folders are one module, so there is nothing to import.
import BackgroundUploadCore
#endif

@objc(BackgroundUploadPlugin)
public class BackgroundUploadPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BackgroundUploadPlugin"
    public let jsName = "BackgroundUpload"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startUpload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeUpload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledgeEvent", returnType: CAPPluginReturnPromise)
    ]

    static let eventName = "event"

    private var uploader: Uploader { Uploader.shared }

    override public func load() {
        // The uploader has one listener: this plugin. A plugin made later (a new bridge) takes it over.
        uploader.listener = { [weak self] event in
            self?.deliver(event)
        }
        // Terminal events left from earlier runs are held until the first listener is added.
        for event in uploader.pendingEvents() {
            notifyListeners(Self.eventName, data: event, retainUntilConsumed: true)
        }
    }

    private func deliver(_ event: [String: Any]) {
        let terminal = (event["state"] as? String) != "UPLOADING"
        notifyListeners(Self.eventName, data: event, retainUntilConsumed: terminal)
    }

    @objc func startUpload(_ call: CAPPluginCall) {
        let parameters = (call.getObject("parameters") ?? [:])
            .compactMap { key, value in Self.string(value).map { (key, $0) } }
            .sorted { $0.0 < $1.0 }
        let headers = (call.getObject("headers") ?? [:])
            .reduce(into: [String: String]()) { result, entry in
                if let value = Self.string(entry.value) {
                    result[entry.key] = value
                }
            }
        let request = Uploader.Request(
            id: call.getString("id") ?? "",
            filePath: call.getString("filePath") ?? "",
            serverUrl: call.getString("serverUrl") ?? "",
            fileKey: call.getString("fileKey") ?? "file",
            parameters: parameters,
            headers: headers,
            method: call.getString("requestMethod") ?? "POST"
        )
        do {
            try uploader.start(request)
            call.resolve()
        } catch let error as Uploader.StartError {
            switch error {
            case .missingOption(let name):
                call.reject("\(name) is required", "MISSING_OPTION")
            case .invalidServerUrl(let url):
                call.reject("serverUrl is not an http(s) URL: \(url)", "INVALID_URL")
            case .fileNotFound(let path):
                call.reject("No file at \(path)", "FILE_NOT_FOUND")
            }
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func removeUpload(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required", "MISSING_OPTION")
            return
        }
        uploader.remove(id: id) {
            call.resolve()
        }
    }

    @objc func acknowledgeEvent(_ call: CAPPluginCall) {
        guard let eventId = call.getString("eventId"), !eventId.isEmpty else {
            call.reject("eventId is required", "MISSING_OPTION")
            return
        }
        uploader.acknowledge(eventId: eventId)
        call.resolve()
    }

    /// Form values arrive from JavaScript as strings, numbers or booleans; all are sent as text.
    static func string(_ value: Any) -> String? {
        switch value {
        case let text as String:
            return text
        case let number as NSNumber:
            return number.stringValue
        default:
            return nil
        }
    }
}
