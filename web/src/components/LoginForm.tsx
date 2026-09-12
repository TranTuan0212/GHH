import React, { useState } from 'react';
import { Radio, Lock, User as UserIcon, Smartphone, ShieldCheck, Zap, AlertCircle } from 'lucide-react';

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

  const fillDemoAdmin = () => {
    setUsername('admin');
    setPassword('admin123');
    setPlatform('web');
  };

  const fillDemoUser = () => {
    setUsername('demouser');
    setPassword('user123');
    setPlatform('web');
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden bg-dark-400">
      {/* Background Animated Glowing Blobs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-600/20 rounded-full blur-3xl animate-pulse-slow" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-600/20 rounded-full blur-3xl animate-pulse-slow" />

      <div className="max-w-md w-full glass-panel p-5 sm:p-8 rounded-3xl border border-indigo-500/30 shadow-2xl relative z-10 space-y-5 sm:space-y-6">
        {/* Header Logo */}
        <div className="text-center space-y-2">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-600 mx-auto flex items-center justify-center text-white shadow-xl shadow-indigo-600/40 animate-glow">
            <Radio className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-extrabold text-white tracking-tight">SloMo Live 240FPS</h2>
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

        {/* Quick Demo Buttons */}
        <div className="pt-4 border-t border-white/5 space-y-2">
          <p className="text-[11px] text-slate-400 text-center font-medium">Bấm nhanh để dùng thử tài khoản mẫu:</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={fillDemoAdmin}
              className="py-1.5 px-3 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-bold transition-all"
            >
              Demo Admin (admin/admin123)
            </button>
            <button
              onClick={fillDemoUser}
              className="py-1.5 px-3 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-xs font-bold transition-all"
            >
              Demo User (demouser/user123)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
