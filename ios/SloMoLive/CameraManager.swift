import Foundation
import AVFoundation
import UIKit

/// CameraManager cấu hình AVCaptureSession 240fps HFR và gửi từng khung hình video trực tiếp
/// về Server qua WebSocket / NetworkManager để Web hiển thị tức thì (Requirement 1 & 2).
public class CameraManager: NSObject, ObservableObject {
    @Published public var isStreaming = false
    @Published public var currentFPS: Double = 240.0
    @Published public var errorMessage: String? = nil
    
    public let captureSession = AVCaptureSession()
    private var videoDeviceInput: AVCaptureDeviceInput?
    private let videoDataOutput = AVCaptureVideoDataOutput()
    private let sessionQueue = DispatchQueue(label: "com.slomo.camera.sessionQueue")

    // Metal GPU CIContext tái sử dụng duy nhất (không tái tạo lại trên từng frame làm nóng máy và tụt FPS)
    private let ciContext = CIContext(options: [
        .useSoftwareRenderer: false,
        .priorityRequestLow: false
    ])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    private var lastSentTime: TimeInterval = 0

    private var frameCounter = 0
    private var lastFrameTime = Date()

    public override init() {
        super.init()
    }

    public func setupCamera(completion: @escaping (Bool) -> Void) {
        sessionQueue.async {
            self.captureSession.beginConfiguration()
            
            guard let videoDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                DispatchQueue.main.async {
                    self.errorMessage = "Không tìm thấy camera."
                    completion(false)
                }
                return
            }

            do {
                let videoInput = try AVCaptureDeviceInput(device: videoDevice)
                if self.captureSession.canAddInput(videoInput) {
                    self.captureSession.addInput(videoInput)
                    self.videoDeviceInput = videoInput
                }

                var selectedFormat: AVCaptureDevice.Format? = nil
                for format in videoDevice.formats {
                    for range in format.videoSupportedFrameRateRanges {
                        if range.maxFrameRate >= 240.0 {
                            selectedFormat = format
                            break
                        }
                    }
                    if selectedFormat != nil { break }
                }

                try videoDevice.lockForConfiguration()
                if let format = selectedFormat {
                    videoDevice.activeFormat = format
                    videoDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: 240)
                    videoDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: 240)
                    DispatchQueue.main.async { self.currentFPS = 240.0 }
                } else {
                    videoDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: 60)
                    videoDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: 60)
                    DispatchQueue.main.async { self.currentFPS = 60.0 }
                }
                videoDevice.unlockForConfiguration()

                if self.captureSession.canAddOutput(self.videoDataOutput) {
                    self.videoDataOutput.alwaysDiscardsLateVideoFrames = true
                    self.videoDataOutput.videoSettings = [
                        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)
                    ]
                    self.videoDataOutput.setSampleBufferDelegate(self, queue: DispatchQueue(label: "com.slomo.video.outputQueue"))
                    self.captureSession.addOutput(self.videoDataOutput)
                }

                self.captureSession.commitConfiguration()
                self.captureSession.startRunning()

                DispatchQueue.main.async {
                    completion(true)
                }
            } catch {
                self.captureSession.commitConfiguration()
                DispatchQueue.main.async {
                    self.errorMessage = "Lỗi cấu hình Camera: \(error.localizedDescription)"
                    completion(false)
                }
            }
        }
    }

    @Published public var cameraPosition: AVCaptureDevice.Position = .back

    public func startLiveStream() {
        DispatchQueue.main.async {
            self.isStreaming = true
        }
    }

    public func stopLiveStream() {
        DispatchQueue.main.async {
            self.isStreaming = false
        }
    }

    /// Lật Camera trước / sau hỗ trợ quay Slo-Mo
    public func switchCamera(completion: ((Bool) -> Void)? = nil) {
        let newPosition: AVCaptureDevice.Position = (self.cameraPosition == .back) ? .front : .back
        sessionQueue.async {
            self.captureSession.beginConfiguration()
            
            if let currentInput = self.videoDeviceInput {
                self.captureSession.removeInput(currentInput)
            }
            
            guard let newDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: newPosition) else {
                self.captureSession.commitConfiguration()
                DispatchQueue.main.async {
                    self.errorMessage = "Không tìm thấy camera \(newPosition == .front ? "trước" : "sau")."
                    completion?(false)
                }
                return
            }
            
            do {
                let newInput = try AVCaptureDeviceInput(device: newDevice)
                if self.captureSession.canAddInput(newInput) {
                    self.captureSession.addInput(newInput)
                    self.videoDeviceInput = newInput
                }
                
                // Quét tìm format hỗ trợ FPS cao nhất trên camera này
                var highestFormat: AVCaptureDevice.Format? = nil
                var maxRate: Double = 30.0
                for format in newDevice.formats {
                    for range in format.videoSupportedFrameRateRanges {
                        if range.maxFrameRate > maxRate {
                            maxRate = range.maxFrameRate
                            highestFormat = format
                        }
                    }
                }
                
                try newDevice.lockForConfiguration()
                if let format = highestFormat {
                    newDevice.activeFormat = format
                    let targetTimescale = Int32(min(maxRate, 240.0))
                    newDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: targetTimescale)
                    newDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: targetTimescale)
                    DispatchQueue.main.async { self.currentFPS = Double(targetTimescale) }
                } else {
                    newDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: 60)
                    newDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: 60)
                    DispatchQueue.main.async { self.currentFPS = 60.0 }
                }
                newDevice.unlockForConfiguration()
                
                self.captureSession.commitConfiguration()
                DispatchQueue.main.async {
                    self.cameraPosition = newPosition
                    completion?(true)
                }
            } catch {
                self.captureSession.commitConfiguration()
                DispatchQueue.main.async {
                    self.errorMessage = "Lỗi đổi camera: \(error.localizedDescription)"
                    completion?(false)
                }
            }
        }
    }
}

extension CameraManager: AVCaptureVideoDataOutputSampleBufferDelegate {
    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard isStreaming else { return }
        
        autoreleasepool {
            guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            var ciImage = CIImage(cvImageBuffer: imageBuffer)
            
            // Tối ưu kích thước khung hình chuẩn 960x540 để truyền siêu tốc 120fps/240fps
            let extent = ciImage.extent
            if extent.width > 960 {
                let scale = 960.0 / extent.width
                ciImage = ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            }
            
            // Nén Intra-Frame độc lập trên GPU Metal (< 1ms), chất lượng 0.5 rõ nét, chống nhòe triệt để
            guard let jpegData = ciContext.jpegRepresentation(
                of: ciImage,
                colorSpace: colorSpace,
                options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.5]
            ) else { return }
            
            let timestamp = Date().timeIntervalSince1970
            // Truyền trực tiếp dữ liệu nhị phân siêu tốc qua WebSocket, không bị nghẽn mạng
            NetworkManager.shared.sendBinaryFrame(data: jpegData, timestamp: timestamp)
        }
    }
}
