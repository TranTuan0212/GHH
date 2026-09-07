import React from 'react';
import { User } from '../types';
import { Radio, Shield, LogOut, Calendar, Eye } from 'lucide-react';

interface NavbarProps {
  user: User;
  onLogout: () => void;
  activeTab: 'viewer' | 'admin';
  setActiveTab: (tab: 'viewer' | 'admin') => void;
}

export const Navbar: React.FC<NavbarProps> = ({ user, onLogout, activeTab, setActiveTab }) => {
  return (
    <header className="glass-panel border-b border-white/5 sticky top-0 z-40">
      <div className="max-w-[1700px] mx-auto px-2.5 sm:px-4">
        <div className="h-12 sm:h-13 flex items-center justify-between">
          {/* Brand Logo */}
          <div className="flex items-center space-x-2 sm:space-x-3">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-gradient-to-tr from-indigo-600 to-indigo-400 flex items-center justify-center text-white shadow shadow-indigo-600/40 flex-shrink-0">
              <Radio className="w-4 h-4 sm:w-4.5 sm:h-4.5 animate-pulse" />
            </div>
            <div>
              <h1 className="font-bold text-xs sm:text-base text-white tracking-tight flex items-center gap-1.5">
                SloMo Live <span className="text-indigo-400 font-mono text-[9px] sm:text-[10px] px-1 py-0.2 rounded bg-indigo-500/20">240FPS</span>
              </h1>
            </div>

            {/* Role Navigation Tabs - Desktop */}
            {user.role === 'ADMIN' && (
              <div className="hidden md:flex items-center space-x-1 bg-slate-900/80 p-1 rounded-xl border border-white/10 ml-6">
                <button
                  onClick={() => setActiveTab('viewer')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                    activeTab === 'viewer'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Màn Hình Xem (Viewer)
                </button>
                <button
                  onClick={() => setActiveTab('admin')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center space-x-1 transition-all ${
                    activeTab === 'admin'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Shield className="w-3.5 h-3.5 mr-1" />
                  Quản Lý Admin
                </button>
              </div>
            )}
          </div>

          {/* User Info & Logout */}
          <div className="flex items-center space-x-2 sm:space-x-3">
            <div className="hidden sm:flex flex-col items-end text-xs">
              <div className="flex items-center space-x-1.5">
                <span className="font-bold text-slate-200">{user.username}</span>
                <span className="px-2 py-0.5 rounded text-[10px] bg-indigo-500/20 text-indigo-300 font-mono">
                  {user.role}
                </span>
              </div>
              <span className="text-slate-400 flex items-center text-[10px]">
                <Calendar className="w-3 h-3 mr-1 text-slate-500" />
                Hạn: {new Date(user.expiresAt).toLocaleDateString('vi-VN')}
              </span>
            </div>

            <button
              onClick={onLogout}
              className="p-2 sm:px-3 sm:py-2 rounded-xl bg-slate-800 hover:bg-red-600/20 hover:text-red-300 text-slate-400 border border-white/10 transition-all flex items-center space-x-1 text-xs active:scale-95"
              title="Đăng xuất"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Đăng xuất</span>
            </button>
          </div>
        </div>

        {/* Mobile Sub Navigation Bar for ADMIN users */}
        {user.role === 'ADMIN' && (
          <div className="flex md:hidden items-center justify-center space-x-2 py-2 border-t border-white/5">
            <button
              onClick={() => setActiveTab('viewer')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-bold flex items-center justify-center space-x-1 transition-all ${
                activeTab === 'viewer'
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'bg-slate-900/60 text-slate-400 border border-white/5'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Viewer</span>
            </button>
            <button
              onClick={() => setActiveTab('admin')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-bold flex items-center justify-center space-x-1 transition-all ${
                activeTab === 'admin'
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'bg-slate-900/60 text-slate-400 border border-white/5'
              }`}
            >
              <Shield className="w-3.5 h-3.5" />
              <span>Admin</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
};

