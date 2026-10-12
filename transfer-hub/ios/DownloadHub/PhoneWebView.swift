import SwiftUI
import WebKit
import Combine
import UIKit

@MainActor struct PhoneWebView: UIViewRepresentable {
    let model: HubModel
    func makeCoordinator() -> PhoneBridge { PhoneBridge(model: model) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(context.coordinator, name: "hub")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = UIColor(red: 0.08, green: 0.10, blue: 0.09, alpha: 1)
        view.scrollView.backgroundColor = view.backgroundColor
        view.navigationDelegate = context.coordinator
        context.coordinator.webView = view
        if let root = Bundle.main.resourceURL?.appendingPathComponent("phone", isDirectory: true) {
            view.loadFileURL(root.appendingPathComponent("index.html"), allowingReadAccessTo: root)
        }
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
    static func dismantleUIView(_ view: WKWebView, coordinator: PhoneBridge) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "hub")
        coordinator.subscription?.cancel()
    }
}

// The page gets only named commands and sanitized metadata. Credentials and
// physical file URLs never leave native code. External navigation is refused.
@MainActor final class PhoneBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let model: HubModel
    weak var webView: WKWebView?
    var subscription: AnyCancellable?
    private let media = LibraryMedia()
    private var titles: [String: FetcherTitleResponse] = [:]
    private var root: URL? { Bundle.main.resourceURL?.appendingPathComponent("phone", isDirectory: true) }
    init(model: HubModel) {
        self.model = model
        super.init()
        #if HUB_TESTING && targetEnvironment(simulator)
        if UserDefaults.standard.bool(forKey: "hubDemo") { model.openDemo() }
        #endif
        subscription = TransferManager.shared.$transfers.dropFirst().sink { [weak self] _ in
            DispatchQueue.main.async { self?.webView?.evaluateJavaScript("window.dispatchEvent(new Event('hub-transfer-update'))", completionHandler: nil) }
        }
    }
    private func trusted(_ url: URL?) -> Bool {
        guard let url, url.isFileURL, let root else { return false }
        return url.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path + "/")
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(trusted(navigationAction.request.url) ? .allow : .cancel)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, trusted(webView?.url), let input = message.body as? [String: Any], let id = input["id"] as? String, id.count <= 40, let method = input["method"] as? String else { return }
        let params = input["params"] as? [String: Any] ?? [:]
        Task { @MainActor in
            do { reply(id, value: try await handle(method, params: params)) }
            catch { reply(id, error: error.localizedDescription) }
        }
    }
    private func reply(_ id: String, value: Any? = nil, error: String? = nil) {
        var output: [String: Any] = ["id": id, "ok": error == nil]
        if let error { output["error"] = error } else { output["value"] = value ?? NSNull() }
        guard let data = try? JSONSerialization.data(withJSONObject: output), let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__hubReply(\(json))", completionHandler: nil)
    }
    private func json<T: Encodable>(_ value: T) throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) }
    private func api() throws -> HubAPI {
        guard let credentials = model.credentials, !model.demo else { throw HubError.message("Connect your PC first.") }
        return HubAPI(credentials: credentials)
    }
    private func connection() -> [String: Any] {
        var value: [String: Any] = ["paired": model.credentials != nil, "server": model.demo ? "Demo library" : model.credentials?.server.absoluteString ?? "", "platform": "ios", "demo": model.demo, "canDemo": false]
        #if HUB_TESTING && targetEnvironment(simulator)
        value["canDemo"] = true
        value["testServer"] = UserDefaults.standard.string(forKey: "hubTestServer") ?? ""
        value["testCode"] = UserDefaults.standard.string(forKey: "hubTestCode") ?? ""
        value["nativeSelfTest"] = UserDefaults.standard.bool(forKey: "hubSelfTest") || UserDefaults.standard.bool(forKey: "hubSelfTestOffline")
        #endif
        return value
    }
    private func transfers() -> [[String: Any]] {
        TransferManager.shared.transfers.map { row in
            ["id": row.id, "fileId": row.entry.fileId, "filename": row.entry.filename, "bytes": row.entry.bytes, "status": row.status, "received": row.received, "error": row.error ?? "", "verifiedSHA256": row.verifiedSHA256 ?? "", "destination": "iPhone", "canExport": TransferManager.shared.fileURL(row) != nil]
        }
    }
    private func transfer(_ params: [String: Any]) throws -> LocalTransfer {
        guard let id = params["id"] as? String, let row = TransferManager.shared.transfers.first(where: { $0.id == id }) else { throw HubError.message("Transfer not found.") }
        return row
    }
    private func handle(_ method: String, params: [String: Any]) async throws -> Any {
        media.presenter = webView?.window?.rootViewController
        if LibraryCopies.shared.active && ["importFiles", "importEpisode", "exportEpisode", "deleteEpisode", "organize", "addFolder", "scanDrive", "delete"].contains(method) { throw HubError.message("Finish or cancel the bulk copy before changing its files.") }
        ExternalDownloads.shared.connect(model.credentials)
        switch method {
        case "connection": return connection()
        case "pair":
            guard let server = params["server"] as? String, let code = params["code"] as? String else { throw HubError.message("Enter a PC address and pairing code.") }
            let previousToken = model.credentials?.token
            model.message = nil
            await model.pair(serverText: server, code: code)
            if let message = model.message, model.credentials?.token == previousToken { throw HubError.message(message) }
            if model.credentials == nil { throw HubError.message(model.message ?? "Pairing failed.") }
            return connection()
        case "library":
            if model.demo { return model.files.map { file in ["id": file.id, "series": file.series, "title": file.title, "season": file.season, "episode": file.episode as Any? ?? NSNull(), "filename": file.filename, "bytes": file.bytes, "locations": [["id": file.id, "kind": "pc", "label": "On PC", "available": true]]] as [String: Any] } }
            return try DeviceLibrary.shared.snapshot()
        case "refreshCatalog":
            guard let credentials = model.credentials, !model.demo else { return ["online": false] }
            do {
                let library: LibraryResponse = try await api().send("library")
                try DeviceLibrary.shared.synchronize(library.files, server: credentials.server)
                try await DeviceLibrary.shared.reconcileTransfers(library.files, credentials: credentials)
                for (request, episode, source) in DeviceLibrary.shared.readyRequests(library.files, server: credentials.server) {
                    if request.copyWhenReady { try stage(episode, source: source, destination: request.destination) }
                    try DeviceLibrary.shared.finishRequest(request.id)
                    if request.copyWhenReady {
                        TransferManager.shared.startWaiting()
                        try ExternalDownloads.shared.start()
                    }
                }
                // Existing desktop pickup requests remain supported, but the app
                // creates its own transfer requests without a server queue round trip.
                let pickup: [QueueEntry] = try await api().send("queue")
                let fresh = pickup.filter { entry in entry.status != "downloaded" && !TransferManager.shared.transfers.contains { $0.id == entry.id } }
                TransferManager.shared.stage(fresh)
                return ["online": true]
            } catch { return ["online": false, "error": error.localizedDescription] }
        case "drives": return DeviceLibrary.shared.driveList()
        case "addFolder": return try await media.addFolder()
        case "scanDrive":
            guard let id = params["id"] as? String else { throw HubError.message("Select a folder.") }
            return ["count": try await media.scan(id)]
        case "importFiles": return try await media.importFiles()
        case "prepareBulk":
            guard let direction = params["direction"] as? String, ["import", "export"].contains(direction), !LibraryCopies.shared.active else { throw HubError.message("Finish the current copy and choose import or export.") }
            guard let folder = try await media.pick(types: [.folder]).first, beginFolderAccess(folder) else { throw HubError.message("Select a connected SSD folder.") }
            defer { folder.stopAccessingSecurityScopedResource() }
            let drive = try DeviceLibrary.shared.addDrive(folder)
            if direction == "import" { _ = try await media.scan(drive.id); return try LibraryCopies.shared.prepareImport(drive.id) }
            return try LibraryCopies.shared.prepareExport(drive.id)
        case "startBulk":
            guard let id = params["id"] as? String else { throw HubError.message("Choose a copy folder first.") }
            try LibraryCopies.shared.start(id, removeOriginals: params["removeOriginals"] as? Bool ?? false)
            return LibraryCopies.shared.snapshot()
        case "replanBulk":
            guard let id = params["id"] as? String, let plan = LibraryCopies.shared.batch, plan.id == id, plan.status == "ready", plan.direction == "import" else { throw HubError.message("Choose an import folder first.") }
            return try LibraryCopies.shared.prepareImport(plan.driveID, includeImported: params["removeOriginals"] as? Bool ?? false)
        case "bulkStatus": return LibraryCopies.shared.snapshot()
        case "cancelBulk": LibraryCopies.shared.cancel(); return LibraryCopies.shared.snapshot()
        case "retryBulk": try LibraryCopies.shared.retry(); return LibraryCopies.shared.snapshot()
        case "organize":
            guard let id = params["id"] as? String, let series = params["series"] as? String, let season = params["season"] as? String else { throw HubError.message("Choose an episode and its folders.") }
            try DeviceLibrary.shared.organize(id, series: series, season: season, episode: params["episode"] as? Double)
            return ["saved": true]
        case "play", "importEpisode", "exportEpisode", "deleteEpisode":
            guard let id = params["id"] as? String else { throw HubError.message("Select an episode.") }
            if method == "play" {
                guard !(LibraryCopies.shared.active && LibraryCopies.shared.batch?.removeOriginals == true) else { throw HubError.message("Finish or cancel the move before playing its files.") }
                return try await media.play(id)
            }
            if method == "importEpisode" { return try await media.importEpisode(id) }
            if method == "exportEpisode" { return try await media.exportEpisode(id) }
            try DeviceLibrary.shared.removePhoneCopy(id); return ["deleted": true]
        case "queue":
            if model.demo { return try json(model.queue) }
            return transfers() + ExternalDownloads.shared.snapshot()
        case "addQueue":
            guard let ids = params["fileIds"] as? [String], !ids.isEmpty, ids.count <= 500 else { throw HubError.message("Select files to queue.") }
            if model.demo { model.selection = Set(ids); await model.addSelection(); return try json(model.queue) }
            guard let credentials = model.credentials else { throw HubError.message("Pair your PC in Settings before transferring.") }
            let destination = params["destination"] as? String ?? "phone"
            for id in ids {
                let episode = try DeviceLibrary.shared.episode(id)
                guard let source = episode.locations.first(where: { $0.kind == "pc" && $0.server == credentials.server }), let fileID = source.fileID else { throw HubError.message("This episode has no copy on the connected PC.") }
                _ = fileID
                try stage(episode, source: source, destination: destination)
            }
            return transfers() + ExternalDownloads.shared.snapshot()
        case "transfers": return transfers() + ExternalDownloads.shared.snapshot()
        case "fetcherStatus":
            let status: FetcherStatusResponse = try await api().send("download-jobs")
            return try json(status)
        case "fetcherSearch":
            guard let query = params["query"] as? String, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, query.count <= 200, let page = params["page"] as? Int, (1...1000).contains(page) else { throw HubError.message("Enter an anime name and a valid search page.") }
            let response: FetcherSearchResponse = try await api().send("fetcher/search", query: [URLQueryItem(name: "q", value: query), URLQueryItem(name: "page", value: String(page))], timeout: 240)
            return try json(response)
        case "fetcherTitle":
            guard let id = params["id"] as? String, id.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil else { throw HubError.message("Invalid title.") }
            let response: FetcherTitleResponse = try await api().send("fetcher/titles/" + id, timeout: 240)
            titles[id] = response
            return try json(response)
        case "fetcherAdd":
            guard let titleId = params["titleId"] as? String, titleId.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil, let episodeIds = params["episodeIds"] as? [String], !episodeIds.isEmpty, episodeIds.count <= 2000, episodeIds.allSatisfy({ $0.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil }), let series = params["series"] as? String, !series.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, series.count <= 150 else { throw HubError.message("Select episodes and enter a collection folder name.") }
            let response: FetcherAddResponse = try await api().send("download-jobs", method: "POST", body: JSONSerialization.data(withJSONObject: ["titleId": titleId, "episodeIds": episodeIds, "series": series]), timeout: 240)
            if let title = titles[titleId], let credentials = model.credentials {
                try DeviceLibrary.shared.requestPC(title: title, episodeIDs: episodeIds, series: series, server: credentials.server, destination: params["destination"] as? String ?? "phone", copyWhenReady: params["copyWhenReady"] as? Bool ?? true)
            }
            return try json(response)
        case "fetcherControl":
            guard let action = params["action"] as? String, ["pause", "resume", "cancel", "retry", "prioritize"].contains(action) else { throw HubError.message("Invalid PC queue action.") }
            var input: [String: Any] = ["action": action]
            if ["cancel", "retry", "prioritize"].contains(action) {
                guard let id = params["id"] as? String, id.range(of: "^[a-f0-9]{24}$", options: .regularExpression) != nil else { throw HubError.message("Invalid PC download job.") }
                input["id"] = id
            }
            let response: FetcherStatusResponse = try await api().send("download-jobs/control", method: "POST", body: JSONSerialization.data(withJSONObject: input), timeout: 240)
            return try json(response)
        case "start":
            if model.demo { throw HubError.message("Demo — file transfers unavailable") }
            guard model.credentials != nil else { throw HubError.message("Pair your PC before transferring.") }
            TransferManager.shared.startWaiting()
            try ExternalDownloads.shared.start()
            return transfers() + ExternalDownloads.shared.snapshot()
        case "pause":
            if let id = params["id"] as? String, ExternalDownloads.shared.jobs.contains(where: { $0.id == id }) { ExternalDownloads.shared.pause(id); return ExternalDownloads.shared.snapshot() }
            let row = try transfer(params)
            guard row.status == "downloading" else { throw HubError.message("This transfer is not downloading.") }
            TransferManager.shared.pause(row.id); return transfers()
        case "resume":
            if let id = params["id"] as? String, ExternalDownloads.shared.jobs.contains(where: { $0.id == id }) { try ExternalDownloads.shared.resume(id); return ExternalDownloads.shared.snapshot() }
            let row = try transfer(params)
            guard ["paused", "failed"].contains(row.status), model.credentials?.server == row.server else { throw HubError.message("Connect the original PC before resuming.") }
            TransferManager.shared.resume(row.id); return transfers()
        case "delete":
            let row = try transfer(params)
            guard row.status == "downloaded" else { throw HubError.message("Only a finished file can be deleted here.") }
            TransferManager.shared.remove(row.id); return transfers()
        case "export":
            let row = try transfer(params)
            guard row.status == "downloaded", let file = TransferManager.shared.fileURL(row), var presenter = webView?.window?.rootViewController else { throw HubError.message("Saved file is unavailable.") }
            while let presented = presenter.presentedViewController { presenter = presented }
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = webView
            sheet.popoverPresentationController?.sourceRect = webView?.bounds ?? .zero
            presenter.present(sheet, animated: true)
            return ["exported": true]
        case "disconnect": ExternalDownloads.shared.disconnect(); model.disconnect(); return connection()
        case "demo":
            #if HUB_TESTING && targetEnvironment(simulator)
            model.openDemo(); return connection()
            #else
            throw HubError.message("Demo is available only in simulator test builds.")
            #endif
        default: throw HubError.message("Unsupported app command.")
        }
    }
    private func stage(_ episode: DeviceEpisode, source: EpisodeLocation, destination: String) throws {
        guard let fileID = source.fileID else { throw HubError.message("PC file is unavailable.") }
        if destination != "phone" { try ExternalDownloads.shared.stage(episode, source: source, driveID: destination); return }
        if episode.locations.contains(where: { $0.kind == "phone" && DeviceLibrary.shared.available($0) }) { return }
        let entry = QueueEntry(id: String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(24)), fileId: fileID, filename: episode.file.filename, series: episode.file.series, title: episode.file.title, bytes: episode.file.bytes, status: "queued", bytesCompleted: 0, error: nil, queuedAt: "", updatedAt: "", clientOwned: true, fingerprint: episode.file.fingerprint)
        TransferManager.shared.stage([entry])
    }
}
