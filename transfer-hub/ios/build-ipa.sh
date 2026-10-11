#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script requires macOS with Xcode. Windows cannot compile this native iOS app."
  exit 1
fi
if ! command -v xcodegen >/dev/null; then
  echo "Install XcodeGen on the Mac build machine, then rerun: brew install xcodegen"
  exit 1
fi
xcodegen generate
xcodebuild -project DownloadHub.xcodeproj -scheme DownloadHub -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath build/DerivedData \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY='' build
# A fresh staging folder prevents stale resources from older builds being shipped.
package_dir="$(mktemp -d "$(pwd)/build/package.XXXXXX")"
mkdir -p "$package_dir/Payload"
cp -R build/DerivedData/Build/Products/Release-iphoneos/DownloadHub.app "$package_dir/Payload/"
(cd "$package_dir" && zip -FSqry "$(pwd)/../DownloadHub-unsigned.ipa" Payload)
echo "IPA ready: $(pwd)/build/DownloadHub-unsigned.ipa"
echo "Unsigned device build. Sign and install with SideStore."
