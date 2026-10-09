import React, { useState } from 'react';
import { Smartphone, Download, Check, Copy, X, ShieldCheck } from 'lucide-react';

interface IosInstallModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const IosInstallModal: React.FC<IosInstallModalProps> = ({ isOpen, onClose }) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const currentHost = typeof window !== 'undefined' ? window.location.host : 'slomoview.stream';
  const manifestUrl = `https://${currentHost}/ios/manifest.plist`;
  const otaUrl = `itms-services://?action=download-manifest&url=${manifestUrl}`;
  const directIpaUrl = `/ios/SloMoLive.ipa`;
  const pageUrl = typeof window !== 'undefined' ? window.location.href : `https://${currentHost}`;

  const handleCopyLink = () => {
    try {
      navigator.clipboard.writeText(pageUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {}
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 animate-fadeIn">
      <div className="glass-panel max-w-sm sm:max-w-md w-full p-4 sm:p-5 rounded-2xl border border-indigo-500/30 space-y-3 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
          <div className="flex items-center space-x-2">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white shadow shadow-indigo-600/40">
              <Smartphone className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-xs sm:text-sm text-white flex items-center gap-1.5">
                Cài Đặt App iPhone (iOS)
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-mono font-bold border border-emerald-500/30">
                  Có sẵn chứng chỉ
                </span>
              </h3>
              <p className="text-[10px] sm:text-[11px] text-slate-400">Cài trực tiếp không cần máy tính qua Safari</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Nút Cài Đặt Trực Tiếp (OTA itms-services) */}
        <div className="space-y-2">
          <a
            href={otaUrl}
            className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold text-xs sm:text-sm flex items-center justify-center space-x-2 shadow-lg shadow-indigo-600/30 transition-all active:scale-95"
          >
            <Download className="w-4 h-4" />
            <span>Cài Đặt Trực Tiếp (Mở bằng Safari)</span>
          </a>

          <div className="flex items-center justify-between gap-2 text-[11px]">
            <a
              href={directIpaUrl}
              download="SloMoLive.ipa"
              className="flex-1 py-1.5 px-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white font-medium text-center border border-white/10 transition-all flex items-center justify-center space-x-1"
              title="Tải file IPA về máy tính để cài qua Sideloadly/TrollStore"
            >
              <span>Tải file .IPA</span>
            </a>

            <button
              type="button"
              onClick={handleCopyLink}
              className="py-1.5 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white font-medium border border-white/10 transition-all flex items-center space-x-1"
              title="Sao chép link trang này để dán vào Safari iPhone"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Đã sao chép' : 'Chép link Safari'}</span>
            </button>
          </div>
        </div>

        {/* Hướng dẫn 3 bước */}
        <div className="bg-slate-950/80 p-2.5 sm:p-3 rounded-xl border border-white/10 space-y-2 text-[11px] sm:text-xs">
          <p className="font-bold text-amber-300 flex items-center space-x-1">
            <ShieldCheck className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <span>Hướng dẫn 3 bước cài đặt trên iPhone:</span>
          </p>

          <div className="space-y-1.5 text-slate-300 leading-relaxed">
            <div className="flex items-start space-x-2">
              <span className="w-4 h-4 rounded-full bg-indigo-600 text-white font-bold flex items-center justify-center text-[10px] flex-shrink-0 mt-0.5">
                1
              </span>
              <span>
                Mở web này bằng <strong className="text-white">trình duyệt Safari</strong> trên iPhone ➔ Bấm nút <strong className="text-indigo-300">"Cài Đặt Trực Tiếp"</strong> ở trên.
              </span>
            </div>

            <div className="flex items-start space-x-2">
              <span className="w-4 h-4 rounded-full bg-indigo-600 text-white font-bold flex items-center justify-center text-[10px] flex-shrink-0 mt-0.5">
                2
              </span>
              <span>
                Khi iPhone hiện hộp thoại thông báo, bấm <strong className="text-emerald-400">"Cài đặt"</strong>. App sẽ tự động tải về màn hình chính.
              </span>
            </div>

            <div className="flex items-start space-x-2">
              <span className="w-4 h-4 rounded-full bg-indigo-600 text-white font-bold flex items-center justify-center text-[10px] flex-shrink-0 mt-0.5">
                3
              </span>
              <span>
                Vào <strong className="text-white">Cài đặt máy</strong> ➔ <strong className="text-white">Cài đặt chung</strong> ➔ <strong className="text-white">Quản lý VPN & Thiết bị</strong> ➔ Chọn Chứng chỉ Doanh nghiệp và bấm <strong className="text-amber-300">"Tin cậy"</strong> để mở app.
              </span>
            </div>
          </div>
        </div>

        {/* Footer Close */}
        <div className="flex justify-end pt-0.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-all"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
};
