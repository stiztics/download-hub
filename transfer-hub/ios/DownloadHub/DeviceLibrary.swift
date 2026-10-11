import Foundation
import CryptoKit

struct EpisodeLocation: Codable, Identifiable {
    var id: String
    var kind: String
    var label: String
    var localName: String?
    var driveID: String?
    var relativePath: String?
    var server: URL?
    var fileID: String?
    var checksum: String?
    var present: Bool = true
    var fingerprint: String? = nil
}
struct DeviceEpisode: Codable, Identifiable {
    var id: String
    var file: LibraryFile
    var locations: [EpisodeLocation]
    var position: Double = 0
    var organized: Bool? = nil
}
struct LibraryDrive: Codable, Identifiable {
    var id: String
    var name: String
    var bookmark: Data
}
struct DeviceLibraryState: Codable {
    var version = 1
    var episodes: [DeviceEpisode] = []
    var drives: [LibraryDrive] = []
    var requests: [PendingPCRequest]? = nil
}
struct PendingPCRequest: Codable, Identifiable {
    var id: String
    var sourceID: String
    var server: URL
    var destination: String
    var copyWhenReady: Bool
}

// The catalog belongs to the phone. Paths and bookmarks never cross the bridge.
@MainActor final class DeviceLibrary {
    static let shared = DeviceLibrary()
    private(set) var state = DeviceLibraryState()
    private var loadError: String?
    private let stateURL: URL
    private var documents: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }
    private init() {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        stateURL = root.appendingPathComponent("device-library.json")
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: stateURL.path) {
                state = try JSONDecoder().decode(DeviceLibraryState.self, from: Data(contentsOf: stateURL))
                guard state.version == 1 else { throw HubError.message("Unknown library version.") }
            }
        } catch { loadError = "The saved library could not be read. Your files have been preserved. \(error.localizedDescription)" }
    }
    func save() throws {
        if let loadError { throw HubError.message(loadError) }
        try JSONEncoder().encode(state).write(to: stateURL, options: .atomic)
    }
    func episode(_ id: String) throws -> DeviceEpisode {
        guard let item = state.episodes.first(where: { $0.id == id }) else { throw HubError.message("Episode not found.") }
        return item
    }
    func upsert(_ file: LibraryFile, location: EpisodeLocation, persist: Bool = true) throws {
        if let index = state.episodes.firstIndex(where: { $0.locations.contains { $0.id == location.id } }), state.episodes[index].locations.count > 1,
           let old = state.episodes[index].locations.first(where: { $0.id == location.id }),
           (state.episodes[index].file.bytes != file.bytes || (old.fingerprint != nil && location.fingerprint != nil && old.fingerprint != location.fingerprint)) {
            state.episodes[index].locations.removeAll { $0.id == location.id }
        }
        if let index = state.episodes.firstIndex(where: { $0.locations.contains(where: { $0.id == location.id }) }) {
            let slot = state.episodes[index].locations.firstIndex(where: { $0.id == location.id })!
            state.episodes[index].locations[slot] = location
            if location.kind == "pc" && state.episodes[index].organized != true { state.episodes[index].file = file }
        } else if let checksum = location.checksum, let index = state.episodes.firstIndex(where: {
            $0.file.bytes == file.bytes && $0.locations.contains(where: { $0.checksum == checksum })
        }) {
            state.episodes[index].locations.append(location)
        } else {
            state.episodes.append(DeviceEpisode(id: UUID().uuidString, file: file, locations: [location]))
        }
        // Merge only verified equal content, never filenames alone.
        if let checksum = location.checksum {
            let matching = state.episodes.filter { $0.file.bytes == file.bytes && $0.locations.contains { $0.checksum == checksum } }
            if let first = matching.first, matching.count > 1, let index = state.episodes.firstIndex(where: { $0.id == first.id }) {
                for item in matching.dropFirst() {
                    if item.organized == true && state.episodes[index].organized != true { state.episodes[index].file = item.file; state.episodes[index].organized = true }
                    for source in item.locations where !state.episodes[index].locations.contains(where: { $0.id == source.id }) { state.episodes[index].locations.append(source) }
                    state.episodes[index].position = max(state.episodes[index].position, item.position)
                }
                let remove = Set(matching.dropFirst().map(\.id))
                state.episodes.removeAll { remove.contains($0.id) }
            }
        }
        if persist { try save() }
    }
    func synchronize(_ files: [LibraryFile], server: URL) throws {
        for index in state.episodes.indices {
            for slot in state.episodes[index].locations.indices where state.episodes[index].locations[slot].server == server {
                state.episodes[index].locations[slot].present = false
            }
        }
        for file in files {
            if let source = file.sourceId, let index = state.episodes.firstIndex(where: { $0.locations.contains { $0.kind == "pending" && $0.server == server && $0.fileID == source } }) {
                state.episodes[index].locations.removeAll { $0.kind == "pending" }
                if state.episodes[index].organized != true { state.episodes[index].file = file }
                state.episodes[index].locations.append(EpisodeLocation(id: "pc:\(server.absoluteString):\(file.id)", kind: "pc", label: "On PC", server: server, fileID: file.id, fingerprint: file.fingerprint))
            } else {
                try upsert(file, location: EpisodeLocation(id: "pc:\(server.absoluteString):\(file.id)", kind: "pc", label: "On PC", server: server, fileID: file.id, fingerprint: file.fingerprint), persist: false)
            }
        }
        try save()
    }
    func recoverTransfers() throws {
        for row in TransferManager.shared.transfers where row.status == "downloaded" {
            guard let name = row.localName, TransferManager.shared.fileURL(row) != nil else { continue }
            if state.episodes.contains(where: { $0.locations.contains { $0.localName == name && $0.checksum == row.verifiedSHA256 } }) { continue }
            let sourceID = "pc:\(row.server.absoluteString):\(row.entry.fileId)"
            let known = state.episodes.first(where: { $0.locations.contains { $0.id == sourceID } })?.file
            let file = LibraryFile(id: row.entry.fileId, series: row.entry.series, title: row.entry.title, season: known?.season ?? "Unsorted", episode: known?.episode, filename: row.entry.filename, bytes: row.entry.bytes, quality: known?.quality, completedAt: known?.completedAt, sourceId: known?.sourceId, fingerprint: row.entry.fingerprint)
            if let digest = row.verifiedSHA256 { try setChecksum(locationID: sourceID, checksum: digest, fingerprint: row.entry.fingerprint) }
            try upsert(file, location: EpisodeLocation(id: "phone:\(name)", kind: "phone", label: "On iPhone", localName: name, checksum: row.verifiedSHA256))
        }
    }
    func reconcileTransfers(_ files: [LibraryFile], credentials: Credentials) async throws {
        for row in TransferManager.shared.transfers where row.status == "downloaded" && row.server == credentials.server {
            guard let name = row.localName, let digest = row.verifiedSHA256, TransferManager.shared.fileURL(row) != nil,
                  let file = files.first(where: { $0.id == row.entry.fileId }), file.bytes == row.entry.bytes else { continue }
            let sourceID = "pc:\(credentials.server.absoluteString):\(file.id)"
            if state.episodes.contains(where: { $0.locations.contains { $0.id == sourceID } && $0.locations.contains { $0.localName == name } }) { continue }
            // Older transfers have no file version. Compare actual remote content
            // before attaching them to today's PC entry.
            if row.entry.fingerprint != file.fingerprint || row.entry.fingerprint == nil {
                guard let result: ChecksumResponse = try? await HubAPI(credentials: credentials).send("files/\(file.id)/checksum"), result.sha256 == digest else { continue }
            }
            try setChecksum(locationID: sourceID, checksum: digest, fingerprint: file.fingerprint)
            if let index = state.episodes.firstIndex(where: { $0.locations.contains { $0.localName == name } }), state.episodes[index].organized != true { state.episodes[index].file = file }
            try upsert(file, location: EpisodeLocation(id: "phone:\(name)", kind: "phone", label: "On iPhone", localName: name, checksum: digest))
        }
    }
    func setChecksum(locationID: String, checksum: String, fingerprint: String? = nil) throws {
        for index in state.episodes.indices {
            if let slot = state.episodes[index].locations.firstIndex(where: { $0.id == locationID }), state.episodes[index].locations[slot].kind != "pc" || (fingerprint != nil && fingerprint == state.episodes[index].locations[slot].fingerprint) { state.episodes[index].locations[slot].checksum = checksum }
        }
        try save()
    }
    func setPosition(_ id: String, seconds: Double) throws {
        guard seconds.isFinite, seconds >= 0, let index = state.episodes.firstIndex(where: { $0.id == id }) else { return }
        state.episodes[index].position = seconds
        try save()
    }
    func organize(_ id: String, series: String, season: String, episode: Double?) throws {
        guard !series.isEmpty, series.count <= 150, !season.isEmpty, season.count <= 100,
              episode == nil || (episode!.isFinite && episode! >= 0),
              let index = state.episodes.firstIndex(where: { $0.id == id }) else { throw HubError.message("Enter a series, season, and valid episode number.") }
        let file = state.episodes[index].file
        state.episodes[index].file = LibraryFile(id: file.id, series: series, title: series, season: season, episode: episode, filename: file.filename, bytes: file.bytes, quality: file.quality, completedAt: file.completedAt, sourceId: file.sourceId, fingerprint: file.fingerprint)
        state.episodes[index].organized = true; try save()
    }
    func requestPC(title: FetcherTitleResponse, episodeIDs: [String], series: String, server: URL, destination: String, copyWhenReady: Bool) throws {
        if state.requests == nil { state.requests = [] }
        for episode in title.episodes where episodeIDs.contains(episode.id) {
            let sourceID = title.id + "/" + episode.id
            if state.requests!.contains(where: { $0.sourceID == sourceID && $0.server == server && $0.destination == destination }) { continue }
            let number: Double?
            switch episode.number { case .number(let value): number = value; case .text(let value): number = Double(value) }
            let file = LibraryFile(id: "pending:" + sourceID, series: series, title: title.title, season: "Pending downloads", episode: number, filename: "Episode \(number?.description ?? episode.id)", bytes: 0, quality: nil, completedAt: nil, sourceId: sourceID)
            state.requests!.append(PendingPCRequest(id: UUID().uuidString, sourceID: sourceID, server: server, destination: destination, copyWhenReady: copyWhenReady))
            if !state.episodes.contains(where: { $0.file.sourceId == sourceID && $0.locations.contains { $0.server == server } }) {
                try upsert(file, location: EpisodeLocation(id: "pending:\(server.absoluteString):\(sourceID)", kind: "pending", label: "Downloading on PC", server: server, fileID: sourceID, present: false), persist: false)
            }
        }
        try save()
    }
    func readyRequests(_ files: [LibraryFile], server: URL) -> [(PendingPCRequest, DeviceEpisode, EpisodeLocation)] {
        (state.requests ?? []).filter { $0.server == server }.compactMap { request in
            guard let file = files.first(where: { $0.sourceId == request.sourceID }),
                  let episode = state.episodes.first(where: { $0.locations.contains { $0.kind == "pc" && $0.server == server && $0.fileID == file.id } }),
                  let source = episode.locations.first(where: { $0.kind == "pc" && $0.server == server && $0.fileID == file.id }) else { return nil }
            return (request, episode, source)
        }
    }
    func finishRequest(_ id: String) throws { state.requests?.removeAll { $0.id == id }; try save() }
    func addDrive(_ url: URL) throws -> LibraryDrive {
        let bookmark = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
        if let existing = state.drives.first(where: { (try? resolveDrive($0.id).standardizedFileURL) == url.standardizedFileURL }) { return existing }
        let drive = LibraryDrive(id: UUID().uuidString, name: url.lastPathComponent, bookmark: bookmark)
        state.drives.append(drive); try save(); return drive
    }
    func resolveDrive(_ id: String) throws -> URL {
        guard let index = state.drives.firstIndex(where: { $0.id == id }) else { throw HubError.message("Choose an external folder first.") }
        var stale = false
        let url = try URL(resolvingBookmarkData: state.drives[index].bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        if stale, beginFolderAccess(url) {
            defer { url.stopAccessingSecurityScopedResource() }
            state.drives[index].bookmark = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
            try save()
        }
        return url
    }
    func available(_ location: EpisodeLocation) -> Bool {
        if location.kind == "pc" { return location.present }
        if let name = location.localName { return FileManager.default.fileExists(atPath: documents.appendingPathComponent(name).path) }
        guard let drive = location.driveID, let relative = location.relativePath, let root = try? resolveDrive(drive) else { return false }
        guard beginFolderAccess(root) else { return false }
        defer { root.stopAccessingSecurityScopedResource() }
        return FileManager.default.fileExists(atPath: root.appendingPathComponent(relative).path)
    }
    func driveList() -> [[String: Any]] {
        state.drives.map { drive in
            var online = false
            if let root = try? resolveDrive(drive.id), beginFolderAccess(root) {
                online = FileManager.default.fileExists(atPath: root.path); root.stopAccessingSecurityScopedResource()
            }
            return ["id": drive.id, "name": drive.name, "available": online]
        }
    }
    func snapshot() throws -> [[String: Any]] {
        if let loadError { throw HubError.message(loadError) }
        try recoverTransfers()
        return state.episodes.map { item in
            let locations = item.locations.map { source -> [String: Any] in
                ["id": source.id, "kind": source.kind, "label": source.label, "available": available(source)]
            }
            return ["id": item.id, "series": item.file.series, "title": item.file.title, "season": item.file.season, "episode": item.file.episode as Any? ?? NSNull(), "filename": item.file.filename, "bytes": item.file.bytes, "position": item.position, "locations": locations]
        }
    }
    func localURL(_ source: EpisodeLocation) throws -> (URL, URL?) {
        if let name = source.localName { return (documents.appendingPathComponent(name), nil) }
        guard let id = source.driveID, let relative = source.relativePath, !relative.split(separator: "/").contains("..") else { throw HubError.message("File location is unavailable.") }
        let root = try resolveDrive(id)
        guard beginFolderAccess(root) else { throw HubError.message("Reconnect the drive or add its folder again.") }
        let url = root.appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else { root.stopAccessingSecurityScopedResource(); throw HubError.message("Reconnect the drive or rescan its folder.") }
        return (url, root)
    }
    func removePhoneCopy(_ episodeID: String) throws {
        let item = try episode(episodeID)
        for source in item.locations where source.kind == "phone" {
            guard let name = source.localName else { continue }
            let url = documents.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            for row in TransferManager.shared.transfers where row.localName == name { TransferManager.shared.remove(row.id) }
        }
        if let index = state.episodes.firstIndex(where: { $0.id == episodeID }) { state.episodes[index].locations.removeAll { $0.kind == "phone" } }
        try save()
    }
}

func beginFolderAccess(_ url: URL) -> Bool {
    if url.startAccessingSecurityScopedResource() { return true }
    // A folder inside this app's own container already has sandbox access.
    return url.standardizedFileURL.path.hasPrefix(URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.path + "/")
}

func fileDigest(_ url: URL) throws -> String {
    let input = try FileHandle(forReadingFrom: url); defer { try? input.close() }
    var hash = SHA256()
    while let data = try input.read(upToCount: 1024 * 1024), !data.isEmpty { try Task.checkCancellation(); hash.update(data: data) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}
