import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        TransferManager.shared.handleBackgroundEvents(completion: completionHandler)
    }
}

@main struct DownloadHubApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = HubModel()
    var body: some Scene {
        WindowGroup { PhoneWebView(model: model).preferredColorScheme(.dark).task {
            #if HUB_TESTING && targetEnvironment(simulator)
            if UserDefaults.standard.bool(forKey: "hubSelfTest") || UserDefaults.standard.bool(forKey: "hubSelfTestOffline") { await NativeSelfTest.run(model) }
            #endif
        } }
    }
}
