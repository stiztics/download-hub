#if HUB_TESTING && targetEnvironment(simulator)
import Foundation
import UIKit
import AVFoundation
import CoreVideo

// Only the simulator test configuration can run this generated-file integration
// suite. Device Release builds have neither this entry point nor HTTP fixtures.
@MainActor enum NativeSelfTest {
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
                checks.append("catalog, organization and files persist across offline relaunch")
            } else {
                guard let server = UserDefaults.standard.string(forKey: "hubTestServer"), let code = UserDefaults.standard.string(forKey: "hubTestCode") else { throw HubError.message("Missing generated fixture arguments.") }
                await model.pair(serverText: server, code: code)
                guard let credentials = model.credentials else { throw HubError.message(model.message ?? "Pairing failed") }
                let response: LibraryResponse = try await HubAPI(credentials: credentials).send("library")
                try require(response.files.count == 2, "Fixture should contain two files")
                try DeviceLibrary.shared.synchronize(response.files, server: credentials.server)
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
                try await Task.sleep(nanoseconds: 1_000_000_000)
                media.finishPlayback()
                try await Task.sleep(nanoseconds: 500_000_000)
                _ = try await media.importEpisode(indexed.id)
                try require(try DeviceLibrary.shared.episode(indexed.id).locations.contains { $0.kind == "phone" }, "SSD import did not create an iPhone copy")
                media.presenter = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow }?.rootViewController
                _ = try await media.play(indexed.id)
                try await Task.sleep(nanoseconds: 500_000_000)
                media.finishPlayback()
                checks.append("video scan, verified import, AVKit presentation and playback position")
                model.disconnect(); ExternalDownloads.shared.disconnect()
                try require(try DeviceLibrary.shared.snapshot().count == 3, "Disconnect erased the catalog")
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
