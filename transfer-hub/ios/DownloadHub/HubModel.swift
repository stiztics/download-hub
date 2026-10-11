import Foundation
import Combine

@MainActor final class HubModel: ObservableObject {
    @Published var credentials: Credentials?
    @Published var files: [LibraryFile] = []
    @Published var queue: [QueueEntry] = []
    @Published var online = false
    @Published var busy = false
    @Published var message: String?
    @Published var selection: Set<String> = []
    @Published private(set) var demo = false
    init() {
        credentials = Keychain.read()
        if let credentials { TransferManager.shared.connect(credentials) }
    }
    func pair(serverText: String, code: String) async {
        busy = true; defer { busy = false }
        do {
            guard var components = URLComponents(string: serverText.trimmingCharacters(in: .whitespacesAndNewlines)), Self.allowedAddress(components), components.host != nil, components.user == nil, components.password == nil, components.query == nil, components.fragment == nil, ["", "/"].contains(components.path) else { throw HubError.message("Enter your PC's HTTPS address, such as https://your-pc.your-network.ts.net.") }
            components.path = ""
            guard let server = components.url else { throw HubError.message("Invalid PC address.") }
            guard code.count == 8, code.allSatisfy(\.isNumber) else { throw HubError.message("Enter the eight-digit pairing code shown on the PC.") }
            let temporary = Credentials(server: server, token: "")
            let response: PairResponse = try await HubAPI(credentials: temporary).send("pair", method: "POST", body: JSONSerialization.data(withJSONObject: ["code": code, "name": "iPhone 15 Pro", "client": "ios"]))
            let credentials = Credentials(server: server, token: response.token)
            try Keychain.save(credentials)
            self.credentials = credentials
            TransferManager.shared.connect(credentials)
            await refresh()
        } catch { message = error.localizedDescription }
    }
    func refresh() async {
        if demo { return }
        guard let credentials else { return }
        do {
            let api = HubAPI(credentials: credentials)
            async let library: LibraryResponse = api.send("library")
            async let pickup: [QueueEntry] = api.send("queue")
            let results = try await (library, pickup)
            files = results.0.files; queue = results.1; online = true
            selection.formIntersection(Set(files.map(\.id)))
        } catch { online = false; message = error.localizedDescription }
    }
    func addSelection() async {
        guard let credentials, !selection.isEmpty else { return }
        #if HUB_TESTING && targetEnvironment(simulator)
        if demo {
            for file in files where selection.contains(file.id) && !queue.contains(where: { $0.fileId == file.id }) {
                queue.append(QueueEntry(id: file.id, fileId: file.id, filename: file.filename, series: file.series, title: file.title, bytes: file.bytes, status: "queued", bytesCompleted: 0, error: nil, queuedAt: "", updatedAt: ""))
            }
            selection.removeAll(); return
        }
        #endif
        busy = true; defer { busy = false }
        do {
            queue = try await HubAPI(credentials: credentials).send("queue", method: "POST", body: JSONSerialization.data(withJSONObject: ["fileIds": Array(selection)]))
            selection.removeAll()
        } catch { message = error.localizedDescription }
    }
    func removeQueue(_ id: String) async {
        guard let credentials else { return }
        do {
            struct Removed: Decodable { let removed: Bool }
            let _: Removed = try await HubAPI(credentials: credentials).send("queue/" + id, method: "DELETE")
            await refresh()
        } catch { message = error.localizedDescription }
    }
    private static func allowedAddress(_ components: URLComponents) -> Bool {
        if components.scheme?.lowercased() == "https" { return true }
        #if HUB_TESTING && targetEnvironment(simulator)
        return components.scheme?.lowercased() == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(components.host?.lowercased() ?? "")
        #else
        return false
        #endif
    }
    #if HUB_TESTING && targetEnvironment(simulator)
    func openDemo() {
        TransferManager.shared.disconnect()
        demo = true; online = false; queue = []; selection.removeAll()
        credentials = Credentials(server: URL(string: "https://demo.invalid")!, token: "")
        files = (1...2).map { episode in
            LibraryFile(id: "demo-\(episode)", series: "Demo Series", title: "Test Season", season: "S01", episode: Double(episode), filename: "Demo Episode \(episode).bin", bytes: 2_097_152, quality: nil, completedAt: nil)
        }
    }
    #endif
    func disconnect() { TransferManager.shared.disconnect(); Keychain.remove(); demo = false; credentials = nil; files = []; queue = []; online = false; selection.removeAll() }
}
