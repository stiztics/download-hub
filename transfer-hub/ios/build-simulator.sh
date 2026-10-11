#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[[ "$(uname -s)" == Darwin ]] || { echo 'A Mac with Xcode is required for the native simulator build.' >&2; exit 1; }
command -v xcodegen >/dev/null || { echo 'Install XcodeGen first: brew install xcodegen' >&2; exit 1; }
mkdir -p build/reports
xcodegen generate
xcodebuild -project DownloadHub.xcodeproj -scheme DownloadHub -configuration SimulatorTest \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/Simulator CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- ONLY_ACTIVE_ARCH=NO \
  'ARCHS=arm64 x86_64' build 2>&1 | tee build/reports/build.log
app='build/Simulator/Build/Products/SimulatorTest-iphonesimulator/DownloadHub.app'
# Let Xcode generate the simulator's local signing identity and entitlements.
# The separate device IPA remains unsigned for SideStore.
codesign --display --entitlements - "$app" > build/reports/simulator-entitlements.plist
ditto -c -k --sequesterRsrc --keepParent "$app" build/DownloadHub-simulator.zip
echo 'Simulator bundle: transfer-hub/ios/build/DownloadHub-simulator.zip'
