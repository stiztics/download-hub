#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[[ "$(uname -s)" == Darwin ]] || { echo 'A Mac with Xcode is required for the native simulator build.' >&2; exit 1; }
command -v xcodegen >/dev/null || { echo 'Install XcodeGen first: brew install xcodegen' >&2; exit 1; }
mkdir -p build/reports
xcodegen generate
xcodebuild -project DownloadHub.xcodeproj -scheme DownloadHub -configuration SimulatorTest \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/Simulator CODE_SIGNING_ALLOWED=NO ONLY_ACTIVE_ARCH=NO \
  'ARCHS=arm64 x86_64' build 2>&1 | tee build/reports/build.log
app='build/Simulator/Build/Products/SimulatorTest-iphonesimulator/DownloadHub.app'
# Simulator-only ad hoc identity lets the real Keychain API run. SideStore
# supplies the device identity when it signs the separate unsigned IPA.
cat > build/simulator-entitlements.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>application-identifier</key><string>HUBSIMULATOR.local.downloadhub.personal</string>
<key>keychain-access-groups</key><array><string>HUBSIMULATOR.local.downloadhub.personal</string></array>
</dict></plist>
PLIST
codesign --force --sign - --entitlements build/simulator-entitlements.plist "$app"
ditto -c -k --sequesterRsrc --keepParent "$app" build/DownloadHub-simulator.zip
echo 'Simulator bundle: transfer-hub/ios/build/DownloadHub-simulator.zip'
