#if HUB_TESTING && targetEnvironment(simulator)
import Foundation
import UIKit
import AVFoundation
import CoreVideo

// Only the simulator test configuration can run this generated-file integration
// suite. Device Release builds have neither this entry point nor HTTP fixtures.
@MainActor enum NativeSelfTest {
    private static var started = false
    static func start(_ model: HubModel) {
        guard !started else { return }
        started = true
        // A fullscreen AVKit presentation hides the SwiftUI root. Its .task
        // is canceled on disappearance; the integration run must outlive it.
        Task { @MainActor in await run(model) }
    }
    static func run(_ model: HubModel) async {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let report = directory.appendingPathComponent("native-selftest.json")
        var checks: [String] = []
        do {
            if UserDefaults.standard.bool(forKey: "hubSelfTestOffline") {
                model.disconnect()
                let snapshot = try DeviceLibrary.shared.snapshot()
                try require(snapshot.count >= 3, "Catalog did not survive process relaunch")
                try require(snapshot.contains { ($0["series"] as? String) == "Organized on phone" }, "Organization was lost")
                try require(DeviceLibrary.shared.state.episodes.flatMap(\.locations).filter { $0.kind == "phone" && DeviceLibrary.shared.available($0) }.count >= 3, "Saved files disappeared offline")
                try require(DeviceLibrary.shared.state.episodes.contains { $0.file.filename == "Episode 1.mp4" && $0.position > 0 }, "Playback position did not survive relaunch")
                checks.append("catalog, organization and files persist across offline relaunch")
            } else {
                guard let server = UserDefaults.standard.string(forKey: "hubTestServer"), let code = UserDefaults.standard.string(forKey: "hubTestCode") else { throw HubError.message("Missing generated fixture arguments.") }
                await model.pair(serverText: server, code: code)
                guard let credentials = model.credentials else { throw HubError.message(model.message ?? "Pairing failed") }
                let response: LibraryResponse = try await HubAPI(credentials: credentials).send("library")
                try require(response.files.count == 2, "Fixture should contain two files")
                var handoffFiles = response.files
                handoffFiles[0].sourceId = "generated/episode1"
                try DeviceLibrary.shared.requestPC(title: FetcherTitleResponse(id: "generated", title: "Generated", episodes: [FetcherEpisode(id: "episode1", number: .number(1))]), episodeIDs: ["episode1"], series: "Generated", server: credentials.server, destination: "phone", copyWhenReady: true)
                try require(DeviceLibrary.shared.state.episodes.count == 1, "Phone request did not create a pending episode")
                try DeviceLibrary.shared.synchronize(handoffFiles, server: credentials.server)
                let ready = DeviceLibrary.shared.readyRequests(handoffFiles, server: credentials.server)
                try require(ready.count == 1 && ready[0].0.copyWhenReady, "Completed PC episode did not match the phone request")
                try DeviceLibrary.shared.finishRequest(ready[0].0.id)
                checks.append("phone-owned pending request resolves to the completed PC file")
                let entries = response.files.map { file in QueueEntry(id: String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(24)), fileId: file.id, filename: file.filename, series: file.series, title: file.title, bytes: file.bytes, status: "queued", bytesCompleted: 0, error: nil, queuedAt: "", updatedAt: "", clientOwned: true, fingerprint: file.fingerprint) }
                TransferManager.shared.stage(entries); TransferManager.shared.startWaiting()
                try await waitFor("native iPhone transfers") { TransferManager.shared.transfers.filter { $0.status == "downloaded" }.count == 2 }
                _ = try DeviceLibrary.shared.snapshot()
                try require(DeviceLibrary.shared.state.episodes.count == 2, "PC and phone copies were duplicated")
                for row in TransferManager.shared.transfers {
                    guard let url = TransferManager.shared.fileURL(row), let expected = row.verifiedSHA256 else { throw HubError.message("Native file or checksum missing") }
                    let digest = try await Task.detached { try fileDigest(url) }.value
                    try require(digest == expected, "Saved native bytes are wrong")
                }
                checks.append("real URLSession background transfers, SHA-256 and catalog migration")
                let first = DeviceLibrary.shared.state.episodes[0]
                try DeviceLibrary.shared.organize(first.id, series: "Organized on phone", season: "Season 3", episode: 7)
                try DeviceLibrary.shared.synchronize(response.files, server: credentials.server)
                try require(try DeviceLibrary.shared.episode(first.id).file.series == "Organized on phone", "PC refresh overwrote phone organization")
                checks.append("phone organization survives server refresh")
                let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("GeneratedSSD", isDirectory: true)
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                let drive = try DeviceLibrary.shared.addDrive(root)
                ExternalDownloads.shared.connect(credentials)
                let source = first.locations.first { $0.kind == "pc" }!
                try ExternalDownloads.shared.stage(try DeviceLibrary.shared.episode(first.id), source: source, driveID: drive.id)
                try ExternalDownloads.shared.start()
                try await waitFor("first external chunk") { ExternalDownloads.shared.jobs.first?.received ?? 0 >= 1_048_576 }
                let directID = ExternalDownloads.shared.jobs[0].id
                try require(ExternalDownloads.shared.jobs[0].status == "downloading", "External transfer finished before pause coverage")
                ExternalDownloads.shared.pause(directID)
                try await Task.sleep(nanoseconds: 1_000_000_000)
                try require(ExternalDownloads.shared.jobs[0].status == "paused", "External pause was not preserved")
                try ExternalDownloads.shared.resume(directID)
                try await waitFor("native direct folder transfer") { ExternalDownloads.shared.jobs.first?.status == "downloaded" }
                let external = try DeviceLibrary.shared.episode(first.id).locations.first { $0.kind == "drive" }!
                let (externalURL, scope) = try DeviceLibrary.shared.localURL(external)
                defer { scope?.stopAccessingSecurityScopedResource() }
                try require(try fileDigest(externalURL) == external.checksum, "External bytes are wrong")
                try require(DeviceLibrary.shared.state.episodes.count == 2, "Verified SSD copy was not deduplicated")
                checks.append("direct bounded range writes, partial pause/resume and verified PC/phone/drive deduplication")
                let copy = root.appendingPathComponent("Exported/Season 3/" + first.file.filename)
                try coordinatedCopy(from: externalURL, to: copy)
                do { try coordinatedCopy(from: externalURL, to: copy); throw HubError.message("Existing export was overwritten") }
                catch { try require(error.localizedDescription.contains("already exists"), "Export collision protection failed") }
                try require(FileManager.default.fileExists(atPath: externalURL.path), "Export removed its source")
                checks.append("coordinated export preserves source and refuses overwrite")
                let video = root.appendingPathComponent("Video series/S01/Episode 1.mp4")
                try FileManager.default.createDirectory(at: video.deletingLastPathComponent(), withIntermediateDirectories: true)
                try await makeVideo(video)
                let asset = AVURLAsset(url: video)
                try require(try await asset.load(.isPlayable), "Generated video is not playable")
                let media = LibraryMedia()
                let count = try await media.scan(drive.id)
                try require(count == 1, "External video folder was not indexed")
                let indexed = DeviceLibrary.shared.state.episodes.first { $0.file.filename == "Episode 1.mp4" }!
                media.presenter = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow }?.rootViewController
                _ = try await media.play(indexed.id)
                try await waitFor("actual drive playback progress") { media.playbackSeconds > 0 }
                media.finishPlayback()
                try await Task.sleep(nanoseconds: 500_000_000)
                _ = try await media.importEpisode(indexed.id)
                try require(try DeviceLibrary.shared.episode(indexed.id).locations.contains { $0.kind == "phone" }, "SSD import did not create an iPhone copy")
                media.presenter = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow }?.rootViewController
                try DeviceLibrary.shared.setPosition(indexed.id, seconds: 0)
                _ = try await media.play(indexed.id)
                try await waitFor("actual phone playback progress") { media.playbackSeconds > 0 }
                try require(media.embeddedPlayer, "AVKit was presented as the fullscreen dismissal controller")
                media.capturePlayer(directory.appendingPathComponent("player-controls.png"))
                try require(FileManager.default.fileExists(atPath: directory.appendingPathComponent("player-controls.png").path), "Player screenshot was not captured")
                media.finishPlayback()
                checks.append("video scan, verified import, AVKit presentation and playback position")
                try await testBulk(checks: &checks)
                model.disconnect(); ExternalDownloads.shared.disconnect()
                try require(try DeviceLibrary.shared.snapshot().count >= 3, "Disconnect erased the catalog")
                checks.append("offline library remains available after disconnect")
            }
            let data = try JSONSerialization.data(withJSONObject: ["success": true, "checks": checks], options: [.prettyPrinted, .sortedKeys])
            try data.write(to: report, options: .atomic)
        } catch {
            let data = try? JSONSerialization.data(withJSONObject: ["success": false, "checks": checks, "error": error.localizedDescription], options: [.prettyPrinted, .sortedKeys])
            try? data?.write(to: report, options: .atomic)
        }
    }
    private static func require(_ condition: Bool, _ message: String) throws { if !condition { throw HubError.message(message) } }
    private static func testBulk(checks: inout [String]) async throws {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let sourceRoot = documents.appendingPathComponent("GeneratedBulkSource"), targetRoot = documents.appendingPathComponent("GeneratedBulkDestination")
        try FileManager.default.createDirectory(at: targetRoot, withIntermediateDirectories: true)
        var originals: [URL] = []
        for number in 1...2 {
            let url = sourceRoot.appendingPathComponent("Bulk series/S0\(number)/Episode \(number).mp4")
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(repeating: UInt8(number), count: 4 * 1024 * 1024 + number).write(to: url)
            originals.append(url)
        }
        let sourceDrive = try DeviceLibrary.shared.addDrive(sourceRoot), destinationDrive = try DeviceLibrary.shared.addDrive(targetRoot)
        let media = LibraryMedia(); try require(try await media.scan(sourceDrive.id) == 2, "Nested bulk videos were not indexed")
        let ids = Set(DeviceLibrary.shared.state.episodes.filter { $0.locations.contains { $0.driveID == sourceDrive.id } }.map(\.id))
        let copies = LibraryCopies.shared
        let plan = try copies.prepareImport(sourceDrive.id)
        try require(plan["total"] as? Int == 2, "Bulk import did not include both subfolders")
        try copies.start(plan["id"] as! String, removeOriginals: false); copies.cancel()
        try await waitFor("bulk cancellation") { !copies.active }
        try require(copies.batch?.status == "canceled", "Bulk cancellation did not settle")
        let partial = documents.appendingPathComponent(copies.batch!.items[0].targetName).deletingLastPathComponent().appendingPathComponent(copyPartialName(copies.batch!.id, 0))
        try FileManager.default.createDirectory(at: partial.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("interrupted partial".utf8).write(to: partial)
        try copies.retry(); try await waitFor("bulk recursive import") { !copies.active }
        try require(!FileManager.default.fileExists(atPath: partial.path), "Retry left an interrupted partial behind")
        try require(copies.batch?.status == "completed", "Bulk import failed: \(copies.snapshot())")
        for original in originals {
            let relative = String(original.path.dropFirst(sourceRoot.path.count + 1))
            let local = documents.appendingPathComponent("Library/" + sourceDrive.id + "/" + relative)
            try require(try fileDigest(original) == fileDigest(local), "Bulk import bytes or folder structure changed")
        }
        let repeatPlan = try copies.prepareImport(sourceDrive.id)
        try require(repeatPlan["total"] as? Int == 0, "Already imported videos were repeated")
        let existingMovePlan = try copies.prepareImport(sourceDrive.id, includeImported: true)
        try require(existingMovePlan["total"] as? Int == 2 && copies.batch!.items.allSatisfy { FileManager.default.fileExists(atPath: documents.appendingPathComponent($0.targetName).path) }, "Existing local copies could not be selected for a verified move")
        do { try removeVerifiedOriginal(originals[0], destination: targetRoot.appendingPathComponent("disconnected.mp4"), checksum: fileDigest(originals[0])); throw HubError.message("Missing destination allowed source deletion") }
        catch { try require(FileManager.default.fileExists(atPath: originals[0].path), "Destination loss removed the original") }
        checks.append("recursive verified bulk import, folder preservation, cancel/retry and repeat skipping")
        let collision = targetRoot.appendingPathComponent("Bulk series/S01/Episode 1.mp4")
        try FileManager.default.createDirectory(at: collision.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("different existing file".utf8).write(to: collision)
        let exportPlan = try copies.prepareExport(destinationDrive.id, episodeIDs: ids)
        try copies.start(exportPlan["id"] as! String, removeOriginals: true)
        try await waitFor("bulk export collision") { !copies.active }
        try require(copies.batch?.status == "completed with errors", "Collision was not reported")
        try require(try String(contentsOf: collision, encoding: .utf8) == "different existing file", "Export overwrote existing content")
        let retained = documents.appendingPathComponent("Library/" + sourceDrive.id + "/Bulk series/S01/Episode 1.mp4")
        try require(FileManager.default.fileExists(atPath: retained.path), "Failed move removed the original")
        try FileManager.default.removeItem(at: collision)
        try copies.retry(); try await waitFor("bulk export retry") { !copies.active }
        try require(copies.batch?.status == "completed", "Export retry failed")
        for original in originals {
            let relative = String(original.path.dropFirst(sourceRoot.path.count + 1))
            let local = documents.appendingPathComponent("Library/" + sourceDrive.id + "/" + relative)
            try require(!FileManager.default.fileExists(atPath: local.path), "Verified move retained a local original")
            try require(try fileDigest(original) == fileDigest(targetRoot.appendingPathComponent(relative)), "Exported bytes differ")
        }
        let moveBack = try copies.prepareImport(sourceDrive.id)
        try copies.start(moveBack["id"] as! String, removeOriginals: true)
        try await waitFor("verified move to phone") { !copies.active }
        try require(copies.batch?.status == "completed", "Move to phone failed")
        for original in originals { try require(!FileManager.default.fileExists(atPath: original.path), "Verified SSD original was not removed") }
        // Copy first, move later must verify the existing phone files without
        // rewriting them or creating duplicate local copies.
        let previousItems = copies.batch!.items
        for item in previousItems {
            let relative = item.source.relativePath!
            try FileManager.default.copyItem(at: targetRoot.appendingPathComponent(relative), to: sourceRoot.appendingPathComponent(relative))
            try DeviceLibrary.shared.upsert(item.file, location: item.source)
        }
        let existing = try copies.prepareImport(sourceDrive.id, includeImported: true)
        let targets = copies.batch!.items.map { documents.appendingPathComponent($0.targetName) }
        let dates = try targets.map { try $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate }
        try copies.start(existing["id"] as! String, removeOriginals: true)
        try await waitFor("move already imported originals") { !copies.active }
        try require(copies.batch?.status == "completed", "Existing local copies could not be verified for moving")
        for (index, target) in targets.enumerated() {
            try require(try target.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate == dates[index], "An existing phone copy was unnecessarily rewritten")
        }
        for original in originals { try require(!FileManager.default.fileExists(atPath: original.path), "Already imported SSD original was not removed after verification") }
        checks.append("bulk export and moves in both directions verify bytes before deletion, protect collisions and retry")
    }
    private static func waitFor(_ name: String, condition: () -> Bool) async throws {
        for _ in 0..<1200 {
            if condition() { return }
            if let error = ExternalDownloads.shared.jobs.first(where: { $0.status == "failed" })?.error { throw HubError.message(error) }
            if let error = TransferManager.shared.transfers.first(where: { $0.status == "failed" })?.error { throw HubError.message(error) }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw HubError.message("Timed out waiting for \(name)")
    }
    private static func makeVideo(_ url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64])
        let adapter = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64])
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? HubError.message("Video writer failed") }
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<10 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 10_000_000) }
            var buffer: CVPixelBuffer?
            guard CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_32ARGB, nil, &buffer) == kCVReturnSuccess, let buffer else { throw HubError.message("Pixel buffer failed") }
            CVPixelBufferLockBaseAddress(buffer, [])
            if let base = CVPixelBufferGetBaseAddress(buffer) { memset(base, Int32(frame * 20), CVPixelBufferGetBytesPerRow(buffer) * 64) }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            guard adapter.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 10)) else { throw writer.error ?? HubError.message("Frame encoding failed") }
        }
        input.markAsFinished(); await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? HubError.message("Video encoding failed") }
    }
}
#endif
