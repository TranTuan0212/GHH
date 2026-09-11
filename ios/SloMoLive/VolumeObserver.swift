import Foundation
import AVFoundation
import MediaPlayer
import UIKit

/// Lắng nghe phím cứng âm lượng (Volume Down x3) để mở màn hình ngụy trang
/// và ẩn thanh System Volume HUD của iOS.
public class VolumeObserver: NSObject, ObservableObject {
    public static let shared = VolumeObserver()

    private var volumeView: MPVolumeView?
    private weak var volumeSlider: UISlider?
    private var lastVolume: Float = 0.5
    private var clickTimestamps: [Date] = []

    public var onTripleVolumeDown: (() -> Void)?

    private override init() {
        super.init()
        setupAudioSession()
        setupHiddenVolumeView()
    }

    private func setupAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.ambient, options: .mixWithOthers)
            try AVAudioSession.sharedInstance().setActive(true)
            lastVolume = AVAudioSession.sharedInstance().outputVolume
        } catch {
            print("[VolumeObserver] Lỗi kích hoạt AVAudioSession: \(error)")
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(volumeChanged(notification:)),
            name: NSNotification.Name("AVSystemController_SystemVolumeDidChangeNotification"),
            object: nil
        )
    }

    private func setupHiddenVolumeView() {
        DispatchQueue.main.async {
            // Nhúng MPVolumeView kích thước siêu nhỏ ngoài vùng nhìn thấy để ẩn System Volume HUD
            let v = MPVolumeView(frame: CGRect(x: -1000, y: -1000, width: 1, height: 1))
            v.clipsToBounds = true
            v.alpha = 0.001

            let scenes = UIApplication.shared.connectedScenes
            if let windowScene = scenes.first as? UIWindowScene,
               let window = windowScene.windows.first {
                window.addSubview(v)
            }

            self.volumeView = v
            self.volumeSlider = v.subviews.first(where: { $0 is UISlider }) as? UISlider
            self.resetVolumeSliderToMid()
        }
    }

    public func resetVolumeSliderToMid() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            self.volumeSlider?.value = 0.5
            self.lastVolume = 0.5
        }
    }

    @objc private func volumeChanged(notification: NSNotification) {
        guard let userInfo = notification.userInfo,
              let newVolume = userInfo["AVSystemController_AudioVolumeNotificationParameter"] as? Float else {
            return
        }

        // Bắt sự kiện giảm âm lượng (người dùng bấm nút Volume Down)
        if newVolume < lastVolume {
            let now = Date()
            clickTimestamps.append(now)
            // Giữ các lần nhấn trong vòng 2.0 giây
            clickTimestamps = clickTimestamps.filter { now.timeIntervalSince($0) <= 2.0 }

            print("[VolumeObserver] Đã bấm nút Giảm âm lượng (\(clickTimestamps.count)/3 lần)")

            if clickTimestamps.count >= 3 {
                clickTimestamps.removeAll()
                print("[VolumeObserver] 🎉 Đủ 3 lần bấm Giảm âm lượng -> Kích hoạt mở màn hình!")
                DispatchQueue.main.async {
                    self.onTripleVolumeDown?()
                }
            }
        }

        lastVolume = newVolume

        // Đảm bảo slider luôn ở khoảng giữa (0.5) để không bị kịch sàn âm lượng 0
        if newVolume < 0.2 || newVolume > 0.8 {
            resetVolumeSliderToMid()
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        volumeView?.removeFromSuperview()
    }
}
