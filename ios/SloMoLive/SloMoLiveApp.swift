import SwiftUI

@main
struct SloMoLiveApp: App {
    init() {
        enableSystemGestureDeferral()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
