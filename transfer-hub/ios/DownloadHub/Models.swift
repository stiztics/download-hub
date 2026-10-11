import Foundation
import Security

struct LibraryFile: Codable, Identifiable {
    let id: String
    let series: String
    let title: String
    let season: String
    let episode: Double?
    let filename: String
    let bytes: Int64
    let quality: Int?
    let completedAt: String?
    var episodeLabel: String { season == "Movie" ? "Movie" : "Episode \(episode.map { $0.formatted(.number.precision(.fractionLength(0...2))) } ?? "—")" }
}
struct LibraryResponse: Codable { let files: [LibraryFile]; let unavailable: Int; let sourceStatus: String }
struct QueueEntry: Codable, Identifiable {
    let id: String
    let fileId: String
    let filename: String
    let series: String
    let title: String
    let bytes: Int64
    var status: String
    var bytesCompleted: Int64
    let error: String?
    let queuedAt: String
    let updatedAt: String
}
struct PairResponse: Decodable { let token: String }
struct ChecksumResponse: Decodable { let sha256: String; let bytes: Int64 }
struct APIError: Decodable { let error: String }
struct Credentials: Codable { let server: URL; let token: String }

// Only display fields cross the web bridge. Runner tokens, folder paths and
// process details are deliberately excluded from these response models.
enum FetcherScalar: Codable {
    case text(String), number(Double)
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) { self = .text(value) }
        else { self = .number(try container.decode(Double.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self { case .text(let value): try container.encode(value); case .number(let value): try container.encode(value) }
    }
}
struct FetcherSearchItem: Codable {
    let id: String; let title: String; let type: String?
    let year: FetcherScalar?; let episodes: FetcherScalar?
}
struct FetcherSearchResponse: Codable { let items: [FetcherSearchItem]; let page: Int?; let hasMore: Bool }
struct FetcherEpisode: Codable { let id: String; let number: FetcherScalar }
struct FetcherTitleResponse: Codable { let id: String; let title: String; let episodes: [FetcherEpisode] }
struct FetcherBlocked: Codable { let code: String?; let message: String }
struct FetcherJob: Codable {
    let id: String; let title: String; let episode: FetcherScalar; let status: String
    let phase: String?; let bytesReceived: Int64?; let speed: Double?; let error: String?
}
struct FetcherStatusResponse: Codable { let active: Int; let paused: Bool; let blocked: FetcherBlocked?; let jobs: [FetcherJob] }
struct FetcherAddResponse: Codable { let added: Int; let skipped: Int }

enum Keychain {
    private static let service = "local.downloadhub.personal"
    static func read() -> Credentials? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "connection", kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(Credentials.self, from: data)
    }
    static func save(_ credentials: Credentials) throws {
        let data = try JSONEncoder().encode(credentials)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "connection"]
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if update == errSecItemNotFound {
            var item = query; attributes.forEach { item[$0.key] = $0.value }
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw HubError.message("Could not store the connection securely.") }
        } else if update != errSecSuccess { throw HubError.message("Could not update the connection securely.") }
    }
    static func remove() { SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "connection"] as CFDictionary) }
}
enum HubError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let text): return text } }
}
struct HubAPI {
    let credentials: Credentials
    func request(_ route: String, method: String = "GET", body: Data? = nil, query: [URLQueryItem] = [], timeout: TimeInterval = 30) -> URLRequest {
        var components = URLComponents(url: credentials.server.appendingPathComponent("api/" + route), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        let url = components.url!
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer " + credentials.token, forHTTPHeaderField: "Authorization")
        if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = body }
        request.timeoutInterval = timeout
        return request
    }
    func send<T: Decodable>(_ route: String, method: String = "GET", body: Data? = nil, query: [URLQueryItem] = [], timeout: TimeInterval = 30) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request(route, method: method, body: body, query: query, timeout: timeout))
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw HubError.message((try? JSONDecoder().decode(APIError.self, from: data).error) ?? "The PC did not respond. Check its connection and pairing.")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func report(_ entry: QueueEntry, status: String, bytes: Int64, reportedAt: Int64, error: String? = nil) async throws {
        var input: [String: Any] = ["status": status, "bytesCompleted": min(entry.bytes, max(0, bytes)), "reportedAt": reportedAt]
        if let error { input["error"] = error }
        let _: QueueEntry = try await send("queue/" + entry.id, method: "PATCH", body: JSONSerialization.data(withJSONObject: input))
    }
}

func readableBytes(_ bytes: Int64) -> String { ByteCountFormatter.string(fromByteCount: bytes, countStyle: .decimal) }
