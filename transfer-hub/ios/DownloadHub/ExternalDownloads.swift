import Foundation
import UIKit

struct ExternalDownload: Codable, Identifiable {
    var id: String
    var episodeID: String
    var file: LibraryFile
    var server: URL
    var fileID: String
    var driveID: String
    var status = "waiting"
    var received: Int64 = 0
    var checksum: String?
    var etag: String?
    var error: String?
}

// Foreground, bounded range transfers write directly to the selected folder.
// There is no full-sized temporary video in the phone's sandbox.
@MainActor final class ExternalDownloads {
    static let shared = ExternalDownloads()
    private(set) var jobs: [ExternalDownload] = []
    private var tasks: [String: Task<Void, Never>] = [:]
    private var credentials: Credentials?
    private var storageError: String?
    private let stateURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("external-downloads.json")
    private init() {
        if FileManager.default.fileExists(atPath: stateURL.path) {
            do {
                jobs = try JSONDecoder().decode([ExternalDownload].self, from: Data(contentsOf: stateURL))
                for index in jobs.indices where ["downloading", "queued", "verifying"].contains(jobs[index].status) { jobs[index].status = "paused" }
            } catch { storageError = "External transfer history could not be read; files have been preserved." }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.pauseAll() }
        }
    }
    private func save() throws {
        if let storageError { throw HubError.message(storageError) }
        try JSONEncoder().encode(jobs).write(to: stateURL, options: .atomic)
    }
    func stage(_ episode: DeviceEpisode, source: EpisodeLocation, driveID: String) throws {
        if let storageError { throw HubError.message(storageError) }
        guard let server = source.server, let fileID = source.fileID else { throw HubError.message("No PC copy is available.") }
        _ = try DeviceLibrary.shared.resolveDrive(driveID)
        if episode.locations.contains(where: { $0.driveID == driveID && DeviceLibrary.shared.available($0) }) { return }
        if jobs.contains(where: { $0.episodeID == episode.id && $0.driveID == driveID && $0.status != "downloaded" }) { return }
        jobs.append(ExternalDownload(id: UUID().uuidString, episodeID: episode.id, file: episode.file, server: server, fileID: fileID, driveID: driveID))
        try save()
    }
    func connect(_ value: Credentials?) { credentials = value }
    func start() throws {
        guard credentials != nil else { throw HubError.message("Connect the PC before transferring.") }
        for index in jobs.indices where jobs[index].status == "waiting" { jobs[index].status = "queued" }
        try save(); pump()
    }
    func pause(_ id: String) {
        guard let index = jobs.firstIndex(where: { $0.id == id }), ["queued", "downloading", "verifying", "waiting"].contains(jobs[index].status) else { return }
        jobs[index].status = "paused"; tasks[id]?.cancel(); try? save()
    }
    func resume(_ id: String) throws {
        guard let credentials, let index = jobs.firstIndex(where: { $0.id == id }), jobs[index].server == credentials.server, ["paused", "failed"].contains(jobs[index].status) else { throw HubError.message("Connect the original PC and drive before resuming.") }
        guard tasks[id] == nil else { throw HubError.message("The transfer is still pausing. Try again shortly.") }
        jobs[index].status = "queued"; jobs[index].error = nil; try save(); pump()
    }
    func pauseAll() {
        for job in jobs where ["queued", "downloading", "verifying"].contains(job.status) { pause(job.id) }
    }
    func disconnect() { pauseAll(); credentials = nil }
    private func pump() {
        guard let credentials, tasks.isEmpty, UIApplication.shared.applicationState != .background,
              let index = jobs.firstIndex(where: { $0.status == "queued" && $0.server == credentials.server }) else { return }
        let id = jobs[index].id
        jobs[index].status = "downloading"
        UIApplication.shared.isIdleTimerDisabled = true
        tasks[id] = Task { [weak self] in
            guard let self else { return }
            do { try await self.transfer(id, credentials: credentials) }
            catch {
                if let index = self.jobs.firstIndex(where: { $0.id == id }), self.jobs[index].status != "paused" {
                    self.jobs[index].status = "failed"; self.jobs[index].error = error.localizedDescription
                }
                try? self.save()
            }
            self.tasks[id] = nil
            UIApplication.shared.isIdleTimerDisabled = false
            self.pump()
        }
    }
    private func transfer(_ id: String, credentials: Credentials) async throws {
        guard let index = jobs.firstIndex(where: { $0.id == id }) else { return }
        let job = jobs[index], api = HubAPI(credentials: credentials)
        let root = try DeviceLibrary.shared.resolveDrive(job.driveID)
        guard beginFolderAccess(root) else { throw HubError.message("Reconnect the drive or select its folder again.") }
        defer { root.stopAccessingSecurityScopedResource() }
        let partial = root.appendingPathComponent(".download-hub-" + id + ".part")
        let checksum: ChecksumResponse = try await api.send("files/" + job.fileID + "/checksum")
        let (_, headResponse) = try await URLSession.shared.data(for: api.request("files/" + job.fileID, method: "HEAD"))
        guard let head = headResponse as? HTTPURLResponse, head.statusCode == 200,
              checksum.bytes == job.file.bytes, Int64(head.value(forHTTPHeaderField: "Content-Length") ?? "") == job.file.bytes,
              let etag = head.value(forHTTPHeaderField: "ETag") else { throw HubError.message("The source file changed. Refresh the PC library.") }
        try Task.checkCancellation()
        if jobs[index].checksum != nil && (jobs[index].checksum != checksum.sha256 || jobs[index].etag != etag) {
            if FileManager.default.fileExists(atPath: partial.path) { try FileManager.default.removeItem(at: partial) }
        }
        jobs[index].checksum = checksum.sha256; jobs[index].etag = etag
        if !FileManager.default.fileExists(atPath: partial.path) {
            guard FileManager.default.createFile(atPath: partial.path, contents: Data()) else { throw HubError.message("Cannot write to this drive folder.") }
        }
        let size = (try partial.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
        guard Int64(size) <= job.file.bytes else { throw HubError.message("Partial file has an unexpected size. Remove it from the drive before retrying.") }
        jobs[index].received = Int64(size); try save()
        let output = try FileHandle(forWritingTo: partial); defer { try? output.close() }
        try output.seekToEnd()
        while jobs[index].received < job.file.bytes {
            try Task.checkCancellation()
            let start = jobs[index].received, end = min(job.file.bytes - 1, start + 1_048_575)
            var request = api.request("files/" + job.fileID)
            request.setValue("bytes=\(start)-\(end)", forHTTPHeaderField: "Range")
            request.setValue(etag, forHTTPHeaderField: "If-Range")
            let data = try await receiveExternalRange(request, start: start, end: end, total: job.file.bytes)
            try Task.checkCancellation()
            var coordinationError: NSError?, writeError: Error?
            NSFileCoordinator().coordinate(writingItemAt: partial, options: [], error: &coordinationError) { _ in
                do { try output.write(contentsOf: data); try output.synchronize() } catch { writeError = error }
            }
            if let error = writeError ?? coordinationError { throw error }
            jobs[index].received += Int64(data.count); try save()
        }
        jobs[index].status = "verifying"; try save()
        let worker = Task.detached(priority: .utility) { try fileDigest(partial) }
        let digest = try await withTaskCancellationHandler(operation: { try await worker.value }, onCancel: { worker.cancel() })
        try Task.checkCancellation()
        guard digest == checksum.sha256 else {
            try output.close(); try FileManager.default.removeItem(at: partial); jobs[index].received = 0
            throw HubError.message("Checksum verification failed. Retry to download a fresh copy.")
        }
        try output.close()
        let relative = safeFilename(job.file.series) + "/" + safeFilename(job.file.season) + "/" + safeFilename(job.file.filename)
        let target = root.appendingPathComponent(relative)
        guard !FileManager.default.fileExists(atPath: target.path) else { throw HubError.message("The destination already contains this filename. Existing files are preserved.") }
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: partial, to: target)
        let driveName = DeviceLibrary.shared.state.drives.first(where: { $0.id == job.driveID })?.name ?? "External folder"
        try DeviceLibrary.shared.setChecksum(locationID: "pc:\(job.server.absoluteString):\(job.fileID)", checksum: digest, fingerprint: job.file.fingerprint)
        try DeviceLibrary.shared.upsert(job.file, location: EpisodeLocation(id: "drive:\(job.driveID):\(relative)", kind: "drive", label: "On SSD · \(driveName)", driveID: job.driveID, relativePath: relative, checksum: digest))
        jobs[index].status = "downloaded"; jobs[index].error = nil; try save()
    }
    func snapshot() -> [[String: Any]] {
        jobs.map { job in
            let name = DeviceLibrary.shared.state.drives.first(where: { $0.id == job.driveID })?.name ?? "External folder"
            return ["id": job.id, "fileId": job.fileID, "filename": job.file.filename, "bytes": job.file.bytes, "status": job.status, "received": job.received, "error": job.error ?? "", "destination": "SSD · \(name)", "canExport": false]
        }
    }
}

// Byte processing runs on the generic executor, keeping the UI responsive.
private let externalRangeSession: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    return URLSession(configuration: configuration)
}()
func receiveExternalRange(_ request: URLRequest, start: Int64, end: Int64, total: Int64) async throws -> Data {
    let (stream, response) = try await externalRangeSession.bytes(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 206,
          http.value(forHTTPHeaderField: "Content-Range") == "bytes \(start)-\(end)/\(total)" else { throw HubError.message("The PC refused the expected range. Refresh and retry.") }
    var data = Data(); data.reserveCapacity(Int(end - start + 1))
    for try await byte in stream {
        if data.count % 16384 == 0 { try Task.checkCancellation() }
        guard Int64(data.count) < end - start + 1 else { throw HubError.message("The PC sent an oversized range.") }
        data.append(byte)
    }
    guard Int64(data.count) == end - start + 1 else { throw HubError.message("Incomplete range received. Retry the transfer.") }
    return data
}
