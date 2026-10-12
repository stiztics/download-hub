import Foundation
import UIKit
import CryptoKit

struct LibraryCopyItem: Codable {
    var file: LibraryFile
    var source: EpisodeLocation
    var targetName: String
    var status = "pending"
    var error: String?
}
struct LibraryCopyBatch: Codable {
    var id = UUID().uuidString
    var direction: String
    var driveID: String
    var items: [LibraryCopyItem]
    var status = "ready"
    var removeOriginals = false
    var error: String?
}

// Only selected video folders and cataloged local files participate. A batch
// survives relaunch; completed items are never repeated by Retry.
@MainActor final class LibraryCopies {
    static let shared = LibraryCopies()
    private(set) var batch: LibraryCopyBatch?
    private var task: Task<Void, Never>?
    private var loadError: String?
    private var interruption: String?
    private var currentBytes: Int64 = 0
    private var phase = ""
    private var started = Date()
    private var currentName = ""
    private let stateURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("library-copies.json")
    var active: Bool { task != nil }
    private var documents: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }
    private init() {
        if FileManager.default.fileExists(atPath: stateURL.path) {
            do {
                batch = try JSONDecoder().decode(LibraryCopyBatch.self, from: Data(contentsOf: stateURL))
                if ["running", "canceling"].contains(batch?.status ?? "") {
                    batch?.status = "interrupted"; batch?.error = "The app closed. Retry continues with unfinished files."
                    for index in batch!.items.indices where batch!.items[index].status == "copying" { batch!.items[index].status = "pending" }
                }
            } catch { loadError = "Copy history could not be read. Your files have been preserved." }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.cancel(reason: "The app entered the background. Keep it open and retry to continue.") }
        }
    }
    private func save() throws {
        if let loadError { throw HubError.message(loadError) }
        if let batch { try JSONEncoder().encode(batch).write(to: stateURL, options: .atomic) }
    }
    func prepareImport(_ driveID: String) throws -> [String: Any] {
        guard !active else { throw HubError.message("Finish or cancel the current copy first.") }
        var items: [LibraryCopyItem] = []
        for episode in DeviceLibrary.shared.state.episodes {
            if episode.locations.contains(where: { $0.kind == "phone" && DeviceLibrary.shared.available($0) }) { continue }
            for source in episode.locations where source.kind == "drive" && source.driveID == driveID && DeviceLibrary.shared.available(source) {
                guard let relative = source.relativePath else { continue }
                items.append(LibraryCopyItem(file: episode.file, source: source, targetName: "Library/" + driveID + "/" + safeRelativePath(relative)))
            }
        }
        batch = LibraryCopyBatch(direction: "import", driveID: driveID, items: items)
        try save(); return snapshot()
    }
    func prepareExport(_ driveID: String, episodeIDs: Set<String>? = nil) throws -> [String: Any] {
        guard !active else { throw HubError.message("Finish or cancel the current copy first.") }
        var items: [LibraryCopyItem] = []
        _ = try DeviceLibrary.shared.snapshot()
        for episode in DeviceLibrary.shared.state.episodes where episodeIDs == nil || episodeIDs!.contains(episode.id) {
            for source in episode.locations where source.kind == "phone" && DeviceLibrary.shared.available(source) {
            let relative = episode.organized != true ? source.relativePath : nil
            let target = relative.map(safeRelativePath) ?? (safeFilename(episode.file.series) + "/" + safeFilename(episode.file.season) + "/" + safeFilename(episode.file.filename))
            items.append(LibraryCopyItem(file: episode.file, source: source, targetName: target))
            }
        }
        batch = LibraryCopyBatch(direction: "export", driveID: driveID, items: items)
        try save(); return snapshot()
    }
    func start(_ id: String, removeOriginals: Bool) throws {
        guard !active, batch?.id == id else { throw HubError.message("Choose a folder and finish the current copy first.") }
        if batch?.status != "ready", batch?.removeOriginals != removeOriginals { throw HubError.message("Retry keeps the original copy/move choice.") }
        batch?.removeOriginals = removeOriginals
        batch?.status = "running"; batch?.error = nil; interruption = nil
        try save()
        UIApplication.shared.isIdleTimerDisabled = true
        task = Task { [weak self] in
            guard let self else { return }
            do { try await self.run() }
            catch {
                self.batch?.status = self.interruption != nil ? "interrupted" : error is CancellationError ? "canceled" : "interrupted"
                self.batch?.error = self.interruption ?? (error is CancellationError ? "Canceled. Completed files are kept; Retry continues with unfinished files." : error.localizedDescription)
            }
            self.phase = ""; self.currentName = ""; self.currentBytes = 0
            try? self.save(); self.task = nil
            UIApplication.shared.isIdleTimerDisabled = ExternalDownloads.shared.active
        }
    }
    func retry() throws { guard let batch else { return }; try start(batch.id, removeOriginals: batch.removeOriginals) }
    func cancel(reason: String? = nil) {
        guard active else { return }
        interruption = reason; batch?.status = "canceling"; task?.cancel(); try? save()
    }
    private func run() async throws {
        guard let initial = batch else { return }
        let root = try DeviceLibrary.shared.resolveDrive(initial.driveID)
        guard beginFolderAccess(root) else { throw HubError.message("Reconnect the selected drive and retry.") }
        defer { root.stopAccessingSecurityScopedResource() }
        guard FileManager.default.fileExists(atPath: root.path) else { throw HubError.message("Reconnect the selected drive and retry.") }
        let targetRoot = initial.direction == "import" ? documents : root
        let required = initial.items.filter { !["copied", "skipped", "moved"].contains($0.status) && !FileManager.default.fileExists(atPath: targetRoot.appendingPathComponent($0.targetName).path) }.reduce(Int64(0)) { $0 + $1.file.bytes }
        if let free = try? targetRoot.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage, free < required {
            throw HubError.message("Not enough destination space for this batch (\(readableBytes(required)) needed).")
        }
        for index in initial.items.indices {
            try Task.checkCancellation()
            if ["copied", "skipped", "moved"].contains(batch!.items[index].status) { continue }
            let item = batch!.items[index]
            let target = targetRoot.appendingPathComponent(item.targetName)
            let source: URL
            let scope: URL?
            do { (source, scope) = try DeviceLibrary.shared.localURL(item.source) }
            catch {
                // Recover an interrupted move whose verified destination was
                // committed before its original was deleted.
                if initial.removeOriginals, let digest = item.source.checksum, FileManager.default.fileExists(atPath: target.path) {
                    let hash = try await Task.detached { try fileDigest(target) }.value
                    if hash == digest { try DeviceLibrary.shared.forgetLocation(item.source.id); batch!.items[index].status = "moved"; try save(); continue }
                }
                batch!.items[index].status = "failed"; batch!.items[index].error = error.localizedDescription; try save()
                if !FileManager.default.fileExists(atPath: root.path) { throw HubError.message("The drive disconnected. Reconnect it and retry.") }
                continue
            }
            defer { scope?.stopAccessingSecurityScopedResource() }
            currentName = item.file.filename; currentBytes = 0; phase = "copying"; started = Date()
            batch!.items[index].status = "copying"; batch!.items[index].error = nil; try save()
            do {
                let worker = Task.detached(priority: .utility) {
                    try verifiedLibraryCopy(from: source, to: target, expectedBytes: item.file.bytes, expectedChecksum: item.source.checksum) { bytes, phase in
                        Task { @MainActor in
                            guard self.task != nil, self.batch?.id == initial.id, self.batch?.status == "running", self.batch?.items[index].status == "copying" else { return }
                            self.currentBytes = bytes; self.phase = phase
                        }
                    }
                }
                let result = try await withTaskCancellationHandler(operation: { try await worker.value }, onCancel: { worker.cancel() })
                try Task.checkCancellation()
                try DeviceLibrary.shared.setChecksum(locationID: item.source.id, checksum: result.checksum)
                if initial.direction == "import" {
                    try DeviceLibrary.shared.upsert(item.file, location: EpisodeLocation(id: "phone:" + item.targetName, kind: "phone", label: "On iPhone", localName: item.targetName, relativePath: item.source.relativePath, checksum: result.checksum))
                } else {
                    let name = DeviceLibrary.shared.state.drives.first(where: { $0.id == initial.driveID })?.name ?? "External folder"
                    try DeviceLibrary.shared.upsert(item.file, location: EpisodeLocation(id: "drive:\(initial.driveID):\(item.targetName)", kind: "drive", label: "On SSD · " + name, driveID: initial.driveID, relativePath: item.targetName, checksum: result.checksum))
                }
                if initial.removeOriginals && source.standardizedFileURL != target.standardizedFileURL {
                    batch!.items[index].source.checksum = result.checksum; batch!.items[index].status = "verified"; try save()
                    let deletion = Task.detached(priority: .utility) { try removeVerifiedOriginal(source, checksum: result.checksum) }
                    try await withTaskCancellationHandler(operation: { try await deletion.value }, onCancel: { deletion.cancel() })
                    try DeviceLibrary.shared.forgetLocation(item.source.id)
                    batch!.items[index].status = "moved"
                } else { batch!.items[index].status = result.existing ? "skipped" : "copied" }
            } catch {
                if error is CancellationError { batch!.items[index].status = "pending"; throw error }
                batch!.items[index].status = "failed"; batch!.items[index].error = error.localizedDescription
                if !FileManager.default.fileExists(atPath: root.path) { throw HubError.message("The drive disconnected. Reconnect it and retry.") }
                let code = (error as NSError).code
                if [NSFileWriteOutOfSpaceError, NSFileWriteNoPermissionError].contains(code) { throw error }
            }
            try save()
        }
        batch?.status = batch!.items.contains { $0.status == "failed" } ? "completed with errors" : "completed"
    }
    func snapshot() -> [String: Any] {
        guard let batch else { return ["status": "idle", "active": false] }
        let done = batch.items.filter { ["copied", "skipped", "moved"].contains($0.status) }
        return ["id": batch.id, "direction": batch.direction, "status": batch.status, "active": active, "removeOriginals": batch.removeOriginals,
                "total": batch.items.count, "completed": done.count, "copied": batch.items.filter { $0.status == "copied" }.count,
                "skipped": batch.items.filter { $0.status == "skipped" }.count, "moved": batch.items.filter { $0.status == "moved" }.count,
                "failed": batch.items.filter { $0.status == "failed" }.count, "bytes": batch.items.reduce(Int64(0)) { $0 + $1.file.bytes },
                "received": done.reduce(Int64(0)) { $0 + $1.file.bytes } + currentBytes, "filename": currentName, "phase": phase,
                "speed": phase == "copying" ? Double(currentBytes) / max(0.01, Date().timeIntervalSince(started)) : 0,
                "error": batch.error ?? "", "errors": batch.items.filter { $0.status == "failed" }.map { ["filename": $0.file.filename, "error": $0.error ?? ""] }]
    }
}

struct VerifiedLibraryCopy { let checksum: String; let existing: Bool }
func safeRelativePath(_ value: String) -> String { value.split(separator: "/").map { safeFilename(String($0)) }.joined(separator: "/") }

// Hash while reading the source, then verify the stored destination. Bounded
// buffers, one final disk flush, and cancellation avoid large temporary RAM use.
func verifiedLibraryCopy(from source: URL, to target: URL, expectedBytes: Int64, expectedChecksum: String?, progress: @escaping @Sendable (Int64, String) -> Void = { _, _ in }) throws -> VerifiedLibraryCopy {
    try Task.checkCancellation()
    try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
    var coordinationError: NSError?, operationError: Error?, result: VerifiedLibraryCopy?
    NSFileCoordinator().coordinate(readingItemAt: source, options: [], writingItemAt: target, options: .forReplacing, error: &coordinationError) { source, target in
        do {
            let before = try source.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            guard Int64(before.fileSize ?? -1) == expectedBytes else { throw HubError.message("The source changed. Rescan its folder before retrying.") }
            if FileManager.default.fileExists(atPath: target.path) {
                progress(0, "checking existing copy")
                let digest = try fileDigest(source)
                guard expectedChecksum == nil || expectedChecksum == digest, try fileDigest(target) == digest else { throw HubError.message("A different file already exists at this destination. It was preserved.") }
                result = VerifiedLibraryCopy(checksum: digest, existing: true); return
            }
            let temporary = target.deletingLastPathComponent().appendingPathComponent("." + UUID().uuidString + ".copying")
            defer { try? FileManager.default.removeItem(at: temporary) }
            guard FileManager.default.createFile(atPath: temporary.path, contents: nil) else { throw HubError.message("Cannot write to this folder.") }
            let input = try FileHandle(forReadingFrom: source), output = try FileHandle(forWritingTo: temporary)
            defer { try? input.close(); try? output.close() }
            var hash = SHA256(), received: Int64 = 0
            while let data = try input.read(upToCount: 4 * 1024 * 1024), !data.isEmpty {
                try Task.checkCancellation(); try output.write(contentsOf: data); hash.update(data: data); received += Int64(data.count); progress(received, "copying")
            }
            try output.synchronize(); try output.close()
            let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
            let after = try source.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            guard received == expectedBytes, before.fileSize == after.fileSize, before.contentModificationDate == after.contentModificationDate, expectedChecksum == nil || expectedChecksum == digest else { throw HubError.message("The source changed during copying. Its original was preserved.") }
            progress(received, "verifying")
            guard try fileDigest(temporary) == digest else { throw HubError.message("Destination verification failed. The original was preserved.") }
            try Task.checkCancellation()
            try FileManager.default.moveItem(at: temporary, to: target)
            result = VerifiedLibraryCopy(checksum: digest, existing: false)
        } catch { operationError = error }
    }
    if let error = operationError ?? coordinationError { throw error }
    guard let result else { throw HubError.message("Copy coordination failed.") }; return result
}
func removeVerifiedOriginal(_ source: URL, checksum: String) throws {
    var coordinationError: NSError?, operationError: Error?
    NSFileCoordinator().coordinate(writingItemAt: source, options: .forDeleting, error: &coordinationError) { source in
        do { guard try fileDigest(source) == checksum else { throw HubError.message("The original changed after copying and was preserved.") }; try Task.checkCancellation(); try FileManager.default.removeItem(at: source) }
        catch { operationError = error }
    }
    if let error = operationError ?? coordinationError { throw error }
}
