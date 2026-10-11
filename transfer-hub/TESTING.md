# Native iPhone testing from Windows

The iPhone app uses a **shared web interface in a WKWebView shell**, with native Swift code for background downloads, Keychain and file export. The files in `phone/` are both bundled into the IPA and tested on Windows. The app/test source is public at https://github.com/stiztics/download-hub. The first unsigned IPA is available in the [v0.1.0 release](https://github.com/stiztics/download-hub/releases/tag/v0.1.0) for SideStore installation. The Release iPhone IPA and simulator bundle have compiled successfully on GitHub's standard macOS runner. Native simulator checks are being validated; physical iPhone and SideStore behavior still require device testing. No Appetize session has been run.

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

The separate SwiftUI phone screens have been replaced. `ios/DownloadHub/PhoneWebView.swift` loads the exact `phone/` resources and exposes only named commands. Credentials and physical file URLs remain in native code; external navigation and messages from subframes are refused. The shared interface provides Library, Fetch, Queue, Downloaded and Settings.

Fetch controls the existing Windows runner through the authenticated hub: source search, paged results, episode selection, collection names, PC job status, pause/resume, cancel/retry and prioritization. PC jobs and phone pickup are separate queues. Browser tests use an injected synthetic runner client and exercise both JavaScript command transports; the backend integration test uses the real runner with a synthetic provider and confirms its completed file can be picked up by a paired phone. Demo mode disables all source controls. No live source download is started by these tests. Swift adds typed responses that exclude runner credentials and folder paths, and safely encodes query parameters; its execution still needs native validation.

Windows uses `testing/windows-host.js` behind the same command contract. It performs real authenticated HTTP range downloads of the generated files, hashes the bytes, and saves them in IndexedDB for reload/recovery tests. Transfers are deliberately paced and capped at 16 MiB in this test adapter. Only the isolated fixture serves the adapter; the real collection service does not. The iPhone build does not bundle the test adapter and uses the existing native background `URLSession` engine. Windows test credentials are synthetic and stored in the isolated browser session; actual iPhone credentials stay in Keychain.

Native offline files are stored in Documents and exported through the iOS share sheet. Browser tests use an actual browser download to verify exported bytes and confirm that deleting the saved copy preserves the PC original. Passing these tests does not prove native storage, Keychain, background scheduling or share-sheet behavior.

Playwright WebKit is a desktop test engine, not Safari on iOS 26 and not an iPhone simulator. The native IPA is built on macOS and still needs occasional real-iPhone checks. Hosted native tests below are optional validation, not the everyday Windows development loop.

## Prepared path

1. Keep editing source on Windows.
2. Manually run **iOS simulator tests** from Actions in the public app/test repository. That test workflow has no automatic push/PR trigger. **Build iPhone IPA** runs on native/shared-interface changes on `main`, or on manual dispatch, and returns the unsigned IPA plus its SHA-256 checksum.
3. A standard `macos-26` runner builds with XcodeGen/Xcode and runs the open-source Maestro CLI. No Maestro Cloud account/API key or Apple signing credentials are needed for the simulator.
4. Download the `download-hub-simulator` artifact: build logs, selected device/runtime, JUnit reports, screenshots, and `DownloadHub-simulator.zip`. Artifacts expire after one day.
5. Inspect failures/screenshots, fix locally, update the repository, and run again. The first Mac run validated Swift compilation; native flow checks remain pending. Windows checks cannot guarantee native execution succeeds.

The workflow prefers an available iPhone 15 Pro/iOS 26 simulator and records the actual device/runtime. Hosted runner images may offer different devices or runtimes; a fallback is explicitly recorded in `test-device.json`. Simulator results do not prove behavior on the physical iPhone.

## What the tests cover

`ios/maestro/transfer.yaml` exercises rejected and successful native pairing, library/episode navigation, selection, queueing, real `URLSession` downloads, SHA-256 verification, and offline persistence across app relaunch. The backend also checks that both full download receipts arrived. Each run creates two generated 2 MiB binary files in a temporary folder on the runner, using the real transfer service. No downloaded media, PC runtime state, Tailscale credentials or browser profiles are involved.

`ios/maestro/demo.yaml` exercises navigation and queue selection using clearly labeled demo data. Demo mode does **not** simulate successful downloads. It exists for short Appetize sessions that cannot access the PC's private transfer server.

The `SimulatorTest` configuration enables loopback HTTP and test launch arguments only under `HUB_TESTING && targetEnvironment(simulator)`. The Release device build retains HTTPS pairing, its separate production plist, and no demo entry point.

## Appetize visual testing

Upload `DownloadHub-simulator.zip` manually after approving use of that service. Appetize takes a compressed simulator `.app`, **not** the SideStore `.ipa`. The build contains both ARM and Intel simulator architectures. On its pairing screen, tap **Try demo library** to explore the screens without a server. Real file downloads require a reachable HTTPS fixture/server; uploading the demo bundle alone does not test remote transfers.

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
