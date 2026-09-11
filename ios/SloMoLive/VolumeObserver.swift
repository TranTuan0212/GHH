import Foundation
import AVFoundation
import MediaPlayer
import UIKit

/// Lang nghe phim cung am luong (Volume Down x3) de mo man hinh nguy trang.
/// - Su dung KVO tren AVAudioSession.outputVolume de bat su kien chinh xac.
/// - Reset slider ve 0.5 ONLY sau khi da kich hoat triple-click hoac am luong sap cham dich (< 0.15 / > 0.85),
///   khong reset giua chuoi dem tranh mat count.
public class VolumeObserver: NSObject, ObservableObject {
    public static let shared = VolumeObserver()

    private var volumeView: MPVolumeView?
    private weak var volumeSlider: UISlider?
    private var lastVolume: Float = 0.5
    private var clickTimestamps: [Date] = []
    private var kvoToken: NSKeyValueObservation?
    private var isResetting = false  // guard: tranh vong lap khi reset slider

    public var onTripleVolumeDown: (() -> Void)?

    private override init() {
        super.init()
        setupAudioSession()
        setupHiddenVolumeView()
        startKVO()
    }

    // MARK: - Audio Session
    private func setupAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers, .allowBluetooth])
            try AVAudioSession.sharedInstance().setActive(true)
            lastVolume = AVAudioSession.sharedInstance().outputVolume
        } catch {
            print("[VolumeObserver] AVAudioSession error: \(error)")
        }
    }

    // MARK: - Hidden MPVolumeView (an Volume HUD cua iOS)
    private func setupHiddenVolumeView() {
        DispatchQueue.main.async {
            let v = MPVolumeView(frame: CGRect(x: -2000, y: -2000, width: 1, height: 1))
            v.clipsToBounds = true
            v.alpha = 0.001
            v.isUserInteractionEnabled = false

            // Them vao window chinh
            if let window = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .flatMap({ $0.windows })
                .first(where: { $0.isKeyWindow }) ?? UIApplication.shared.windows.first {
                window.addSubview(v)
            }

            self.volumeView = v
            self.volumeSlider = v.subviews.first(where: { $0 is UISlider }) as? UISlider
            // Set slider ve 0.5 khi khoi dong
            self.doResetSlider()
        }
    }

    // MARK: - KVO theo doi outputVolume (chinh xac hon NSNotification)
    private func startKVO() {
        kvoToken = AVAudioSession.sharedInstance().observe(
            \.outputVolume,
            options: [.new, .old]
        ) { [weak self] session, change in
            guard let self = self else { return }
            // Bo qua su kien do chinh ta reset slider
            if self.isResetting { return }

            let newVol = session.outputVolume
            let oldVol = change.oldValue ?? self.lastVolume

            // Chi tinh khi nguoi dung GIAM am luong (bam Volume Down)
            if newVol < oldVol - 0.01 {
                let now = Date()
                self.clickTimestamps.append(now)
                // Chi giu cac lan bam trong 2 giay
                self.clickTimestamps = self.clickTimestamps.filter {
                    now.timeIntervalSince($0) <= 2.0
                }

                print("[VolumeObserver] Volume Down bam \(self.clickTimestamps.count)/3")

                if self.clickTimestamps.count >= 3 {
                    self.clickTimestamps.removeAll()
                    print("[VolumeObserver] Triple Volume Down -> Kich hoat!")
                    DispatchQueue.main.async {
                        self.onTripleVolumeDown?()
                        // Reset sau khi kich hoat
                        self.doResetSlider()
                    }
                    return
                }
            }

            self.lastVolume = newVol

            // Reset neu am luong sap cham dich (tranh bi ket o 0 hoac 1)
            if newVol <= 0.12 || newVol >= 0.88 {
                self.doResetSlider()
            }
        }
    }

    // Reset slider ve 0.5 ma khong trigger KVO lap
    public func doResetSlider() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
            guard let self = self else { return }
            self.isResetting = true
            self.volumeSlider?.value = 0.5
            self.lastVolume = 0.5
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                self.isResetting = false
            }
        }
    }

    // Giu lai de ContentView goi khi app hien thi
    public func resetVolumeSliderToMid() {
        doResetSlider()
    }

    deinit {
        kvoToken?.invalidate()
        volumeView?.removeFromSuperview()
    }
}
