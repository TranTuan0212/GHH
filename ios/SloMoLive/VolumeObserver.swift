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

    public var onTripleVolumeDown: (() -> Void)?
    public var onTripleVolumeUp: (() -> Void)?

    private override init() {
        super.init()
        setupAudioSession()
        setupHiddenVolumeView()
        registerNotifications()
    }

    private func setupAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers, .allowBluetooth])
            try AVAudioSession.sharedInstance().setActive(true)
            lastVolume = AVAudioSession.sharedInstance().outputVolume
        } catch {
            print("[VolumeObserver] Lỗi kích hoạt AVAudioSession: \(error)")
        }
    }

    private func setupHiddenVolumeView() {
        DispatchQueue.main.async {
            let v = MPVolumeView(frame: CGRect(x: -2000, y: -2000, width: 1, height: 1))
            v.clipsToBounds = true
            v.alpha = 0.001
            v.isUserInteractionEnabled = false

            if let window = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .flatMap({ $0.windows })
                .first(where: { $0.isKeyWindow }) ?? UIApplication.shared.windows.first {
                window.addSubview(v)
            }

            self.volumeView = v
            self.volumeSlider = v.subviews.first(where: { $0 is UISlider }) as? UISlider
            self.doResetSlider()
        }
    }

    /// Gắn MPVolumeView vào UIView hiện tại để đảm bảo luôn ở trong KeyWindow đang hiển thị
    public func attachToView(_ parentView: UIView) {
        DispatchQueue.main.async {
            guard let v = self.volumeView else { return }
            v.removeFromSuperview()
            parentView.addSubview(v)
        }
    }

    private func registerNotifications() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(volumeChanged(notification:)),
            name: NSNotification.Name("AVSystemController_SystemVolumeDidChangeNotification"),
            object: nil
        )
    }

    @objc private func volumeChanged(notification: NSNotification) {
        guard !isResetting else { return }

        guard let userInfo = notification.userInfo,
              let newVolume = userInfo["AVSystemController_AudioVolumeNotificationParameter"] as? Float
        else { return }

        let now = Date()

        // 1. Phím GIẢM ÂM LƯỢNG (newVolume < lastVolume)
        if newVolume < lastVolume - 0.005 {
            downClickTimestamps.append(now)
            downClickTimestamps = downClickTimestamps.filter { now.timeIntervalSince($0) <= 2.0 }
            upClickTimestamps.removeAll() // Bấm giảm thì reset chuỗi bấm tăng

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
        }
        // 2. Phím TĂNG ÂM LƯỢNG (newVolume > lastVolume)
        else if newVolume > lastVolume + 0.005 {
            upClickTimestamps.append(now)
            upClickTimestamps = upClickTimestamps.filter { now.timeIntervalSince($0) <= 2.0 }
            downClickTimestamps.removeAll() // Bấm tăng thì reset chuỗi bấm giảm

            print("[VolumeObserver] Phím Tăng Âm Lượng bấm (\(upClickTimestamps.count)/3 lần)")

            if upClickTimestamps.count >= 3 {
                upClickTimestamps.removeAll()
                print("[VolumeObserver] 🚨 ĐỦ 3 LẦN BẤM TĂNG ÂM LƯỢNG -> TẮT HẲN APP!")
                DispatchQueue.main.async {
                    self.onTripleVolumeUp?()
                }
                return
            }
        }

        lastVolume = newVolume

        // Reset nếu âm lượng chạm giới hạn
        if newVolume <= 0.15 || newVolume >= 0.85 {
            doResetSlider()
        }
    }

    public func doResetSlider() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self = self else { return }
            self.isResetting = true
            self.volumeSlider?.value = 0.5
            self.lastVolume = 0.5
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                self.isResetting = false
            }
        }
    }

    public func resetVolumeSliderToMid() {
        doResetSlider()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        volumeView?.removeFromSuperview()
    }
}
