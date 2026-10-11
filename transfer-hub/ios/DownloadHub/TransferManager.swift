import Foundation
import Combine
import CryptoKit

struct LocalTransfer: Codable, Identifiable {
    let id: String
    let entry: QueueEntry
    let server: URL
    var status: String
    var received: Int64
    var localName: String?
    var error: String?
    var verifiedSHA256: String?
    var expectedSHA256: String?
    var progress: Double { entry.bytes > 0 ? Double(received) / Double(entry.bytes) : 0 }
}

// All state mutations are serialized on the main queue. Delegate callbacks move
// temporary files synchronously before handing UI updates back to that queue.
final class TransferManager: NSObject, ObservableObject, URLSessionDownloadDelegate {
    static let shared = TransferManager()
    @Published private(set) var transfers: [LocalTransfer] = []
    private var credentials: Credentials?
    private var lastReport: [String: Date] = [:]
    private var taskIDs: [String: Int] = [:]
    private var pausing: Set<String> = []
    private var backgroundCompletion: (() -> Void)?
    private let maxConcurrent = 2
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: "local.downloadhub.transfers.v1")
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        config.allowsCellularAccess = true
        config.waitsForConnectivity = true
        config.timeoutIntervalForResource = 7 * 24 * 60 * 60
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    private var stateDirectory: URL { FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Transfers", isDirectory: true) }
    private var documents: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }
    private var stateFile: URL { stateDirectory.appendingPathComponent("transfers.json") }
    override private init() {
        super.init()
        try? FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: stateFile), let saved = try? JSONDecoder().decode([LocalTransfer].self, from: data) { transfers = saved }
    }
    func connect(_ credentials: Credentials) {
        self.credentials = credentials
        _ = session
        session.getAllTasks { tasks in
            DispatchQueue.main.async {
                let active = Set(tasks.compactMap(\.taskDescription))
                for task in tasks { if let id = task.taskDescription { self.taskIDs[id] = task.taskIdentifier } }
                for index in self.transfers.indices where self.transfers[index].server == credentials.server {
                    if self.transfers[index].status == "downloading", !active.contains(self.transfers[index].id) {
                        self.transfers[index].status = "paused"
                        self.transfers[index].error = "Transfer was interrupted. Tap Resume."
                    }
                }
                self.persist()
                self.pump()
                // Retry reports that couldn't reach the PC when a transfer completed.
                for transfer in self.transfers where transfer.server == credentials.server && transfer.status == "downloaded" { self.report(transfer, status: "downloaded") }
            }
        }
    }
    func handleBackgroundEvents(completion: @escaping () -> Void) { backgroundCompletion = completion; _ = session }
    func enqueue(_ entries: [QueueEntry]) {
        guard let credentials else { return }
        for entry in entries where entry.status != "downloaded" {
            if let existing = transfers.first(where: { $0.id == entry.id && $0.server == credentials.server }) {
                if ["failed", "paused"].contains(existing.status) { resume(existing.id) }
                continue
            }
            transfers.append(LocalTransfer(id: entry.id, entry: entry, server: credentials.server, status: "queued", received: 0))
        }
        persist(); pump()
    }
    private var preparing = Set<String>()
    func stage(_ entries: [QueueEntry]) {
        guard let credentials else { return }
        for entry in entries {
            if transfers.contains(where: { $0.entry.fileId == entry.fileId && $0.server == credentials.server && !["downloaded", "failed"].contains($0.status) }) { continue }
            transfers.append(LocalTransfer(id: entry.id, entry: entry, server: credentials.server, status: "waiting", received: 0))
        }
        persist()
    }
    func startWaiting() {
        for index in transfers.indices where transfers[index].status == "waiting" { transfers[index].status = "queued" }
        persist(); pump()
    }
    private func pump() {
        guard let credentials else { return }
        let running = transfers.filter { $0.status == "downloading" }.count + preparing.count
        guard running < maxConcurrent else { return }
        let next = transfers.filter { $0.status == "queued" && $0.server == credentials.server && !preparing.contains($0.id) }.prefix(maxConcurrent - running)
        for transfer in next {
            preparing.insert(transfer.id)
            Task { @MainActor in
                do {
                    let checksum: ChecksumResponse = try await HubAPI(credentials: credentials).send("files/\(transfer.entry.fileId)/checksum")
                    guard self.credentials?.server == credentials.server, self.credentials?.token == credentials.token else { self.preparing.remove(transfer.id); self.pump(); return }
                    guard let index = self.transfers.firstIndex(where: { $0.id == transfer.id }), self.transfers[index].status == "queued" else { self.preparing.remove(transfer.id); self.pump(); return }
                    guard checksum.bytes == transfer.entry.bytes else { throw HubError.message("The file changed on your PC. Refresh the library.") }
                    self.transfers[index].expectedSHA256 = checksum.sha256
                    self.preparing.remove(transfer.id)
                    self.start(transfer.id)
                } catch {
                    self.preparing.remove(transfer.id)
                    guard self.credentials?.server == credentials.server, self.credentials?.token == credentials.token else { self.pump(); return }
                    self.fail(transfer.id, error: error.localizedDescription)
                    self.pump()
                }
            }
        }
    }
    private func resumeURL(_ id: String) -> URL { stateDirectory.appendingPathComponent(id + ".resume") }
    private func start(_ id: String) {
        guard let index = transfers.firstIndex(where: { $0.id == id }), let credentials, transfers[index].server == credentials.server else { return }
        let transfer = transfers[index]
        let task: URLSessionDownloadTask
        if let data = try? Data(contentsOf: resumeURL(id)) {
            task = session.downloadTask(withResumeData: data)
            try? FileManager.default.removeItem(at: resumeURL(id))
        } else {
            task = session.downloadTask(with: HubAPI(credentials: credentials).request("files/" + transfer.entry.fileId))
            transfers[index].received = 0
        }
        task.taskDescription = id
        taskIDs[id] = task.taskIdentifier
        transfers[index].status = "downloading"; transfers[index].error = nil
        persist(); report(transfers[index], status: "downloading"); task.resume()
    }
    func pause(_ id: String) {
        guard let index = transfers.firstIndex(where: { $0.id == id }) else { return }
        let taskID = taskIDs.removeValue(forKey: id)
        pausing.insert(id)
        transfers[index].status = "paused"; persist(); report(transfers[index], status: "paused")
        session.getAllTasks { tasks in
            var found = false
            for case let task as URLSessionDownloadTask in tasks where task.taskDescription == id && (taskID == nil || task.taskIdentifier == taskID) {
                found = true
                task.cancel(byProducingResumeData: { data in
                    if let data { try? data.write(to: self.resumeURL(id), options: .atomic) }
                    DispatchQueue.main.async { self.pausing.remove(id); self.pump() }
                })
            }
            if !found { DispatchQueue.main.async { self.pausing.remove(id); self.pump() } }
        }
    }
    func resume(_ id: String) {
        guard !pausing.contains(id), let index = transfers.firstIndex(where: { $0.id == id }), ["paused", "failed"].contains(transfers[index].status) else { return }
        transfers[index].status = "queued"; transfers[index].error = nil
        persist(); report(transfers[index], status: "queued"); pump()
    }
    func fileURL(_ transfer: LocalTransfer) -> URL? {
        guard let name = transfer.localName else { return nil }
        let url = documents.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
    func remove(_ id: String) {
        guard let transfer = transfers.first(where: { $0.id == id }), transfer.status != "downloading" else { return }
        if let file = fileURL(transfer) { try? FileManager.default.removeItem(at: file) }
        try? FileManager.default.removeItem(at: resumeURL(id))
        transfers.removeAll { $0.id == id }; persist()
    }
    func disconnect() {
        for transfer in transfers where transfer.status == "downloading" { pause(transfer.id) }
        for index in transfers.indices where transfers[index].status == "queued" { transfers[index].status = "paused" }
        credentials = nil
        persist()
    }
    private func persist() {
        guard let data = try? JSONEncoder().encode(transfers) else { return }
        do { try data.write(to: stateFile, options: .atomic) } catch { print("Transfer state save failed: \(error.localizedDescription)") }
    }
    private func report(_ transfer: LocalTransfer, status: String) {
        guard transfer.entry.clientOwned != true, let credentials, transfer.server == credentials.server else { return }
        let reportedAt = Int64(Date().timeIntervalSince1970 * 1000)
        Task { try? await HubAPI(credentials: credentials).report(transfer.entry, status: status, bytes: transfer.received, reportedAt: reportedAt, error: transfer.error) }
    }
    private func fail(_ id: String, error: String) {
        guard let index = transfers.firstIndex(where: { $0.id == id }) else { return }
        transfers[index].status = "failed"; transfers[index].error = error
        persist(); report(transfers[index], status: "failed")
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let id = downloadTask.taskDescription else { return }
        DispatchQueue.main.async {
            guard self.taskIDs[id] == downloadTask.taskIdentifier, let index = self.transfers.firstIndex(where: { $0.id == id }), self.transfers[index].status == "downloading" else { return }
            self.transfers[index].received = min(self.transfers[index].entry.bytes, totalBytesWritten)
            if Date().timeIntervalSince(self.lastReport[id] ?? .distantPast) >= 3 { self.lastReport[id] = Date(); self.persist(); self.report(self.transfers[index], status: "downloading") }
        }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let id = downloadTask.taskDescription else { return }
        // Copy the immutable metadata on the main queue, then hash on the delegate queue.
        var transfer: LocalTransfer?
        DispatchQueue.main.sync { transfer = self.transfers.first(where: { $0.id == id && $0.status == "downloading" && (self.taskIDs[id] == nil || self.taskIDs[id] == downloadTask.taskIdentifier) }) }
        guard let transfer else { return }
        do {
            guard let response = downloadTask.response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw HubError.message("The PC refused the download. Check pairing and retry.") }
            let size = (try FileManager.default.attributesOfItem(atPath: location.path)[.size] as? NSNumber)?.int64Value
            guard size == transfer.entry.bytes else { throw HubError.message("The received file has the wrong size. Retry the transfer.") }
            var hash = SHA256()
            let handle = try FileHandle(forReadingFrom: location)
            defer { try? handle.close() }
            while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty { hash.update(data: chunk) }
            let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
            guard digest == transfer.expectedSHA256 else { throw HubError.message("Checksum verification failed. Retry the transfer.") }
            let filename = id + "_" + (transfer.entry.filename as NSString).lastPathComponent
            let target = documents.appendingPathComponent(filename)
            if FileManager.default.fileExists(atPath: target.path) { throw HubError.message("A saved file already exists for this transfer.") }
            try FileManager.default.moveItem(at: location, to: target)
            DispatchQueue.main.async {
                guard let index = self.transfers.firstIndex(where: { $0.id == id }) else { return }
                self.transfers[index].status = "downloaded"; self.transfers[index].received = transfer.entry.bytes
                self.transfers[index].localName = filename; self.transfers[index].verifiedSHA256 = digest; self.transfers[index].error = nil
                self.persist(); self.report(self.transfers[index], status: "downloaded"); self.pump()
            }
        } catch { DispatchQueue.main.async { self.fail(id, error: error.localizedDescription); self.pump() } }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = task.taskDescription, let error else { return }
        let nsError = error as NSError
        if let data = nsError.userInfo[NSURLSessionDownloadTaskResumeData] as? Data { try? data.write(to: resumeURL(id), options: .atomic) }
        DispatchQueue.main.async {
            guard self.taskIDs[id] == task.taskIdentifier, let transfer = self.transfers.first(where: { $0.id == id }), transfer.status == "downloading" else { return }
            self.fail(id, error: error.localizedDescription); self.pump()
        }
    }
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async { self.backgroundCompletion?(); self.backgroundCompletion = nil }
    }
}
