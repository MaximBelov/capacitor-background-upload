import Foundation

@objc public class BackgroundUpload: NSObject {
    @objc public func echo(_ value: String) -> String {
        print(value)
        return value
    }
}
