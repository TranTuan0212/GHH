import React, { useState, useEffect, useRef } from 'react';
import { User, GpsLog, StreamSession } from '../types';
import {
  Users,
  UserPlus,
  Shield,
  Smartphone,
  Calendar,
  Lock,
  Unlock,
  RefreshCw,
  Trash2,
  MapPin,
  Clock,
  CheckCircle,
  AlertCircle,
  Key,
  Upload,
  Download,
  FileText
} from 'lucide-react';

interface AdminDashboardProps {
  users: User[];
  currentGps: GpsLog | null;
  activeStream: StreamSession | null;
  token: string;
  onRefreshUsers: () => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  users,
  currentGps,
  activeStream,
  token,
  onRefreshUsers
}) => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDays, setNewDays] = useState(30);
  const [newRole, setNewRole] = useState<'USER' | 'ADMIN'>('USER');

  const [renewDays, setRenewDays] = useState<{ [userId: string]: number }>({});
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Quản lý file IPA & Chứng chỉ
  interface AppFile {
    name: string;
    size: number;
    sizeFormatted: string;
    updatedAt: string;
    isIpa: boolean;
    isCert: boolean;
  }
  const [appFiles, setAppFiles] = useState<AppFile[]>([]);
  const [uploadingFile, setUploadingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchAppFiles = async () => {
    try {
      const res = await fetch('/api/admin/app-files', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.files) setAppFiles(data.files);
    } catch {}
  };

  useEffect(() => {
    fetchAppFiles();
  }, [token]);

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingFile(true);
    try {
      const res = await fetch(`/api/admin/upload-app-file?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream'
        },
        body: file
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showMsg(data.message, 'success');
      fetchAppFiles();
    } catch (err: any) {
      showMsg(err.message, 'error');
    } finally {
      setUploadingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDeleteAppFile = async (filename: string) => {
    if (!window.confirm(`Bạn có chắc chắn muốn xóa file "${filename}" khỏi server không?`)) return;
    try {
      const res = await fetch(`/api/admin/app-files/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showMsg(data.message, 'success');
      fetchAppFiles();
    } catch (err: any) {
      showMsg(err.message, 'error');
    }
  };

  // Reset mật khẩu modal
  const [resetPwModal, setResetPwModal] = useState<{ userId: string; username: string } | null>(null);
  const [resetPwValue, setResetPwValue] = useState('');
  const [resetPwLoading, setResetPwLoading] = useState(false);

  const showMsg = (text: string, type: 'success' | 'error') => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  };

  // Create User
  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername || !newPassword) return;

    setLoading(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          username: newUsername,
          password: newPassword,
          daysValid: newDays,
          role: newRole
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Tạo tài khoản thất bại.');

      showMsg('Tạo tài khoản mới thành công!', 'success');
      setShowCreateModal(false);
      setNewUsername('');
      setNewPassword('');
      onRefreshUsers();
    } catch (err: any) {
      showMsg(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  // Renew User
  const handleRenew = async (userId: string) => {
    const days = renewDays[userId] || 30;
    try {
      const res = await fetch(`/api/admin/users/${userId}/renew`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ days })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showMsg(data.message, 'success');
      onRefreshUsers();
    } catch (err: any) {
      showMsg(err.message, 'error');
    }
  };

  // Toggle Block
  const handleToggleBlock = async (userId: string) => {
    try {
      const res = await fetch(`/api/admin/users/${userId}/toggle-block`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showMsg(data.message, 'success');
      onRefreshUsers();
    } catch (err: any) {
      showMsg(err.message, 'error');
    }
  };

  // Reset Device
  const handleResetDevice = async (userId: string) => {
    if (!window.confirm('Bạn có chắc chắn muốn Reset gán thiết bị điện thoại cho User này không?')) return;
    try {
      const res = await fetch(`/api/admin/users/${userId}/reset-device`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showMsg(data.message, 'success');
      onRefreshUsers();
    } catch (err: any) {
      showMsg(err.message, 'error');
    }
  };

  // Delete User
  const handleDeleteUser = async (userId: string) => {
    if (!window.confirm('Bạn có chắc chắn muốn xóa vĩnh viễn tài khoản này không?')) return;
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showMsg(data.message, 'success');
      onRefreshUsers();
    } catch (err: any) {
      showMsg(err.message, 'error');
    }
  };

  // Reset Password
  const handleResetPassword = async () => {
    if (!resetPwModal || !resetPwValue || resetPwValue.length < 6) return;
    setResetPwLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${resetPwModal.userId}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ newPassword: resetPwValue })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showMsg(data.message, 'success');
      setResetPwModal(null);
      setResetPwValue('');
    } catch (err: any) {
      showMsg(err.message, 'error');
    } finally {
      setResetPwLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {message && (
        <div
          className={`p-4 rounded-xl text-sm font-medium flex items-center space-x-2 shadow-lg transition-all ${
            message.type === 'success'
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
              : 'bg-red-500/20 text-red-300 border border-red-500/30'
          }`}
        >
          {message.type === 'success' ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
          <span>{message.text}</span>
        </div>
      )}

      {/* Top Admin Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Total Users */}
        <div className="glass-panel p-5 rounded-2xl border border-indigo-500/20 flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400 font-medium">Tổng số tài khoản</p>
            <h3 className="text-2xl font-extrabold text-white mt-1">{users.length} User</h3>
          </div>
          <div className="p-3 rounded-2xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30">
            <Users className="w-6 h-6" />
          </div>
        </div>

        {/* Stream Status */}
        <div className="glass-panel p-5 rounded-2xl border border-indigo-500/20 flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400 font-medium">Trạng thái phát Live Stream</p>
            <h3 className="text-2xl font-extrabold text-emerald-400 mt-1 flex items-center gap-2">
              {activeStream ? (
                <>
                  <span className="w-3 h-3 rounded-full bg-red-500 animate-ping inline-block" />
                  Đang Live (240fps)
                </>
              ) : (
                <span className="text-slate-400 text-lg">Đang dừng phát</span>
              )}
            </h3>
          </div>
          <div className="p-3 rounded-2xl bg-emerald-600/20 text-emerald-400 border border-emerald-500/30">
            <Shield className="w-6 h-6" />
          </div>
        </div>

        {/* GPS Streamer Location */}
        <div className="glass-panel p-5 rounded-2xl border border-indigo-500/20 flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400 font-medium">Định vị GPS Thiết bị Live</p>
            <p className="text-sm font-bold text-amber-300 mt-1 flex items-center">
              <MapPin className="w-4 h-4 mr-1 text-amber-400" />
              {currentGps ? `${currentGps.lat.toFixed(4)}, ${currentGps.lng.toFixed(4)}` : 'Chưa có dữ liệu GPS'}
            </p>
          </div>
          <div className="p-3 rounded-2xl bg-amber-600/20 text-amber-400 border border-amber-500/30">
            <MapPin className="w-6 h-6" />
          </div>
        </div>
      </div>

      {/* Quản lý File App iOS (.IPA) & Chứng chỉ */}
      <div className="glass-panel rounded-2xl p-5 border border-indigo-500/20 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 pb-3">
          <div className="flex items-center space-x-2.5">
            <div className="p-2.5 rounded-xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-bold text-white flex items-center gap-2">
                Quản Lý File Cài Đặt App iOS & Chứng Chỉ
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 font-mono font-bold border border-indigo-500/30">
                  OTA itms-services
                </span>
              </h2>
              <p className="text-[11px] text-slate-400">
                Tải lên file <strong className="text-slate-300">.IPA</strong> (đã ký chứng chỉ) hoặc file chứng chỉ <strong className="text-slate-300">.mobileprovision / .p12 / .cer</strong> để người dùng cài trực tiếp từ web.
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".ipa,.mobileprovision,.p12,.cer,.plist"
              onChange={handleUploadFile}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingFile}
              className="px-3.5 py-1.5 sm:py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold text-xs flex items-center space-x-1.5 shadow-lg shadow-indigo-600/30 transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              <span>{uploadingFile ? 'Đang tải lên...' : 'Upload File .IPA / Chứng chỉ'}</span>
            </button>
          </div>
        </div>

        {/* Danh sách file trong folder app */}
        <div className="space-y-2">
          {appFiles.length === 0 ? (
            <div className="p-4 rounded-xl bg-slate-900/60 border border-white/5 text-center text-xs text-slate-500 italic">
              Chưa có file nào trong thư mục app. Bấm nút "Upload File .IPA / Chứng chỉ" ở trên để tải file lên.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {appFiles.map((file) => (
                <div
                  key={file.name}
                  className="bg-slate-900/90 p-3 rounded-xl border border-white/10 flex items-center justify-between space-x-2 text-xs hover:border-indigo-500/40 transition-all"
                >
                  <div className="flex items-center space-x-2.5 min-w-0">
                    <div className={`p-2 rounded-lg flex-shrink-0 ${
                      file.isIpa
                        ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                        : file.isCert
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : 'bg-slate-800 text-slate-400 border border-white/10'
                    }`}>
                      {file.isIpa ? <Smartphone className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                    </div>
                    <div className="min-w-0">
                      <p className="font-mono font-bold text-white truncate text-xs" title={file.name}>
                        {file.name}
                      </p>
                      <p className="text-[10px] text-slate-400">
                        {file.sizeFormatted} • {new Date(file.updatedAt).toLocaleDateString('vi-VN')}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-1 flex-shrink-0">
                    <a
                      href={`/ios/${encodeURIComponent(file.name)}`}
                      download={file.name}
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-all"
                      title="Tải về máy kiểm tra"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </a>
                    <button
                      onClick={() => handleDeleteAppFile(file.name)}
                      className="p-1.5 rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-300 transition-all"
                      title="Xóa file này"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Main Users Table Section */}
      <div className="glass-panel rounded-2xl p-6 border border-indigo-500/20 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/5 pb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-100">Quản lý Tài khoản & Phân quyền Thời hạn</h2>
            <p className="text-xs text-slate-400">
              Admin tạo tài khoản, đặt ngày hết hạn, khóa/mở khóa và reset gán thiết bị di động (Requirement 7 & 8a)
            </p>
          </div>

          <button
            onClick={() => setShowCreateModal(true)}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm shadow-lg shadow-indigo-600/30 flex items-center space-x-2 transition-all"
          >
            <UserPlus className="w-4 h-4" />
            <span>Tạo Tài Khoản Mới</span>
          </button>
        </div>

        {/* Users Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-900/80 text-xs font-semibold uppercase tracking-wider text-slate-400 border-b border-white/5">
              <tr>
                <th className="py-3 px-4">Tài khoản</th>
                <th className="py-3 px-4">Quyền</th>
                <th className="py-3 px-4">Ngày Hết Hạn</th>
                <th className="py-3 px-4">Thiết Bị Gán Live</th>
                <th className="py-3 px-4">Trạng Thái</th>
                <th className="py-3 px-4 text-right">Thao Tác Admin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {users.map((u) => {
                const liveDevice = u.devices?.find((d) => d.isLiveDevice);
                const isExpired = new Date(u.expiresAt) < new Date();

                return (
                  <tr key={u.id} className="hover:bg-slate-800/40 transition-all">
                    <td className="py-3.5 px-4 font-bold text-white font-mono flex items-center space-x-2">
                      <span>{u.username}</span>
                      {u.role === 'ADMIN' && (
                        <span className="px-2 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30">
                          ADMIN
                        </span>
                      )}
                    </td>

                    <td className="py-3.5 px-4">
                      <span className="text-xs px-2.5 py-1 rounded-full bg-slate-800 text-slate-300 border border-white/5">
                        {u.role}
                      </span>
                    </td>

                    <td className="py-3.5 px-4 font-mono text-xs">
                      <div className="flex items-center space-x-1.5">
                        <Calendar className="w-3.5 h-3.5 text-indigo-400" />
                        <span className={isExpired ? 'text-red-400 font-bold' : 'text-slate-300'}>
                          {new Date(u.expiresAt).toLocaleDateString('vi-VN')}
                        </span>
                      </div>
                    </td>

                    <td className="py-3.5 px-4 text-xs font-mono">
                      {liveDevice ? (
                        <div className="flex items-center space-x-1.5 text-emerald-400">
                          <Smartphone className="w-3.5 h-3.5" />
                          <span title={liveDevice.deviceUuid}>
                            {liveDevice.deviceModel} ({liveDevice.deviceUuid.substring(0, 8)}...)
                          </span>
                        </div>
                      ) : (
                        <span className="text-slate-500 italic">Chưa gán iPhone</span>
                      )}
                    </td>

                    <td className="py-3.5 px-4">
                      {u.isBlocked ? (
                        <span className="px-2.5 py-1 rounded-full bg-red-500/20 text-red-300 border border-red-500/30 text-xs font-bold">
                          Đã Khóa
                        </span>
                      ) : isExpired ? (
                        <span className="px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-bold">
                          Hết Hạn
                        </span>
                      ) : (
                        <span className="px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold">
                          Hoạt Động
                        </span>
                      )}
                    </td>

                    <td className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end space-x-2">
                        {/* Renew days input */}
                        <div className="flex items-center space-x-1">
                          <input
                            type="number"
                            min={1}
                            placeholder="Số ngày"
                            value={renewDays[u.id] || 30}
                            onChange={(e) =>
                              setRenewDays({ ...renewDays, [u.id]: parseInt(e.target.value) || 30 })
                            }
                            className="w-16 px-2 py-1 rounded bg-slate-900 border border-white/10 text-xs font-mono text-center text-white"
                          />
                          <button
                            onClick={() => handleRenew(u.id)}
                            className="px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all"
                            title="Gia hạn thời gian sử dụng"
                          >
                            Gia Hạn
                          </button>
                        </div>

                        {/* Reset Device Binding */}
                        {liveDevice && (
                          <button
                            onClick={() => handleResetDevice(u.id)}
                            className="p-1.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 transition-all"
                            title="Reset thiết bị di động đã gán"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                        )}

                        {/* Toggle Block */}
                        <button
                          onClick={() => handleToggleBlock(u.id)}
                          className={`p-1.5 rounded border transition-all ${
                            u.isBlocked
                              ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                              : 'bg-red-500/20 text-red-300 border-red-500/30'
                          }`}
                          title={u.isBlocked ? 'Mở khóa' : 'Khóa tài khoản'}
                        >
                          {u.isBlocked ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                        </button>

                        {/* Reset Password */}
                        <button
                          onClick={() => { setResetPwModal({ userId: u.id, username: u.username }); setResetPwValue(''); }}
                          className="p-1.5 rounded bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/30 transition-all"
                          title="Reset mật khẩu"
                        >
                          <Key className="w-3.5 h-3.5" />
                        </button>

                        {/* Delete User */}
                        {u.role !== 'ADMIN' && (
                          <button
                            onClick={() => handleDeleteUser(u.id)}
                            className="p-1.5 rounded bg-red-600/20 hover:bg-red-600/40 text-red-300 border border-red-500/30 transition-all"
                            title="Xóa tài khoản"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create User Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 z-50">
          <div className="glass-panel max-w-sm sm:max-w-md w-full p-4 sm:p-5 rounded-2xl border border-indigo-500/30 space-y-3 shadow-2xl">
            <h3 className="text-base sm:text-lg font-bold text-white">Tạo Tài Khoản Mới</h3>
            <form onSubmit={handleCreateUser} className="space-y-3">
              <div>
                <label className="block text-[11px] sm:text-xs font-semibold text-slate-300 mb-1">Tên Tài Khoản</label>
                <input
                  type="text"
                  required
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-white font-mono text-xs sm:text-sm focus:border-indigo-500 outline-none"
                  placeholder="nhap_user_name"
                />
              </div>

              <div>
                <label className="block text-[11px] sm:text-xs font-semibold text-slate-300 mb-1">Mật Khẩu</label>
                <input
                  type="password"
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-white font-mono text-xs sm:text-sm focus:border-indigo-500 outline-none"
                  placeholder="******"
                />
              </div>

              <div>
                <label className="block text-[11px] sm:text-xs font-semibold text-slate-300 mb-1">
                  Hạn Sử Dụng Ban Đầu (Số Ngày)
                </label>
                <input
                  type="number"
                  required
                  min={1}
                  value={newDays}
                  onChange={(e) => setNewDays(parseInt(e.target.value))}
                  className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-white font-mono text-xs sm:text-sm focus:border-indigo-500 outline-none"
                />
              </div>

              <div className="flex items-center justify-end space-x-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-3.5 py-1.5 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs sm:text-sm font-semibold transition-all"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs sm:text-sm shadow-lg shadow-indigo-600/30 transition-all"
                >
                  {loading ? 'Đang tạo...' : 'Tạo Tài Khoản'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {resetPwModal && (
        <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 z-50">
          <div className="glass-panel max-w-sm w-full p-4 sm:p-5 rounded-2xl border border-sky-500/30 space-y-3 shadow-2xl">
            <h3 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
              <Key className="w-4 h-4 sm:w-5 sm:h-5 text-sky-400" />
              Reset Mật Khẩu
            </h3>
            <p className="text-xs sm:text-sm text-slate-400">
              Đặt mật khẩu mới cho tài khoản <strong className="text-white font-mono">{resetPwModal.username}</strong>
            </p>
            <input
              type="password"
              autoFocus
              value={resetPwValue}
              onChange={(e) => setResetPwValue(e.target.value)}
              placeholder="Mật khẩu mới (ít nhất 6 ký tự)"
              className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-white font-mono text-xs sm:text-sm focus:border-sky-500 outline-none"
            />
            <div className="flex items-center justify-end space-x-2.5 pt-1">
              <button
                onClick={() => { setResetPwModal(null); setResetPwValue(''); }}
                className="px-3.5 py-1.5 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs sm:text-sm font-semibold transition-all"
              >
                Hủy
              </button>
              <button
                onClick={handleResetPassword}
                disabled={resetPwLoading || resetPwValue.length < 6}
                className="px-4 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-bold text-xs sm:text-sm shadow-lg shadow-sky-600/30 transition-all"
              >
                {resetPwLoading ? 'Đang lưu...' : 'Xác nhận Reset'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
