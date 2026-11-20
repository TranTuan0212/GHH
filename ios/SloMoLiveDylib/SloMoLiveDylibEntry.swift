import SwiftUI
import UIKit

@objc(SloMoLiveDylibEntry)
public final class SloMoLiveDylibEntry: NSObject, UIGestureRecognizerDelegate {
    public static let shared = SloMoLiveDylibEntry()

    private weak var attachedWindow: UIWindow?
    private var tripleTapGesture: UITapGestureRecognizer?
    private weak var hostedVC: UIViewController?
    private var observersInstalled = false

    private override init() {
        super.init()
    }

    @objc public static func bootstrapFromObjC() {
        DispatchQueue.main.async {
            shared.installLifecycleObserversIfNeeded()
            shared.attachGestureIfNeeded()
        }
    }

    private func installLifecycleObserversIfNeeded() {
        guard !observersInstalled else { return }
        observersInstalled = true

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleWillResignActive),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
    }

    @objc private func handleDidBecomeActive() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            self.attachGestureIfNeeded()
        }
    }

    @objc private func handleWillResignActive() {
        // Nếu đang mở bảng đăng nhập (chưa Live) mà vuốt ra ngoài -> đóng ngay trước lúc iOS chụp snapshot đa nhiệm
        if !NetworkManager.shared.isAuthenticated, hostedVC != nil {
            dismissOverlay(cleanSession: true)
        }
    }

    @objc private func handleDidEnterBackground() {
        dismissOverlay(cleanSession: true)
    }

    private func currentKeyWindow() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive || $0.activationState == .foregroundInactive }

        for scene in scenes {
            if let key = scene.windows.first(where: { $0.isKeyWindow }) {
                return key
            }
            if let normal = scene.windows.first(where: { $0.windowLevel == .normal && !$0.isHidden }) {
                return normal
            }
        }
        return UIApplication.shared.windows.first(where: { $0.isKeyWindow })
            ?? UIApplication.shared.windows.first
    }

    private func attachGestureIfNeeded() {
        guard let window = currentKeyWindow() else { return }
        if attachedWindow === window, tripleTapGesture != nil { return }

        if let oldGesture = tripleTapGesture, let oldWindow = attachedWindow {
            oldWindow.removeGestureRecognizer(oldGesture)
        }

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleThreeFingerTripleTap))
        tap.numberOfTouchesRequired = 3
        tap.numberOfTapsRequired = 3
        tap.cancelsTouchesInView = false
        tap.delaysTouchesBegan = false
        tap.delaysTouchesEnded = false
        tap.delegate = self

        window.addGestureRecognizer(tap)
        attachedWindow = window
        tripleTapGesture = tap
    }

    public func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        return true
    }

    @objc private func handleThreeFingerTripleTap() {
        DispatchQueue.main.async {
            self.presentOverlayIfNeeded()
        }
    }

    private func topMostViewController(from root: UIViewController?) -> UIViewController? {
        var current = root
        while let presented = current?.presentedViewController {
            current = presented
        }
        return current
    }

    private func presentOverlayIfNeeded() {
        if hostedVC != nil { return }
        guard let window = currentKeyWindow(),
              let topVC = topMostViewController(from: window.rootViewController) else {
            return
        }

        let rootView = ContentView(dylibDismissHandler: { [weak self] in
            self?.dismissOverlay(cleanSession: true)
        })
        let host = UIHostingController(rootView: rootView)
        host.modalPresentationStyle = .overFullScreen
        host.view.backgroundColor = .clear

        self.hostedVC = host
        topVC.present(host, animated: false)
    }

    private func dismissOverlay(cleanSession: Bool) {
        if cleanSession {
            if let cam = CameraManager.current {
                if cam.isStreaming || cam.isConnecting {
                    cam.stopLiveStream()
                }
                cam.pauseMotionUpdates()
            }
            LocationManager.shared.stopTracking()
            if NetworkManager.shared.isAuthenticated {
                NetworkManager.shared.stopStream()
                NetworkManager.shared.logout()
            }
            RoiSyncManager.shared.stop()
            BlackScreenManager.shared.hide()
        }

        if let host = hostedVC {
            hostedVC = nil
            // Dismiss từ presentingViewController gốc để đóng trọn cả BlackViewController lẫn hostedVC trong 1 lần
            if let presenter = host.presentingViewController {
                presenter.dismiss(animated: false)
            } else {
                host.dismiss(animated: false)
            }
        }
    }
}
