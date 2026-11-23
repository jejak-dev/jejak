// swift-tools-version: 6.0
import PackageDescription

// Paket inti cangkang macOS Jejak: logika murni + pengelola proses sidecar.
// Tes memakai harness mini (scripts/build-core.sh test), bukan target SwiftPM.
let package = Package(
  name: "JejakShell",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "JejakShellCore", targets: ["JejakShellCore"]),
  ],
  targets: [
    .target(name: "JejakShellCore"),
    .executableTarget(name: "jejak-desktop", dependencies: ["JejakShellCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
  ]
)
