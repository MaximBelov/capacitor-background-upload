// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CapacitorPluginBackgroundUpload",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapacitorPluginBackgroundUpload",
            targets: ["BackgroundUploadPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "BackgroundUploadPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/BackgroundUploadPlugin"),
        .testTarget(
            name: "BackgroundUploadPluginTests",
            dependencies: ["BackgroundUploadPlugin"],
            path: "ios/Tests/BackgroundUploadPluginTests")
    ]
)