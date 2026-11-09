import React, { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { User, StreamSession, GpsLog, CardEntry } from './types';
import { Navbar } from './components/Navbar';
import { LoginForm } from './components/LoginForm';
import { LivePlayer } from './components/LivePlayer';
import { AdminDashboard } from './components/AdminDashboard';
import { AlertTriangle, Clock, RefreshCw } from 'lucide-react';

export const App: React.FC = () => {
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<'viewer' | 'admin'>('viewer');

  const [activeStream, setActiveStream] = useState<StreamSession | null>(null);
  const [currentGps, setCurrentGps] = useState<GpsLog | null>(null);
  const [allUsers, setAllUsers] = useState<User[]>([]);

  const [socket, setSocket] = useState<Socket | null>(null);
  const [currentRoomId, setCurrentRoomId] = useState<string>('');
  const currentRoomIdRef = useRef<string>(currentRoomId);
  currentRoomIdRef.current = currentRoomId;
  const [finishRoundTrigger, setFinishRoundTrigger] = useState<number>(0);
  const [viewerBlocked, setViewerBlocked] = useState<boolean>(false);
  const [isVideoFullscreen, setIsVideoFullscreen] = useState<boolean>(false);
  

  
  // Set initial currentRoomId & sync allowedMode when user logs in
  useEffect(() => {
    if (user) {
      setCurrentRoomId(user.id);
    }
  }, [user]);

  // Initialize Socket.io and Room Joining
  useEffect(() => {
    if (!token) {
      if (socket) {
        socket.disconnect();
        setSocket(null);
      }
      return;
    }

    const host = window.location.hostname;
    const isTunnelOrHttps = host.includes('trycloudflare.com') || host.includes('ngrok') || window.location.protocol === 'https:';
    const defaultUrl = isTunnelOrHttps 
      ? `${window.location.protocol}//${host}` 
      : `${window.location.protocol}//${host}:4000`;
    const socketUrl = (import.meta as any).env?.VITE_API_URL || defaultUrl;
    const newSocket = io(socketUrl, {
      auth: { token }
    });
    setSocket(newSocket);

    newSocket.on('initial_state', (data) => {
      setActiveStream(data.activeStream);
      setCurrentGps(data.latestGps);
    });

    newSocket.on('gps_updated', (gpsLog: any) => {
      if (gpsLog?.userId && currentRoomIdRef.current && gpsLog.userId !== currentRoomIdRef.current) return;
      setCurrentGps(gpsLog);
    });

    newSocket.on('round_finished', (data) => {
      if (data?.roomId && currentRoomIdRef.current && data.roomId !== currentRoomIdRef.current) return;
      setFinishRoundTrigger((prev) => prev + 1);
      const targetRoom = data?.roomId || currentRoomIdRef.current;
      // Tự động kiểm tra luồng live hiện tại thay vì ép về null
      fetch(`/api/stream/active?roomId=${encodeURIComponent(targetRoom || '')}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
        .then((res) => res.json())
        .then((resp) => {
          if (resp && resp.stream && resp.stream.status === 'LIVE') {
            setActiveStream(resp.stream);
          }
        })
        .catch(() => {});
    });

    newSocket.on('stream_status_changed', (data) => {
      if (data?.roomId && currentRoomIdRef.current && data.roomId !== currentRoomIdRef.current) return;
      if (data?.session) {
        setActiveStream(data.session);
      } else if (data?.status === 'ENDED') {
        // Nếu sự kiện ENDED không kèm session mới, giữ lại stream hiện tại và cập nhật status sang ENDED
        // để người dùng vẫn xem lại được toàn bộ video replay/slow-mo mà không bị mất trắng.
        setActiveStream((prev) => (prev ? { ...prev, status: 'ENDED' } : prev));
      } else if (data?.status === 'IDLE') {
        // Chỉ xóa hoàn toàn khi Admin bấm "Xong phiên" (IDLE)
        setActiveStream(null);
      }
    });

    newSocket.on('viewer_limit_reached', () => {
      setViewerBlocked(true);
    });

    // Realtime: admin thay đổi tài khoản/bản quyền -> tự tải lại danh sách, không cần reload trang
    newSocket.on('users_changed', () => {
      if (token) fetchAdminUsers(token);
    });

    
    if (false) newSocket.on('_noop', () => {
      if (token) fetchAdminUsers(token);
    });

    // Tài khoản bị xóa/khóa/reset mật khẩu -> đăng xuất ngay
    newSocket.on('account_revoked', () => {
      handleLogout();
    });

    return () => {
      newSocket.disconnect();
    };
  }, [token]);

  // Join Room when socket or currentRoomId changes
  useEffect(() => {
    if (socket && currentRoomId) {
      setViewerBlocked(false); // Reset khi đổi phòng
            socket.emit('join_room', {
        roomId: currentRoomId
      });
    }
  }, [socket, currentRoomId]);

  // Tự động kiểm tra luồng Live mới mỗi 2.5s (tránh trường hợp socket bị rơi sự kiện hoặc phải reload trang)
  useEffect(() => {
    if (!token || !currentRoomId) return;
    let isCancelled = false;

    const checkActiveStream = () => {
      fetch('/api/stream/active?roomId=' + encodeURIComponent(currentRoomId), {
        headers: { Authorization: 'Bearer ' + token }
      })
        .then((r) => r.json())
        .then((data) => {
          if (isCancelled) return;
          if (data?.stream?.status === 'LIVE') {
            setActiveStream((prev) => {
              if (prev?.streamKey !== data.stream.streamKey || prev?.status !== 'LIVE') {
                return data.stream;
              }
              return prev;
            });
          }
        })
        .catch(() => {});
    };

    const interval = setInterval(checkActiveStream, 2500);
    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [token, currentRoomId]);

  // Fetch Current Auth User on Token change
  useEffect(() => {
    if (!token) {
      setUser(null);
      return;
    }

    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.user) {
          setUser(data.user);
          if (data.user.role === 'ADMIN') {
            fetchAdminUsers(token);
          }
        } else {
          handleLogout();
        }
      })
      .catch(() => handleLogout());
  }, [token]);

  const fetchAdminUsers = (authToken: string) => {
    fetch('/api/admin/users', {
      headers: { Authorization: `Bearer ${authToken}` }
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.users) {
          setAllUsers(data.users);
        }
      });
  };

  const handleLoginSuccess = (newToken: string, loggedUser: User) => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
    setUser(loggedUser);
    setCurrentRoomId(loggedUser.id);
    if (loggedUser.role === 'ADMIN') {
      fetchAdminUsers(newToken);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  };

  // Finish round callback (resets cards & DVR frame buffer for this room)
  const handleFinishRound = () => {
    const targetRoom = currentRoomIdRef.current || currentRoomId;
    if (socket) {
      socket.emit('finish_round', { roomId: targetRoom });
    }
    setFinishRoundTrigger((prev) => prev + 1);
    // Kiểm tra ngay luồng Live từ server
    fetch(`/api/stream/active?roomId=${encodeURIComponent(targetRoom)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data && data.stream && data.stream.status === 'LIVE') {
          setActiveStream(data.stream);
        } else if (activeStream?.status === 'ENDED') {
          setActiveStream(null);
        }
      })
      .catch(() => {});
  };

  if (!token || !user) {
    return <LoginForm onLoginSuccess={handleLoginSuccess} />;
  }

  const isExpired = new Date(user.expiresAt) < new Date();

  if (isExpired) {
    return (
      <div className="min-h-screen flex items-center justify-center p-2.5 sm:p-4 bg-dark-400 overflow-y-auto">
        <div className="glass-panel max-w-md w-full p-5 sm:p-8 rounded-3xl border border-red-500/30 text-center space-y-3.5 max-h-[92vh] overflow-y-auto overscroll-contain my-auto shadow-2xl">
          <AlertTriangle className="w-10 h-10 sm:w-12 sm:h-12 text-red-400 mx-auto animate-bounce" />
          <h2 className="text-lg sm:text-xl font-bold text-white">Tài khoản đã hết hạn sử dụng</h2>
          <p className="text-xs text-slate-400">
            Tài khoản <strong className="text-white font-mono">{user.username}</strong> của bạn đã hết hạn vào ngày{' '}
            {new Date(user.expiresAt).toLocaleDateString('vi-VN')}. Vui lòng liên hệ Admin để gia hạn thêm thời gian sử dụng.
          </p>
          <button
            onClick={handleLogout}
            className="px-6 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-sm"
          >
            Quay lại Đăng Nhập
          </button>
        </div>
      </div>
    );
  }

  // Determine active room display name
  const activeRoomUser = allUsers.find(u => u.id === currentRoomId);
  const activeRoomName = activeRoomUser ? activeRoomUser.username : user.username;

  // Màn hình chặn khi phòng đã đủ 2 viewer
  if (viewerBlocked) {
    return (
      <div className="min-h-screen flex items-center justify-center p-2.5 sm:p-4 bg-dark-400 overflow-y-auto">
        <div className="glass-panel max-w-sm w-full p-5 sm:p-8 rounded-3xl border border-amber-500/30 text-center space-y-3.5 max-h-[92vh] overflow-y-auto overscroll-contain my-auto shadow-2xl">
          <div className="text-4xl sm:text-5xl">🚫</div>
          <h2 className="text-lg sm:text-xl font-bold text-white">Phòng đã đủ người xem</h2>
          <p className="text-xs sm:text-sm text-slate-400">
            Phòng này đang có tối đa <strong className="text-amber-400">2 người xem</strong>.<br />
            Vui lòng thử lại sau khi có người rời phòng.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold text-sm transition-all"
          >
            Thử lại
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-dark-400">
      <Navbar
        user={user}
        onLogout={handleLogout}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
      />

      <main className="flex-1 max-w-[1700px] w-full mx-auto p-2 sm:p-3.5 space-y-2.5">
        {user.role === 'ADMIN' && activeTab === 'admin' ? (
          <AdminDashboard
            users={allUsers}
            currentGps={currentGps}
            activeStream={activeStream}
            token={token}
            onRefreshUsers={() => fetchAdminUsers(token)}
            socket={socket}
          />
        ) : (
          <div className="space-y-2.5">
            {/* Room Indicator & Admin Room Switcher Bar */}
            {user.role === 'ADMIN' ? (
              <div className="flex items-center space-x-1.5 overflow-x-auto no-scrollbar bg-slate-900/90 p-1.5 rounded-xl border border-red-500/30">
                <span className="text-[11px] font-bold text-slate-400 px-1 whitespace-nowrap">
                  Chuyển Room:
                </span>
                <button
                  onClick={() => setCurrentRoomId(user.id)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                    currentRoomId === user.id
                      ? 'bg-red-600 text-white shadow'
                      : 'bg-slate-800/80 text-slate-400 hover:text-white'
                  }`}
                >
                  Room: {user.username} (Admin)
                </button>
                {allUsers
                  .filter((u) => u.id !== user.id)
                  .map((u) => (
                    <button
                      key={u.id}
                      onClick={() => setCurrentRoomId(u.id)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all whitespace-nowrap flex items-center space-x-1 ${
                        currentRoomId === u.id
                          ? 'bg-red-600 text-white shadow'
                          : 'bg-slate-800/80 text-slate-400 hover:text-white'
                      }`}
                    >
                      <span>Room: {u.username}</span>
                    </button>
                  ))}
              </div>
            ) : (
              <div className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-slate-900/80 border border-red-500/30 text-xs">
                <div className="flex items-center space-x-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  <span className="text-slate-300">
                    Đang xem: <strong className="text-white font-mono">Room: {user.username}</strong>
                  </span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded-md bg-red-500/20 text-red-300 font-mono border border-red-500/30">
                  Quyền Xem (Viewer)
                </span>
              </div>
            )}

            {/* Trình phát Video Full HD 120fps Chuyên nghiệp */}
            <div className="w-full space-y-2.5">
              <LivePlayer
                stream={activeStream}
                socket={socket}
                roomId={currentRoomId}
                roomName={activeRoomName}
                onFinishRound={handleFinishRound}
                finishRoundTrigger={finishRoundTrigger}
                onFullscreenChange={setIsVideoFullscreen}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
