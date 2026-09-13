import React, { useState } from 'react';
import { Radio, Lock, User as UserIcon, Smartphone, ShieldCheck, Zap, AlertCircle, Download } from 'lucide-react';
import { IosInstallModal } from './IosInstallModal';

interface LoginFormProps {
  onLoginSuccess: (token: string, user: any) => void;
}

export const LoginForm: React.FC<LoginFormProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [platform, setPlatform] = useState<'web' | 'mobile'>('web');
  const [deviceUuid, setDeviceUuid] = useState('iphone-15-pro-demo-uuid-999');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showIosModal, setShowIosModal] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          platform,
          deviceUuid: platform === 'mobile' ? deviceUuid : undefined,
          deviceModel: 'iPhone 15 Pro Max'
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Đăng nhập thất bại.');
      }

      onLoginSuccess(data.token, data.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-3 sm:p-4 py-6 relative overflow-y-auto bg-dark-400">
      {/* Background Animated Glowing Blobs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-600/20 rounded-full blur-3xl animate-pulse-slow pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-600/20 rounded-full blur-3xl animate-pulse-slow pointer-events-none" />

      <div className="max-w-md w-full glass-panel p-5 sm:p-7 rounded-2xl sm:rounded-3xl border border-indigo-500/30 shadow-2xl relative z-10 space-y-4 sm:space-y-5 my-auto">
        {/* Header Logo */}
        <div className="text-center space-y-1.5">
          <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-xl sm:rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-600 mx-auto flex items-center justify-center text-white shadow-xl shadow-indigo-600/40 animate-glow">
            <Radio className="w-6 h-6 sm:w-8 sm:h-8" />
          </div>
          <h2 className="text-xl sm:text-2xl font-extrabold text-white tracking-tight">SloMo Live 240FPS</h2>
          <p className="text-xs text-slate-400">Hệ thống Phát trực tiếp & Tự động Phân loại Dữ liệu theo Nhóm</p>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="p-3.5 rounded-xl bg-red-500/20 text-red-300 border border-red-500/30 text-xs font-medium flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Tên Đăng Nhập</label>
            <div className="relative">
              <UserIcon className="w-4 h-4 absolute left-3.5 top-3 text-slate-400" />
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-900/90 border border-white/10 text-white font-mono text-sm focus:border-indigo-500 outline-none"
                placeholder="Nhập username"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Mật Khẩu</label>
            <div className="relative">
              <Lock className="w-4 h-4 absolute left-3.5 top-3 text-slate-400" />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-900/90 border border-white/10 text-white font-mono text-sm focus:border-indigo-500 outline-none"
                placeholder="******"
              />
            </div>
          </div>

          {/* Platform Login Option */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Quyền Đăng Nhập</label>
            <div className="grid grid-cols-2 gap-2 p-1 bg-slate-900/90 rounded-xl border border-white/10 text-xs">
              <button
                type="button"
                onClick={() => setPlatform('web')}
                className={`py-2 rounded-lg font-bold transition-all ${
                  platform === 'web'
                    ? 'bg-indigo-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Web Viewer (Chỉ xem)
              </button>
              <button
                type="button"
                onClick={() => setPlatform('mobile')}
                className={`py-2 rounded-lg font-bold transition-all ${
                  platform === 'mobile'
                    ? 'bg-indigo-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Mobile Live (Phát Live)
              </button>
            </div>
          </div>

          {platform === 'mobile' && (
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Hardware Device UUID (Gán duy nhất 1 iPhone - Req 8a)
              </label>
              <input
                type="text"
                value={deviceUuid}
                onChange={(e) => setDeviceUuid(e.target.value)}
                className="w-full px-3.5 py-2 rounded-xl bg-slate-900 border border-amber-500/30 text-amber-300 font-mono text-xs outline-none"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold text-sm shadow-xl shadow-indigo-600/30 transition-all active:scale-95"
          >
            {loading ? 'Đang xác thực...' : 'Đăng Nhập'}
          </button>
        </form>

        {/* Nút Cài đặt App iOS trực tiếp */}
        <div className="pt-2 border-t border-white/10 text-center">
          <button
            type="button"
            onClick={() => setShowIosModal(true)}
            className="w-full py-2.5 px-3 rounded-xl bg-slate-900/90 hover:bg-slate-800 text-indigo-300 hover:text-white border border-indigo-500/30 hover:border-indigo-400 font-bold text-xs flex items-center justify-center space-x-2 transition-all shadow-lg active:scale-95 cursor-pointer"
          >
            <Smartphone className="w-4 h-4 text-indigo-400 animate-pulse" />
            <span>📲 Cài Đặt App iPhone (iOS có sẵn chứng chỉ)</span>
          </button>
        </div>

        <IosInstallModal
          isOpen={showIosModal}
          onClose={() => setShowIosModal(false)}
        />
      </div>
    </div>
  );
};
