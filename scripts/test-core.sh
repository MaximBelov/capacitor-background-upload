#!/usr/bin/env bash
# Runs the XCTest of BackgroundUploadCore on this Mac with `swift test`. The core needs Foundation only; the Capacitor
# bridge is left out of the package for this run (see Package.swift), because Capacitor's binaries are iOS-only.
set -euo pipefail
cd "$(dirname "$0")/.."
BACKGROUND_UPLOAD_CORE_ONLY=1 swift test --scratch-path build/swift-core "$@"
