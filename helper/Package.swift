// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "SpeechHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "SpeechHelper",
            path: "Sources/SpeechHelper",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("Carbon"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("IOKit"),
            ]
        ),
    ],
    swiftLanguageModes: [.v5]
)
