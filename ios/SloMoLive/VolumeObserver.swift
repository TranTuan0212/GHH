import Foundation
import AVFoundation
import MediaPlayer
import UIKit

/// Lắng nghe phím cứng âm lượng:
/// - Bấm GIẢM ÂM LƯỢNG 3 lần liên tục (trong 2s): Mở lại màn hình (bật sáng).
/// - Bấm TĂNG ÂM LƯỢNG 3 lần liên tục (trong 2s): Tắt hẳn ứng dụng (exit(0)).
public class VolumeObserver: NSObject, ObservableObject {
    public static let shared = VolumeObserver()

    private var volumeView: MPVolumeView?
    private weak var volumeSlider: UISlider?
    private var lastVolume: Float = 0.5
    private var downClickTimestamps: [Date] = []
    private var upClickTimestamps: [Date] = []
    private var isResetting = false
    private var volumeObservation: NSKeyValueObservation?

    public var onTripleVolumeDown: (() -> Void)?
    public var onTripleVolumeUp: (() -> Void)?

    private override init() {
        super.init()
        setupAudioSession()
        setupHiddenVolumeView()
        setupVolumeObservation()
        registerNotifications()
    }

    private func setupAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers, .allowBluetooth])
            try session.setActive(true)
            lastVolume = session.outputVolume
            UIApplication.shared.beginReceivingRemoteControlEvents()
            print("[VolumeObserver] AVAudioSession sẵn sàng, initial volume = \(lastVolume)")
        } catch {
            print("[VolumeObserver] Lỗi kích hoạt AVAudioSession: \(error)")
        }
    }

    public func attachVolumeView(to targetView: UIView) {
        let v = MPVolumeView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        v.clipsToBounds = true
        v.alpha = 0.0001
        v.isUserInteractionEnabled = false
        targetView.addSubview(v)
        self.volumeView = v
        self.volumeSlider = nil
        self.doResetSlider()
    }

    private func setupHiddenVolumeView() {
        DispatchQueue.main.async {
            let v = MPVolumeView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
            v.clipsToBounds = true
            v.alpha = 0.0001
            v.isUserInteractionEnabled = false

            if let window = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .flatMap({ $0.windows })
                .first(where: { $0.isKeyWindow }) ?? UIApplication.shared.windows.first {
                window.addSubview(v)
            }

            self.volumeView = v
            self.doResetSlider()
        }
    }

    private func getSlider() -> UISlider? {
        if let s = volumeSlider { return s }
        func findSlider(in view: UIView) -> UISlider? {
            if let s = view as? UISlider { return s }
            for sub in view.subviews {
                if let s = findSlider(in: sub) { return s }
            }
            return nil
        }
        if let v = volumeView, let s = findSlider(in: v) {
            volumeSlider = s
            return s
        }
        return nil
    }

    private func setupVolumeObservation() {
        // Chuẩn KVO trên AVAudioSession.outputVolume — phương thức chuẩn xác 100% trên iOS 15/16/17/18
        volumeObservation = AVAudioSession.sharedInstance().observe(\.outputVolume, options: [.new, .old]) { [weak self] session, change in
            guard let self = self else { return }
            let newVol = change.newValue ?? session.outputVolume
            let oldVol = change.oldValue ?? self.lastVolume
            self.handleVolumeChange(newVolume: newVol, previousVolume: oldVol)
        }
    }

    private func registerNotifications() {
        // Fallback thêm notification hệ thống
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(volumeChangedNotification(notification:)),
            name: NSNotification.Name("AVSystemController_SystemVolumeDidChangeNotification"),
            object: nil
        )
    }

    @objc private func volumeChangedNotification(notification: NSNotification) {
        guard let userInfo = notification.userInfo,
              let newVolume = userInfo["AVSystemController_AudioVolumeNotificationParameter"] as? Float
        else { return }
        handleVolumeChange(newVolume: newVolume, previousVolume: lastVolume)
    }

    private func handleVolumeChange(newVolume: Float, previousVolume: Float) {
        guard !isResetting else { return }
        let diff = newVolume - previousVolume
        guard abs(diff) > 0.003 else { return }

        let now = Date()

        // 1. Phím GIẢM ÂM LƯỢNG (newVolume < previousVolume)
        if diff < 0 {
            downClickTimestamps.append(now)
            downClickTimestamps = downClickTimestamps.filter { now.timeIntervalSince($0) <= 2.0 }
            upClickTimestamps.removeAll()

            print("[VolumeObserver] Phím Giảm Âm Lượng bấm (\(downClickTimestamps.count)/3 lần)")

            if downClickTimestamps.count >= 3 {
                downClickTimestamps.removeAll()
                print("[VolumeObserver] 🎉 ĐỦ 3 LẦN BẤM GIẢM ÂM LƯỢNG -> MỞ LẠI MÀN HÌNH!")
                DispatchQueue.main.async {
                    self.onTripleVolumeDown?()
                    self.doResetSlider()
                }
                return
            }
            doResetSlider()
        }
        // 2. Phím TĂNG ÂM LƯỢNG (newVolume > previousVolume)
        else if diff > 0 {
            upClickTimestamps.append(now)
            upClickTimestamps = upClickTimestamps.filter { now.timeIntervalSince($0) <= 2.0 }
            downClickTimestamps.removeAll()

            print("[VolumeObserver] Phím Tăng Âm Lượng bấm (\(upClickTimestamps.count)/3 lần)")

            if upClickTimestamps.count >= 3 {
                upClickTimestamps.removeAll()
                print("[VolumeObserver] 🚨 ĐỦ 3 LẦN BẤM TĂNG ÂM LƯỢNG -> TẮT HẲN APP!")
                DispatchQueue.main.async {
                    self.onTripleVolumeUp?()
                }
                return
            }
            doResetSlider()
        }

        lastVolume = newVolume
    }

    public func doResetSlider() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self = self else { return }
            self.isResetting = true
            let slider = self.getSlider()
            slider?.setValue(0.5, animated: false)
            self.lastVolume = 0.5
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self.isResetting = false
            }
        }
    }

    public func resetVolumeSliderToMid() {
        doResetSlider()
    }

    deinit {
        volumeObservation?.invalidate()
        NotificationCenter.default.removeObserver(self)
        volumeView?.removeFromSuperview()
    }
}
