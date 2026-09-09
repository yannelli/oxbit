// swift-tools-version:5.7
import PackageDescription

let package = Package(
  name: "tauri-plugin-oxbit-files",
  platforms: [
    .iOS(.v16)
  ],
  products: [
    .library(
      name: "tauri-plugin-oxbit-files",
      type: .static,
      targets: ["tauri-plugin-oxbit-files"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-oxbit-files",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
