# Native iPhone testing from Windows

The iPhone owns its persistent library. Windows supplies downloads and file transfers. A shared interface runs in WKWebView, with Swift handling the catalog, Keychain, background downloads, Apple's AVKit player, document picking, verified copying and direct external-folder transfers. The files in `phone/` are bundled into the IPA and tested on Windows. The unsigned [v0.2.0 IPA](https://github.com/stiztics/download-hub/releases/tag/v0.2.0) is ready for SideStore. All 51 Windows UI tests and 37 local backend tests passed, along with the [native iOS 26.4 integration and offline relaunch run](https://github.com/stiztics/download-hub/actions/runs/38168141710). The hosted device was an iPhone 17 Pro simulator; Windows uses the iPhone 15 Pro viewport. Physical iPhone, external USB provider and SideStore behavior still require device testing. No Appetize session has been run.

## Using the device library

Library opens without pairing. Episodes are grouped by series and season with On iPhone, On PC and On SSD badges. PC metadata stays available offline, and phone organization survives refresh. Tap a local episode to play with Apple's native controls; playback position is retained. PC-only episodes open their details so you can queue a transfer. Apple codec support applies: unsupported videos remain importable/exportable but may not play.

Use **Add SSD folder** to select a USB/SSD folder through Files. The app indexes videos without copying them, plays accessible files in place, and remembers the folder with a security-scoped bookmark. Reconnect and rescan after changing its contents; reselect the folder if iOS invalidates its bookmark. **Import files** or **Copy to iPhone** creates a verified offline copy. **Export to folder** writes an organized series/season copy and preserves the original. Existing destination filenames are refused. Deleting an iPhone copy preserves PC and drive copies.

Downloads can target iPhone storage or a selected external folder. Phone transfers use background URLSession. Direct external transfers stream bounded 1 MiB ranges into a partial file on the chosen drive, then verify SHA-256 before saving. They pause when the app backgrounds, preserve partials on the drive, and require the PC, app and drive to be available when resuming. An entire video is never staged in phone storage for this mode. Choose a writable, locally attached drive folder: arbitrary cloud Files providers are not validated for direct transfers.

Discover creates PC download requests plus phone-owned transfer intentions. **Transfer when ready** sends completed episodes to the selected destination when the app next connects. The PC runner continues while the app is closed; discovering newly completed files needs the app to reopen. Transfers and catalog records persist locally. Copies merge only after matching size and verified content hashes; matching filenames alone do not establish identity. Indexed SSD files are not all hashed eagerly, so unrelated catalog copies may remain separate until an import/export/transfer verifies them.

Existing native transfer files are retained and migrated into the catalog. Update the same SideStore app without uninstalling it to preserve its sandbox. The PC hub must also run the updated source so completed download identities reach the phone.

## Frequent free testing on Windows

The preferred everyday loop is local browser and backend testing. No GitHub/Appetize account, repository upload or hosted minutes are needed. The installed Playwright browsers can be reused as often as needed on this PC.

On a fresh PC, first run `npm install` and `npx playwright install chromium webkit`. The package and browser downloads are free. The browsers are already installed on this PC.

```powershell
npm test
npm run test:ui
npm run test:ui:report
```

`test:ui` runs the suite across desktop Chromium, phone Chromium and phone WebKit at an iPhone 15 Pro viewport. It covers the desktop dashboard and the shared iPhone screens: search/empty results, selection, queue deduplication/removal, rejected/successful pairing, transfers, pause/resume, checksum failure/retry, saved files across reload, partial-file recovery, export, deletion, disconnect and access revocation. Every case starts an isolated copy of the real transfer backend with generated files; it does not change the actual library or pairing. Screenshots, a local HTML report, and traces on failure are stored in `transfer-hub/.test-results/`.

`npm run test:ui:repeat` repeats each case five times when checking an intermittent bug. Normal iteration uses one pass. `npm run hub:demo` prints URLs for an isolated interactive desktop/shared-phone preview and a generated pairing code; Ctrl+C stops it. The shared app is at `/app/`; the legacy browser pickup preview remains at `/phone`.

`ios/DownloadHub/PhoneWebView.swift` loads the exact `phone/` resources and exposes only named commands. Credentials, physical URLs and bookmarks remain in native code; external navigation and messages from subframes are refused. The interface provides Library, Discover, Downloads and Settings.

Fetch controls the existing Windows runner through the authenticated hub: source search, paged results, episode selection, collection names, PC job status, pause/resume, cancel/retry and prioritization. PC jobs and phone pickup are separate queues. Browser tests use an injected synthetic runner client and exercise both JavaScript command transports; the backend integration test uses the real runner with a synthetic provider and confirms its completed file can be picked up by a paired phone. Demo mode disables all source controls. No live source download is started by these tests. Swift adds typed responses that exclude runner credentials and folder paths, and safely encodes query parameters; its execution still needs native validation.

Windows uses `testing/windows-host.js` behind the same command contract. It performs real authenticated HTTP range downloads of the generated files, hashes the bytes, and saves them in IndexedDB for reload/recovery tests. Transfers are deliberately paced and capped at 16 MiB in this test adapter. Only the isolated fixture serves the adapter; the real collection service does not. The iPhone build does not bundle the test adapter and uses the existing native background `URLSession` engine. Windows test credentials are synthetic and stored in the isolated browser session; actual iPhone credentials stay in Keychain.

Native offline files are stored in Documents and exported through the iOS share sheet. Browser tests use an actual browser download to verify exported bytes and confirm that deleting the saved copy preserves the PC original. Passing these tests does not prove native storage, Keychain, background scheduling or share-sheet behavior.

Playwright WebKit is a desktop test engine, not Safari on iOS 26 and not an iPhone simulator. The native IPA is built on macOS and still needs occasional real-iPhone checks. Hosted native tests below are optional validation, not the everyday Windows development loop.

## Prepared path

1. Keep editing source on Windows.
2. Manually run **iOS simulator tests** from Actions in the public app/test repository. That test workflow has no automatic push/PR trigger. **Build iPhone IPA** runs on native/shared-interface changes on `main`, or on manual dispatch, and returns the unsigned IPA plus its SHA-256 checksum.
3. A standard `macos-26` runner builds with XcodeGen/Xcode and runs native generated-file integration checks. Simulator-only ad hoc signing enables the real Keychain API without Apple signing credentials. Maestro UI checks are an optional workflow input.
4. Download the `download-hub-simulator` artifact: build logs, selected device/runtime, JUnit reports, screenshots, and `DownloadHub-simulator.zip`. Artifacts expire after one day.
5. Inspect failures/screenshots, fix locally, update the repository, and run again. Windows checks cannot guarantee native execution succeeds.

The workflow prefers an available iPhone 15 Pro/iOS 26 simulator and records the actual device/runtime. Hosted runner images may offer different devices or runtimes; a fallback is explicitly recorded in `test-device.json`. Simulator results do not prove behavior on the physical iPhone.

## What the tests cover

`ios/test-native.sh` launches the actual simulator app, checks real Keychain pairing and URLSession downloads, hashes saved bytes, exercises catalog migration and organization, bounded direct-folder transfers with pause/resume, copy verification and collision protection, scans/imports a generated H.264 video, presents AVKit for drive and phone playback, then relaunches the app offline to verify persistent files and organization. The external test folder is in the app container: this checks Swift logic, not a physical USB device or Files provider. Reports list completed checks and fail on any error. No downloaded media, PC runtime state, Tailscale credentials or browser profiles are involved.

`ios/maestro/transfer.yaml` provides optional pairing, navigation, download and relaunch UI checks, with native bytes/checksums checked afterward. The hosted iOS 26 runtime has returned an empty WKWebView accessibility tree even when screenshots show the page; Maestro is disabled by default until that issue is resolved. Windows tests exercise the shared UI instead. Never treat a compiled bundle or a screenshot as proof of completed native tests.

`ios/maestro/demo.yaml` exercises navigation and queue selection using clearly labeled demo data. Demo mode does **not** simulate successful downloads. It exists for short Appetize sessions that cannot access the PC's private transfer server.

The `SimulatorTest` configuration enables loopback HTTP and test launch arguments only under `HUB_TESTING && targetEnvironment(simulator)`. The Release device build retains HTTPS pairing, its separate production plist, and no demo entry point.

## Appetize visual testing

Upload `DownloadHub-simulator.zip` manually after approving use of that service. Appetize takes a compressed simulator `.app`, **not** the SideStore `.ipa`. The build contains both ARM and Intel simulator architectures. Open Settings and tap **Try demo library** to explore the screens without a server. Real file downloads require a reachable HTTPS fixture/server; uploading the demo bundle alone does not test remote transfers.

Appetize's published free plan currently provides 30 minutes per month and three minutes per session. That is enough for occasional browser Computer Use checks, not an unlimited development session. Browser control also depends on the service's UI being accessible to the available tools.

## Cost and privacy

GitHub standard hosted runners are free for public repositories. The user authorized publishing the app/test source for this build. The repository excludes downloaded media, PC runtime state, credentials and browser profiles. It includes two local runner adapter files needed by the test backend, but does not contain the full PC downloader. Workflows use standard runners, retain Actions artifacts for one day and do not enable paid runners or change billing. GitHub's runtime, concurrency and storage limits still apply.

For a reviewable app/test-only source export, run on Windows:

```powershell
node transfer-hub/testing/prepare-bundle.mjs
```

It creates a new `transfer-hub/test-export/<timestamp>/` folder with an explicit source allowlist and manifest. It excludes the existing downloader, media library, browser profiles, state, tokens, and build products. This action alone uploads nothing.

## Commands on a Mac

Install Xcode with an iOS Simulator runtime, XcodeGen, Java 17+, Node 20+, and Maestro, then run from the repository root:

```bash
bash transfer-hub/ios/build-simulator.sh
bash transfer-hub/ios/test-native.sh
# Optional, subject to hosted WKWebView accessibility limitations:
bash transfer-hub/ios/test-simulator.sh
```

For the **device** IPA, run `bash transfer-hub/ios/build-ipa.sh` and sign the resulting unsigned IPA with SideStore. This is a separate build artifact. Final tests belong on the user's iPhone: private Tailscale access from another network, screen lock/background transfers, pause/resume, force-quit/relaunch, Files export, storage pressure and SideStore installation/refresh. Simulator tests and remote real-device services do not validate the exact SideStore/VPN setup.

## Primary references

- [Maestro iOS support](https://docs.maestro.dev/get-started/supported-platform/ios)
- [Maestro CLI installation](https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli)
- [Appetize simulator upload format](https://docs.appetize.io/platform/app-management/uploading-apps/ios)
- [Appetize pricing and session limits](https://site.appetize.io/pricing)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [GitHub hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
