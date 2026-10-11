import UIKit
import UniformTypeIdentifiers
import AVKit
import AVFoundation

@MainActor final class LibraryMedia: NSObject, UIDocumentPickerDelegate {
    weak var presenter: UIViewController?
    private var selection: CheckedContinuation<[URL], Error>?
    private var picker: UIDocumentPickerViewController?
    private var playback: AVPlayer?
    private var playerController: UINavigationController?
    private var playbackRoot: URL?
    private var playbackID: String?
    private var timeObserver: Any?
    private var closeTimer: Timer?
    #if HUB_TESTING && targetEnvironment(simulator)
    var playbackSeconds: Double { playback?.currentTime().seconds ?? 0 }
    #endif
    private func controller() throws -> UIViewController {
        guard var controller = presenter else { throw HubError.message("The screen is not ready.") }
        while let next = controller.presentedViewController { controller = next }
        return controller
    }
    func pick(types: [UTType], copy: Bool = false, multiple: Bool = false) async throws -> [URL] {
        guard selection == nil else { throw HubError.message("Finish the open file picker first.") }
        let screen = try controller()
        return try await withCheckedThrowingContinuation { continuation in
            selection = continuation
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: copy)
            picker.allowsMultipleSelection = multiple; picker.delegate = self; self.picker = picker
            screen.present(picker, animated: true)
        }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let continuation = selection; selection = nil; picker = nil
        controller.dismiss(animated: true) { continuation?.resume(returning: urls) }
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let continuation = selection; selection = nil; picker = nil
        controller.dismiss(animated: true) { continuation?.resume(throwing: HubError.message("Selection canceled.")) }
    }
    func addFolder() async throws -> [String: Any] {
        guard let url = try await pick(types: [.folder]).first else { throw HubError.message("No folder selected.") }
        guard beginFolderAccess(url) else { throw HubError.message("Could not access that folder.") }
        defer { url.stopAccessingSecurityScopedResource() }
        let drive = try DeviceLibrary.shared.addDrive(url)
        let count = try await scan(drive.id)
        return ["name": drive.name, "count": count]
    }
    func scan(_ driveID: String) async throws -> Int {
        let root = try DeviceLibrary.shared.resolveDrive(driveID)
        guard beginFolderAccess(root) else { throw HubError.message("Reconnect the drive and add its folder again if needed.") }
        defer { root.stopAccessingSecurityScopedResource() }
        let name = DeviceLibrary.shared.state.drives.first(where: { $0.id == driveID })!.name
        let files = try await Task.detached(priority: .utility) { () throws -> [(String, LibraryFile)] in
            let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .isSymbolicLinkKey, .contentModificationDateKey]
            guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { throw HubError.message("The folder could not be read.") }
            var items: [(String, LibraryFile)] = []
            for case let file as URL in enumerator {
                try Task.checkCancellation()
                guard ["mp4", "m4v", "mov", "mkv", "avi", "webm", "ts"].contains(file.pathExtension.lowercased()) else { continue }
                let values = try file.resourceValues(forKeys: Set(keys))
                guard values.isRegularFile == true, values.isSymbolicLink != true, let bytes = values.fileSize, bytes > 0,
                      file.path.hasPrefix(root.path + "/") else { continue }
                let relative = String(file.path.dropFirst(root.path.count + 1))
                var metadata = inferredEpisode(file, relative: relative, folderName: name, bytes: Int64(bytes))
                metadata.fingerprint = "\(bytes):\(values.contentModificationDate?.timeIntervalSince1970 ?? 0)"
                items.append((relative, metadata))
                if items.count > 20_000 { throw HubError.message("Choose a smaller folder (up to 20,000 videos).") }
            }
            return items
        }.value
        for (relative, file) in files {
            try DeviceLibrary.shared.upsert(file, location: EpisodeLocation(id: "drive:\(driveID):\(relative)", kind: "drive", label: "On SSD · \(name)", driveID: driveID, relativePath: relative, fingerprint: file.fingerprint), persist: false)
        }
        try DeviceLibrary.shared.save()
        return files.count
    }
    func play(_ episodeID: String) async throws -> [String: Any] {
        stopPlayback()
        let item = try DeviceLibrary.shared.episode(episodeID)
        let local = item.locations.filter { $0.kind != "pc" && DeviceLibrary.shared.available($0) }.sorted { $0.kind == "phone" && $1.kind != "phone" }
        guard let source = local.first else { throw HubError.message("Download this episode or reconnect its drive to play.") }
        let (url, root) = try DeviceLibrary.shared.localURL(source)
        do {
            let asset = AVURLAsset(url: url)
            guard try await asset.load(.isPlayable) else { throw HubError.message("Apple's player cannot play this video format. You can still export the file.") }
            let controller = AVPlayerViewController()
            let player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
            controller.player = player; controller.allowsPictureInPicturePlayback = false
            controller.navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(closePlayback))
            let navigation = UINavigationController(rootViewController: controller)
            navigation.modalPresentationStyle = .fullScreen
            playback = player; playbackRoot = root; playbackID = item.id; playerController = navigation
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try AVAudioSession.sharedInstance().setActive(true)
            if item.position > 0 { await player.seek(to: CMTime(seconds: item.position, preferredTimescale: 600)) }
            timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 5, preferredTimescale: 600), queue: .main) { time in
                Task { @MainActor in try? DeviceLibrary.shared.setPosition(item.id, seconds: time.seconds) }
            }
            try self.controller().present(navigation, animated: true) { player.play() }
            closeTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self, let sourceRoot = self.playbackRoot, !FileManager.default.fileExists(atPath: sourceRoot.path) else { return }
                    self.closePlayback()
                }
            }
            return ["playing": true]
        } catch { if playbackRoot == nil { root?.stopAccessingSecurityScopedResource() }; stopPlayback(); throw error }
    }
    @objc private func closePlayback() { playerController?.dismiss(animated: true); stopPlayback() }
    func finishPlayback() { closePlayback() }
    private func stopPlayback() {
        if let player = playback {
            if let id = playbackID { try? DeviceLibrary.shared.setPosition(id, seconds: player.currentTime().seconds) }
            player.pause(); if let observer = timeObserver { player.removeTimeObserver(observer) }
        }
        closeTimer?.invalidate(); closeTimer = nil; timeObserver = nil; playback = nil; playerController = nil; playbackID = nil
        playbackRoot?.stopAccessingSecurityScopedResource(); playbackRoot = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    func importFiles() async throws -> [String: Any] {
        let urls = try await pick(types: [.item], multiple: true)
        var count = 0
        for url in urls {
            guard ["mp4", "m4v", "mov", "mkv", "avi", "webm", "ts"].contains(url.pathExtension.lowercased()) else { throw HubError.message("Choose video files to import.") }
            let allowed = url.startAccessingSecurityScopedResource()
            defer { if allowed { url.stopAccessingSecurityScopedResource() } }
            let name = UUID().uuidString + "_" + url.lastPathComponent
            let target = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(name)
            let result = try await Task.detached(priority: .utility) { () throws -> (LibraryFile, String) in
                try coordinatedCopy(from: url, to: target)
                do {
                    let bytes = (try target.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
                    return (inferredEpisode(url, relative: url.lastPathComponent, folderName: url.deletingLastPathComponent().lastPathComponent, bytes: Int64(bytes)), try fileDigest(target))
                } catch { try? FileManager.default.removeItem(at: target); throw error }
            }.value
            try DeviceLibrary.shared.upsert(result.0, location: EpisodeLocation(id: "phone:\(name)", kind: "phone", label: "On iPhone", localName: name, checksum: result.1))
            count += 1
        }
        return ["count": count]
    }
    func importEpisode(_ episodeID: String) async throws -> [String: Any] {
        let item = try DeviceLibrary.shared.episode(episodeID)
        if item.locations.contains(where: { $0.kind == "phone" && DeviceLibrary.shared.available($0) }) { return ["count": 0] }
        guard let source = item.locations.first(where: { $0.kind == "drive" && DeviceLibrary.shared.available($0) }) else { throw HubError.message("Reconnect the drive first.") }
        let (url, root) = try DeviceLibrary.shared.localURL(source); defer { root?.stopAccessingSecurityScopedResource() }
        let name = UUID().uuidString + "_" + item.file.filename
        let target = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(name)
        let digest = try await Task.detached(priority: .utility) { () throws -> String in
            try coordinatedCopy(from: url, to: target, expectedBytes: item.file.bytes, expectedChecksum: source.checksum)
            do { return try fileDigest(target) } catch { try? FileManager.default.removeItem(at: target); throw error }
        }.value
        try DeviceLibrary.shared.setChecksum(locationID: source.id, checksum: digest)
        try DeviceLibrary.shared.upsert(item.file, location: EpisodeLocation(id: "phone:\(name)", kind: "phone", label: "On iPhone", localName: name, checksum: digest))
        return ["count": 1]
    }
    func exportEpisode(_ episodeID: String) async throws -> [String: Any] {
        let item = try DeviceLibrary.shared.episode(episodeID)
        guard let source = item.locations.first(where: { $0.kind != "pc" && DeviceLibrary.shared.available($0) }) else { throw HubError.message("No accessible saved copy.") }
        guard let folder = try await pick(types: [.folder]).first, beginFolderAccess(folder) else { throw HubError.message("Choose a writable folder.") }
        defer { folder.stopAccessingSecurityScopedResource() }
        let drive = try DeviceLibrary.shared.addDrive(folder)
        let relative = safeFilename(item.file.series) + "/" + safeFilename(item.file.season) + "/" + safeFilename(item.file.filename)
        let target = folder.appendingPathComponent(relative)
        let (url, root) = try DeviceLibrary.shared.localURL(source); defer { root?.stopAccessingSecurityScopedResource() }
        if url.standardizedFileURL == target.standardizedFileURL { throw HubError.message("This file is already at that destination.") }
        let digest = try await Task.detached(priority: .utility) { () throws -> String in
            try coordinatedCopy(from: url, to: target, expectedBytes: item.file.bytes, expectedChecksum: source.checksum)
            return try fileDigest(target)
        }.value
        try DeviceLibrary.shared.setChecksum(locationID: source.id, checksum: digest)
        try DeviceLibrary.shared.upsert(item.file, location: EpisodeLocation(id: "drive:\(drive.id):\(relative)", kind: "drive", label: "On SSD · \(drive.name)", driveID: drive.id, relativePath: relative, checksum: digest))
        return ["exported": true]
    }
}

func safeFilename(_ name: String) -> String {
    let value = name.components(separatedBy: CharacterSet(charactersIn: "/\\:\0")).joined(separator: "_")
    return value.isEmpty || [".", ".."].contains(value) ? "Unsorted" : value
}
func inferredEpisode(_ url: URL, relative: String, folderName: String, bytes: Int64) -> LibraryFile {
    let parts = relative.split(separator: "/").map(String.init)
    let season = parts.dropLast().first(where: { $0.range(of: "^(S[0-9]+|Season[ ._-]*[0-9]+)$", options: [.regularExpression, .caseInsensitive]) != nil }) ?? "Unsorted"
    let series = parts.count > 1 && parts.first != season ? parts[0] : folderName
    let filename = url.lastPathComponent
    let expression = try? NSRegularExpression(pattern: "(?:S[0-9]+)?(?:Episode|EP|E)[ ._-]*([0-9]+(?:\\.[0-9]+)?)", options: .caseInsensitive)
    let match = expression?.firstMatch(in: filename, range: NSRange(filename.startIndex..., in: filename))
    let episode = match.flatMap { Range($0.range(at: 1), in: filename) }.flatMap { Double(filename[$0]) }
    return LibraryFile(id: UUID().uuidString, series: series, title: series, season: season, episode: episode, filename: filename, bytes: bytes, quality: nil, completedAt: nil)
}
func coordinatedCopy(from source: URL, to target: URL, expectedBytes: Int64? = nil, expectedChecksum: String? = nil) throws {
    try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
    var coordinationError: NSError?, operationError: Error?
    NSFileCoordinator().coordinate(readingItemAt: source, options: [], writingItemAt: target, options: .forReplacing, error: &coordinationError) { source, target in
        do {
            guard !FileManager.default.fileExists(atPath: target.path) else { throw HubError.message("A file with that name already exists at the destination.") }
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            let temporary = target.deletingLastPathComponent().appendingPathComponent("." + UUID().uuidString + ".copying")
            defer { try? FileManager.default.removeItem(at: temporary) }
            try FileManager.default.copyItem(at: source, to: temporary)
            let sourceDigest = try fileDigest(source), targetDigest = try fileDigest(temporary)
            guard sourceDigest == targetDigest, expectedChecksum == nil || sourceDigest == expectedChecksum else { throw HubError.message("Copy verification failed. The source may have changed.") }
            if let expectedBytes {
                let bytes = (try temporary.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
                guard Int64(bytes) == expectedBytes else { throw HubError.message("The source size changed. Rescan the folder before copying.") }
            }
            try FileManager.default.moveItem(at: temporary, to: target)
        } catch { operationError = error }
    }
    if let error = operationError ?? coordinationError { throw error }
}
