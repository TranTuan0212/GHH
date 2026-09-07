import Foundation
import CoreLocation

/// LocationManager quản lý thu thập định vị GPS của thiết bị di động
/// và gửi liên tục về Server trong suốt quá trình phát Live Stream (Requirement 8a).
public class LocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    public static let shared = LocationManager()
    private let locationManager = CLLocationManager()
    
    @Published public var lastKnownLocation: CLLocationCoordinate2D?
    @Published public var authorizationStatus: CLAuthorizationStatus = .notDetermined

    private var timer: Timer?
    public var onGpsUpdated: ((Double, Double) -> Void)?

    private override init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        locationManager.allowsBackgroundLocationUpdates = true
        locationManager.pausesLocationUpdatesAutomatically = false
    }

    public func requestPermissions() {
        locationManager.requestAlwaysAuthorization()
    }

    public func startTracking() {
        locationManager.startUpdatingLocation()
        timer?.invalidate()
        // Gửi tọa độ GPS về Server mỗi 5 giây
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            guard let self = self, let loc = self.lastKnownLocation else { return }
            self.onGpsUpdated?(loc.latitude, loc.longitude)
        }
    }

    public func stopTracking() {
        locationManager.stopUpdatingLocation()
        timer?.invalidate()
        timer = nil
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        DispatchQueue.main.async {
            self.lastKnownLocation = location.coordinate
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        DispatchQueue.main.async {
            self.authorizationStatus = manager.authorizationStatus
        }
    }
}
