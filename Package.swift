// swift-tools-version: 5.9
import PackageDescription

// Two targets: BackgroundUploadCore is the uploader itself and needs Foundation only, so its tests run on a Mac with
// `swift test`; BackgroundUploadPlugin is the Capacitor bridge around it. Setting BACKGROUND_UPLOAD_CORE_ONLY leaves the
// bridge and Capacitor out of the package, which is how scripts/test-core.sh runs the tests on macOS, where
// Capacitor's iOS-only binaries cannot be linked.
let coreOnly = Context.environment["BACKGROUND_UPLOAD_CORE_ONLY"] != nil

let core: [Target] = [
    .target(
        name: "BackgroundUploadCore",
        path: "ios/Sources/BackgroundUploadCore"),
    .testTarget(
        name: "BackgroundUploadCoreTests",
        dependencies: ["BackgroundUploadCore"],
        path: "ios/Tests/BackgroundUploadCoreTests")
]

let bridge: [Target] = [
    .target(
        name: "BackgroundUploadPlugin",
        dependencies: [
            "BackgroundUploadCore",
            .product(name: "Capacitor", package: "capacitor-swift-pm"),
            .product(name: "Cordova", package: "capacitor-swift-pm")
        ],
        path: "ios/Sources/BackgroundUploadPlugin")
]

let package = Package(
    name: "CapacitorBackgroundUpload",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: coreOnly
        ? [.library(name: "BackgroundUploadCore", targets: ["BackgroundUploadCore"])]
        : [.library(name: "CapacitorBackgroundUpload", targets: ["BackgroundUploadPlugin"])],
    dependencies: coreOnly
        ? []
        : [.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")],
    targets: coreOnly ? core : core + bridge
)
