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
  FileText,
  Eye,
  EyeOff,
  Archive,
  Terminal,
  HelpCircle,
  Sparkles,
  Copy,
  Check,
  Mic
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
    isZip?: boolean;
    isP12?: boolean;
    isProvision?: boolean;
    isCert: boolean;
  }
  const [appFiles, setAppFiles] = useState<AppFile[]>([]);
  const [zsignReady, setZsignReady] = useState(false);
  const [certSummary, setCertSummary] = useState<{
    hasP12: boolean;
    p12Files: string[];
    hasProvision: boolean;
    provFiles: string[];
    hasIpa: boolean;
    ipaFiles: string[];
  }>({ hasP12: false, p12Files: [], hasProvision: false, provFiles: [], hasIpa: false, ipaFiles: [] });
  const [uploadingFile, setUploadingFile] = useState(false);
  const [p12Password, setP12Password] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signOutput, setSignOutput] = useState<string | null>(null);
  const [showZsignInstructions, setShowZsignInstructions] = useState(false);
  const [extractingZip, setExtractingZip] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchAppFiles = async () => {
    try {
      const res = await fetch('/api/admin/app-files', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.files) setAppFiles(data.files);
      if (typeof data.zsignReady === 'boolean') setZsignReady(data.zsignReady);
      if (data.certSummary) setCertSummary(data.certSummary);
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

  const handleExtractZip = async (zipFilename: string) => {
    setExtractingZip(true);
    try {
      const res = await fetch(`/api/admin/extract-zip/${encodeURIComponent(zipFilename)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showMsg(data.message, 'success');
      fetchAppFiles();
    } catch (err: any) {
      showMsg(err.message, 'error');
    } finally {
      setExtractingZip(false);
    }
  };

  const handleSignIpa = async () => {
    if (!p12Password.trim()) {
      showMsg('Vui lòng nhập mật khẩu của file chứng chỉ .p12', 'error');
      return;
    }
    setSigning(true);
    setSignOutput(null);
    try {
      const res = await fetch('/api/admin/sign-ipa', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ p12Password: p12Password.trim() })
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.details) setSignOutput(data.details);
        if (data.needsZsignInstall) setShowZsignInstructions(true);
        throw new Error(data.error || 'Ký app thất bại.');
      }

      showMsg(data.message, 'success');
      if (data.output) setSignOutput(data.output);
      fetchAppFiles();
    } catch (err: any) {
      showMsg(err.message, 'error');
    } finally {
      setSigning(false);
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

  // Reset Device (hỗ trợ reset riêng Live hoặc Nhập)
  const handleResetDevice = async (userId: string, appType?: 'APP_LIVE' | 'APP_INPUT') => {
    const label = appType === 'APP_LIVE' ? 'máy Live' : appType === 'APP_INPUT' ? 'máy Nhập' : 'toàn bộ thiết bị';
    if (!window.confirm(`Bạn có chắc chắn muốn Reset gán ${label} cho User này không?`)) return;
    try {
      const res = await fetch(`/api/admin/users/${userId}/reset-device`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ appType })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showMsg(data.message, 'success');
      onRefreshUsers();
    } catch (err: any) {
      showMsg(err.message, 'error');
    }
  };

  // Voice Licenses State
  interface VoiceLicItem {
    id: string;
    deviceFingerprint: string;
    deviceModel: string;
    licenseKey: string;
    registeredAt: string;
    expiresAt: string;
    isLifetime: boolean;
    isUsed: boolean;
    isExpired: boolean;
    status: string;
    activatedAt?: string;
  }
  const [voiceLicenses, setVoiceLicenses] = useState<VoiceLicItem[]>([]);
  const [voiceFp, setVoiceFp] = useState('');
  const [voiceDuration, setVoiceDuration] = useState('30');
  const [voiceModel, setVoiceModel] = useState('');
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [createdKeyResult, setCreatedKeyResult] = useState<any>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const fetchVoiceLicenses = async () => {
    try {
      const res = await fetch('/api/license/admin/list', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok && data.licenses) {
        setVoiceLicenses(data.licenses);
      }
    } catch {}
  };

  useEffect(() => {
    fetchVoiceLicenses();
  }, [token]);

  const handleCreateVoiceKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!voiceFp.trim()) return;
    setVoiceLoading(true);
    try {
      const res = await fetch('/api/license/admin/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          deviceFingerprint: voiceFp.trim(),
          daysValid: voiceDuration === 'LIFETIME' ? -1 : parseInt(voiceDuration),
          deviceModel: voiceModel.trim() || undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setCreatedKeyResult(data);
      showMsg('Tạo Key kích hoạt giọng nói thành công!', 'success');
      setVoiceFp('');
      setVoiceModel('');
      fetchVoiceLicenses();
    } catch (err: any) {
      showMsg(err.message, 'error');
    } finally {
      setVoiceLoading(false);
    }
  };

  const handleDeleteVoiceLicense = async (id: string) => {
    if (!window.confirm('Bạn có chắc chắn muốn xóa bản quyền này?')) return;
    try {
      const res = await fetch(`/api/license/admin/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showMsg('Đã xóa bản quyền thành công.', 'success');
      fetchVoiceLicenses();
    } catch (err: any) {
      showMsg(err.message, 'error');
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(id);
    setTimeout(() => setCopiedKey(null), 2500);
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

      {/* Quản lý File App iOS (.IPA) & Chứng chỉ Doanh Nghiệp */}
      <div className="glass-panel rounded-2xl p-5 border border-indigo-500/20 space-y-4">
        {/* Header section */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 pb-3">
          <div className="flex items-center space-x-2.5">
            <div className="p-2.5 rounded-xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-bold text-white flex items-center gap-2">
                Quản Lý File Cài Đặt App iOS & Ký Chứng Chỉ Doanh Nghiệp
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 font-mono font-bold border border-indigo-500/30">
                  OTA itms-services
                </span>
              </h2>
              <p className="text-[11px] text-slate-400">
                Tải lên file <strong className="text-slate-300">.IPA</strong>, file <strong className="text-slate-300">.ZIP chứng chỉ</strong> (hoặc .p12 & .mobileprovision), sau đó nhập mật khẩu để Server tự động ký app.
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".ipa,.zip,.mobileprovision,.p12,.cer,.plist"
              onChange={handleUploadFile}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingFile}
              className="px-3.5 py-1.5 sm:py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold text-xs flex items-center space-x-1.5 shadow-lg shadow-indigo-600/30 transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              <span>{uploadingFile ? 'Đang tải lên...' : 'Tải lên File (.IPA / .ZIP / Cert)'}</span>
            </button>
          </div>
        </div>

        {/* Khung Tự Động Ký App Doanh Nghiệp (Auto-Sign với zsign) */}
        <div className="p-4 rounded-xl bg-gradient-to-br from-slate-900/90 to-indigo-950/40 border border-indigo-500/30 space-y-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center space-x-2">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <span className="text-xs font-bold text-white uppercase tracking-wider">
                Tự Động Ký Chứng Chỉ Doanh Nghiệp (Auto-Sign)
              </span>
            </div>

            <div className="flex items-center space-x-2">
              {zsignReady ? (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" /> zsign: Sẵn sàng
                </span>
              ) : (
                <button
                  onClick={() => setShowZsignInstructions(!showZsignInstructions)}
                  className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1 hover:bg-amber-500/30 transition-all cursor-pointer"
                  title="Bấm để xem hướng dẫn cài đặt zsign trên VPS"
                >
                  <AlertCircle className="w-3 h-3" /> zsign: Chưa cài trên VPS (Bấm xem lệnh)
                </button>
              )}
            </div>
          </div>

          {/* Hướng dẫn cài đặt zsign trên VPS nếu chưa có */}
          {(!zsignReady || showZsignInstructions) && (
            <div className="p-3 rounded-lg bg-black/60 border border-amber-500/30 space-y-2 text-[11px]">
              <div className="flex items-center justify-between text-amber-300 font-semibold">
                <span className="flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5" /> Lệnh 1-dòng cài đặt zsign trên VPS Ubuntu/Debian:
                </span>
                <button
                  onClick={() => setShowZsignInstructions(false)}
                  className="text-slate-400 hover:text-white text-[10px]"
                >
                  Đóng
                </button>
              </div>
              <div className="bg-slate-950 p-2.5 rounded font-mono text-[10px] text-slate-300 overflow-x-auto select-all border border-white/5">
                apt-get install -y pkg-config && cd /tmp/zsign/build/linux && make clean && make && cp /tmp/zsign/bin/zsign /usr/local/bin/zsign && cd /var/www/liveapp
              </div>
              <p className="text-[10px] text-slate-400 italic">
                * Copy câu lệnh trên dán vào terminal SSH VPS một lần duy nhất, sau đó tải lại trang này zsign sẽ chuyển sang màu xanh "Sẵn sàng".
              </p>
            </div>
          )}

          {/* Trạng thái các thành phần đã phát hiện */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
            {/* File IPA */}
            <div className={`p-2.5 rounded-lg border flex items-center justify-between ${
              certSummary.hasIpa ? 'bg-indigo-950/30 border-indigo-500/30 text-indigo-300' : 'bg-slate-900/50 border-white/5 text-slate-400'
            }`}>
              <div className="truncate">
                <p className="text-[10px] text-slate-400 uppercase font-semibold">1. File IPA Gốc</p>
                <p className="font-mono font-bold truncate text-[11px] text-white">
                  {certSummary.hasIpa ? certSummary.ipaFiles[0] : 'Chưa có file .ipa'}
                </p>
              </div>
              {certSummary.hasIpa ? <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 text-slate-500 flex-shrink-0" />}
            </div>

            {/* File P12 */}
            <div className={`p-2.5 rounded-lg border flex items-center justify-between ${
              certSummary.hasP12 ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-300' : 'bg-slate-900/50 border-white/5 text-slate-400'
            }`}>
              <div className="truncate">
                <p className="text-[10px] text-slate-400 uppercase font-semibold">2. Chứng chỉ (.P12)</p>
                <p className="font-mono font-bold truncate text-[11px] text-white">
                  {certSummary.hasP12 ? certSummary.p12Files[0] : (appFiles.some(f => f.isZip) ? 'Có trong file Zip' : 'Chưa có file .p12')}
                </p>
              </div>
              {certSummary.hasP12 || appFiles.some(f => f.isZip) ? (
                <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-slate-500 flex-shrink-0" />
              )}
            </div>

            {/* File Provision */}
            <div className={`p-2.5 rounded-lg border flex items-center justify-between ${
              certSummary.hasProvision ? 'bg-blue-950/30 border-blue-500/30 text-blue-300' : 'bg-slate-900/50 border-white/5 text-slate-400'
            }`}>
              <div className="truncate">
                <p className="text-[10px] text-slate-400 uppercase font-semibold">3. Hồ sơ (.mobileprovision)</p>
                <p className="font-mono font-bold truncate text-[11px] text-white">
                  {certSummary.hasProvision ? certSummary.provFiles[0] : (appFiles.some(f => f.isZip) ? 'Có trong file Zip' : 'Chưa có profile')}
                </p>
              </div>
              {certSummary.hasProvision || appFiles.some(f => f.isZip) ? (
                <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-slate-500 flex-shrink-0" />
              )}
            </div>
          </div>

          {/* Ô nhập mật khẩu P12 và nút Ký App */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-1">
            <div className="relative flex-1">
              <Key className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Nhập Mật khẩu file chứng chỉ .p12 (ví dụ: 123456 hoặc 1)..."
                value={p12Password}
                onChange={(e) => setP12Password(e.target.value)}
                className="w-full pl-9 pr-10 py-2 rounded-xl bg-slate-950/80 border border-white/10 text-white placeholder-slate-500 text-xs focus:outline-none focus:border-indigo-500 transition-all font-mono"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
              >
                {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>

            <button
              onClick={handleSignIpa}
              disabled={signing || !p12Password.trim() || !certSummary.hasIpa}
              className="px-5 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs flex items-center justify-center space-x-2 shadow-lg shadow-emerald-600/30 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex-shrink-0"
            >
              {signing ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Đang Ký App (zsign)...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>🚀 Ký & Đóng Gói App Ngay</span>
                </>
              )}
            </button>
          </div>

          {/* Log kết quả ký */}
          {signOutput && (
            <div className="p-3 rounded-lg bg-black/70 border border-white/10 space-y-1 text-xs">
              <div className="flex items-center justify-between text-slate-400 text-[10px]">
                <span className="flex items-center gap-1 font-semibold text-slate-300">
                  <Terminal className="w-3 h-3" /> Chi tiết quá trình ký (zsign log):
                </span>
                <button
                  onClick={() => setSignOutput(null)}
                  className="hover:text-white"
                >
                  Ẩn
                </button>
              </div>
              <pre className="p-2 rounded bg-slate-950 font-mono text-[10px] text-slate-300 max-h-36 overflow-y-auto whitespace-pre-wrap">
                {signOutput}
              </pre>
            </div>
          )}
        </div>

        {/* Danh sách file trong folder app */}
        <div className="space-y-2">
          <p className="text-xs font-bold text-slate-300 flex items-center justify-between">
            <span>Danh Sách File Trong Thư Mục Cài Đặt (app/):</span>
            <span className="text-[10px] text-slate-400 font-normal">{appFiles.length} file</span>
          </p>

          {appFiles.length === 0 ? (
            <div className="p-4 rounded-xl bg-slate-900/60 border border-white/5 text-center text-xs text-slate-500 italic">
              Chưa có file nào trong thư mục app. Bấm nút "Tải lên File (.IPA / .ZIP / Cert)" ở trên để tải file lên.
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
                        : file.isZip
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        : file.isP12
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : file.isProvision
                        ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                        : 'bg-slate-800 text-slate-400 border border-white/10'
                    }`}>
                      {file.isIpa ? (
                        <Smartphone className="w-4 h-4" />
                      ) : file.isZip ? (
                        <Archive className="w-4 h-4" />
                      ) : (
                        <FileText className="w-4 h-4" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="font-mono font-bold text-white truncate text-xs" title={file.name}>
                          {file.name}
                        </p>
                        <span className={`text-[9px] px-1.5 py-0.2 rounded font-bold uppercase ${
                          file.isIpa
                            ? 'bg-purple-500/20 text-purple-300'
                            : file.isZip
                            ? 'bg-amber-500/20 text-amber-300'
                            : file.isP12
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : file.isProvision
                            ? 'bg-blue-500/20 text-blue-300'
                            : 'bg-slate-800 text-slate-400'
                        }`}>
                          {file.isIpa ? 'IPA' : file.isZip ? 'ZIP' : file.isP12 ? 'P12' : file.isProvision ? 'PROFILE' : 'FILE'}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-400">
                        {file.sizeFormatted} • {new Date(file.updatedAt).toLocaleDateString('vi-VN')}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-1 flex-shrink-0">
                    {file.isZip && (
                      <button
                        onClick={() => handleExtractZip(file.name)}
                        disabled={extractingZip}
                        className="p-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 transition-all cursor-pointer"
                        title="Giải nén file zip này"
                      >
                        <Archive className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <a
                      href={`/ios/${encodeURIComponent(file.name)}`}
                      download={file.name}
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-all cursor-pointer"
                      title="Tải về máy"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </a>
                    <button
                      onClick={() => handleDeleteAppFile(file.name)}
                      className="p-1.5 rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-300 transition-all cursor-pointer"
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
                <th className="py-3 px-4">Thiết Bị (1 Live + 2 Nhập)</th>
                <th className="py-3 px-4">Trạng Thái</th>
                <th className="py-3 px-4 text-right">Thao Tác Admin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {users.map((u) => {
                const liveDevice = u.devices?.find((d) => d.isLiveDevice || d.appType === 'APP_LIVE');
                const inputDevices = u.devices?.filter((d) => d.appType === 'APP_INPUT') || [];
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

                    <td className="py-3.5 px-4 text-xs font-mono space-y-2">
                      {/* Live Device: Tối đa 1 máy */}
                      <div className="flex items-center justify-between bg-slate-900/60 p-1.5 rounded-lg border border-white/5">
                        <div className="flex items-center space-x-1.5 overflow-hidden">
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                            LIVE
                          </span>
                          {liveDevice ? (
                            <span className="text-emerald-400 font-semibold truncate text-[11px]" title={liveDevice.deviceUuid}>
                              {liveDevice.deviceModel} ({liveDevice.deviceUuid.substring(0, 6)}...)
                            </span>
                          ) : (
                            <span className="text-slate-500 italic text-[11px]">Trống</span>
                          )}
                        </div>
                        {liveDevice && (
                          <button
                            onClick={() => handleResetDevice(u.id, 'APP_LIVE')}
                            className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 transition-all ml-1 shrink-0"
                            title="Reset máy Live"
                          >
                            Reset
                          </button>
                        )}
                      </div>

                      {/* Input Devices: Tối đa 2 máy */}
                      <div className="flex items-center justify-between bg-slate-900/60 p-1.5 rounded-lg border border-white/5">
                        <div className="flex flex-col space-y-0.5 overflow-hidden">
                          <div className="flex items-center space-x-1.5">
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30">
                              NHẬP ({inputDevices.length}/2)
                            </span>
                            {inputDevices.length === 0 && (
                              <span className="text-slate-500 italic text-[11px]">Trống</span>
                            )}
                          </div>
                          {inputDevices.map((d, idx) => (
                            <span key={d.id || idx} className="text-purple-300 text-[11px] font-mono truncate" title={d.deviceUuid}>
                              #{idx + 1} {d.deviceModel} ({d.deviceUuid.substring(0, 6)}...)
                            </span>
                          ))}
                        </div>
                        {inputDevices.length > 0 && (
                          <button
                            onClick={() => handleResetDevice(u.id, 'APP_INPUT')}
                            className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 transition-all ml-1 shrink-0"
                            title="Reset máy Nhập"
                          >
                            Reset
                          </button>
                        )}
                      </div>
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

      {/* 🎙️ Voice Licenses Management Section */}
      <div className="glass-panel p-4 sm:p-6 rounded-2xl border border-white/5 space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-white/5">
          <div>
            <h2 className="text-lg sm:text-xl font-bold text-white flex items-center space-x-2">
              <Mic className="w-5 h-5 text-indigo-400" />
              <span>Quản Lý Bản Quyền Giọng Nói (App Nhập Bài)</span>
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Admin tạo Key kích hoạt riêng biệt theo Mã định danh phần cứng của từng máy. Xác thực lần đầu cần mạng, sau đó dùng Offline 100%.
            </p>
          </div>
          <button
            onClick={fetchVoiceLicenses}
            className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center space-x-1.5 self-start md:self-auto transition-all"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Làm Mới</span>
          </button>
        </div>

        {/* Form Tạo Key Mới */}
        <form onSubmit={handleCreateVoiceKey} className="bg-slate-900/60 p-4 rounded-xl border border-white/5 space-y-3">
          <div className="text-xs font-bold text-indigo-300 uppercase tracking-wider flex items-center space-x-1.5">
            <Key className="w-4 h-4" />
            <span>Tạo Key Mở Giọng Nói Theo Máy</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                Mã Định Danh Máy (Device Fingerprint) *
              </label>
              <input
                type="text"
                required
                placeholder="AGI-XXXX-YYYY-ZZZZ-WWWW-CCCC"
                value={voiceFp}
                onChange={(e) => setVoiceFp(e.target.value.toUpperCase())}
                className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-white font-mono text-xs focus:border-indigo-500 outline-none"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                Tên Thiết Bị (Ghi nhớ model)
              </label>
              <input
                type="text"
                placeholder="VD: iPhone 13 Pro (Khách A)"
                value={voiceModel}
                onChange={(e) => setVoiceModel(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-white text-xs focus:border-indigo-500 outline-none"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                Thời Hạn Bản Quyền *
              </label>
              <select
                value={voiceDuration}
                onChange={(e) => setVoiceDuration(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-white text-xs focus:border-indigo-500 outline-none"
              >
                <option value="30">30 Ngày (1 Tháng)</option>
                <option value="90">90 Ngày (3 Tháng)</option>
                <option value="180">180 Ngày (6 Tháng)</option>
                <option value="365">365 Ngày (1 Năm)</option>
                <option value="LIFETIME">Vĩnh Viễn (Lifetime)</option>
              </select>
            </div>
          </div>

          <div className="flex items-center justify-end pt-1">
            <button
              type="submit"
              disabled={voiceLoading || !voiceFp.trim()}
              className="px-5 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold text-xs sm:text-sm shadow-lg shadow-indigo-600/30 flex items-center space-x-2 transition-all disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4" />
              <span>{voiceLoading ? 'Đang tạo Key...' : 'Tạo Key Bản Quyền'}</span>
            </button>
          </div>
        </form>

        {/* Kết quả Key vừa tạo */}
        {createdKeyResult && (
          <div className="p-4 rounded-xl bg-gradient-to-r from-emerald-950/60 to-slate-900 border border-emerald-500/40 flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
            <div>
              <div className="text-xs font-bold text-emerald-400 flex items-center space-x-1.5">
                <Check className="w-4 h-4" />
                <span>Đã Tạo Key Thành Công Cho Máy: {createdKeyResult.deviceModel}</span>
              </div>
              <div className="text-xs text-slate-300 mt-1">
                Hạn dùng: <strong className="text-white font-mono">{createdKeyResult.isLifetime ? 'Vĩnh viễn' : new Date(createdKeyResult.expiresAt).toLocaleDateString('vi-VN')}</strong>
              </div>
              <div className="mt-2 font-mono text-sm sm:text-base font-bold text-emerald-300 bg-slate-950/80 px-3 py-1.5 rounded-lg border border-emerald-500/30 select-all inline-block">
                {createdKeyResult.licenseKey}
              </div>
            </div>
            <button
              onClick={() => copyToClipboard(createdKeyResult.licenseKey, 'created')}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center space-x-1.5 transition-all shadow-lg shadow-emerald-600/30 self-stretch md:self-auto justify-center"
            >
              {copiedKey === 'created' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              <span>{copiedKey === 'created' ? 'Đã Sao Chép!' : 'Sao Chép Key'}</span>
            </button>
          </div>
        )}

        {/* Bảng Danh Sách License Key */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-900/80 text-xs font-semibold uppercase tracking-wider text-slate-400 border-b border-white/5">
              <tr>
                <th className="py-3 px-4">Thiết Bị</th>
                <th className="py-3 px-4">Mã Định Danh Máy</th>
                <th className="py-3 px-4">Key Bản Quyền</th>
                <th className="py-3 px-4">Ngày Cấp</th>
                <th className="py-3 px-4">Ngày Hết Hạn</th>
                <th className="py-3 px-4">Trạng Thái</th>
                <th className="py-3 px-4 text-right">Xóa</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {voiceLicenses.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-slate-500 italic">
                    Chưa có Key bản quyền nào được tạo.
                  </td>
                </tr>
              ) : (
                voiceLicenses.map((lic) => (
                  <tr key={lic.id} className="hover:bg-slate-800/40 transition-all font-mono text-xs">
                    <td className="py-3.5 px-4 font-sans font-semibold text-white">
                      {lic.deviceModel || 'iOS Device'}
                    </td>

                    <td className="py-3.5 px-4 font-mono text-purple-300">
                      <div className="flex items-center space-x-1">
                        <span title={lic.deviceFingerprint}>{lic.deviceFingerprint}</span>
                        <button
                          onClick={() => copyToClipboard(lic.deviceFingerprint, `fp-${lic.id}`)}
                          className="p-1 hover:text-white"
                          title="Sao chép mã máy"
                        >
                          {copiedKey === `fp-${lic.id}` ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                    </td>

                    <td className="py-3.5 px-4 font-mono text-amber-300 font-bold">
                      <div className="flex items-center space-x-1">
                        <span>{lic.licenseKey}</span>
                        <button
                          onClick={() => copyToClipboard(lic.licenseKey, `key-${lic.id}`)}
                          className="p-1 hover:text-white"
                          title="Sao chép Key"
                        >
                          {copiedKey === `key-${lic.id}` ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                    </td>

                    <td className="py-3.5 px-4 text-slate-400">
                      {new Date(lic.registeredAt).toLocaleDateString('vi-VN')}
                    </td>

                    <td className="py-3.5 px-4 font-bold">
                      {lic.isLifetime ? (
                        <span className="text-purple-400">Vĩnh viễn</span>
                      ) : (
                        <span className={lic.isExpired ? 'text-red-400' : 'text-slate-300'}>
                          {new Date(lic.expiresAt).toLocaleDateString('vi-VN')}
                        </span>
                      )}
                    </td>

                    <td className="py-3.5 px-4 font-sans">
                      {!lic.isUsed ? (
                        <span className="px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[11px] font-bold">
                          Chưa Kích Hoạt
                        </span>
                      ) : lic.isExpired ? (
                        <span className="px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 border border-red-500/30 text-[11px] font-bold">
                          Đã Hết Hạn
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[11px] font-bold">
                          Đang Hoạt Động
                        </span>
                      )}
                    </td>

                    <td className="py-3.5 px-4 text-right">
                      <button
                        onClick={() => handleDeleteVoiceLicense(lic.id)}
                        className="p-1.5 rounded bg-red-600/20 hover:bg-red-600/40 text-red-300 border border-red-500/30 transition-all"
                        title="Xóa Key"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
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
