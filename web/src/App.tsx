import React, { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { User, StreamSession, GpsLog, CardEntry } from './types';
import { Navbar } from './components/Navbar';
import { LoginForm } from './components/LoginForm';
import { LivePlayer } from './components/LivePlayer';
import { DataGroupingUI } from './components/DataGroupingUI';
import { AdminDashboard } from './components/AdminDashboard';
import { AlertTriangle, Clock, RefreshCw } from 'lucide-react';

export const App: React.FC = () => {
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<'viewer' | 'admin'>('viewer');

  const [activeStream, setActiveStream] = useState<StreamSession | null>(null);
  const [currentGps, setCurrentGps] = useState<GpsLog | null>(null);
  const [cardEntries, setCardEntries] = useState<CardEntry[]>([]);
  const [groupNames, setGroupNames] = useState<{ [groupIndex: number]: string }>({});
  const [allUsers, setAllUsers] = useState<User[]>([]);

  const [socket, setSocket] = useState<Socket | null>(null);
  const [currentRoomId, setCurrentRoomId] = useState<string>('');

  // Chế độ bố cục giao diện: 'horizontal' (Khuyên dùng: Player trên, Bảng nhóm full hàng ngang dưới) hoặc 'split' (Chia cột 7/5)
  const [layoutMode, setLayoutMode] = useState<'horizontal' | 'split'>(() => {
    try {
      return (localStorage.getItem('app_layout_mode') as any) || 'horizontal';
    } catch {
      return 'horizontal';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('app_layout_mode', layoutMode);
    } catch {}
  }, [layoutMode]);

  // Set initial currentRoomId when user logs in
  useEffect(() => {
    if (user) {
      setCurrentRoomId(user.id);
    }
  }, [user]);

  // Initialize Socket.io and Room Joining
  useEffect(() => {
    const host = window.location.hostname;
    const isTunnelOrHttps = host.includes('trycloudflare.com') || host.includes('ngrok') || window.location.protocol === 'https:';
    const defaultUrl = isTunnelOrHttps 
      ? `${window.location.protocol}//${host}` 
      : `${window.location.protocol}//${host}:4000`;
    const socketUrl = (import.meta as any).env?.VITE_API_URL || defaultUrl;
    const newSocket = io(socketUrl);
    setSocket(newSocket);

    newSocket.on('initial_state', (data) => {
      setActiveStream(data.activeStream);
      setCurrentGps(data.latestGps);
      setCardEntries(data.cardEntries || []);
      if (data.groupNames) {
        setGroupNames(data.groupNames);
      }
    });

    newSocket.on('group_names_updated', (data) => {
      if (data && data.groupNames) {
        setGroupNames(data.groupNames);
      }
    });

    newSocket.on('gps_updated', (gpsLog: GpsLog) => {
      setCurrentGps(gpsLog);
    });

    newSocket.on('card_added', (data) => {
      if (data.allEntries) {
        setCardEntries(data.allEntries);
      } else if (data.entry) {
        setCardEntries((prev) => [...prev, data.entry]);
      }
    });

    newSocket.on('cards_cleared', () => {
      setCardEntries([]);
    });

    newSocket.on('stream_status_changed', (data) => {
      if (data.status === 'LIVE') {
        setActiveStream(data.session);
      } else {
        setActiveStream(null);
      }
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  // Join Room when socket or currentRoomId changes
  useEffect(() => {
    if (socket && currentRoomId) {
      socket.emit('join_room', {
        roomId: currentRoomId,
        role: user?.role
      });
    }
  }, [socket, currentRoomId, user?.role]);

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

  // Add card callback (supports round-robin or direct target group for Bọt)
  const handleAddCard = (cardValue: string, groupCount: number, targetGroup?: number) => {
    if (socket) {
      socket.emit('add_card', {
        cardValue,
        groupCount,
        targetGroup,
        userId: user?.id || 'viewer',
        roomId: currentRoomId
      });
    }
  };

  // Edit card callback (sửa giá trị bài khi nhập sai)
  const handleEditCard = (cardId: string, newCardValue: string) => {
    if (socket) {
      socket.emit('edit_card', {
        id: cardId,
        newCardValue,
        roomId: currentRoomId
      });
    }
  };

  // Delete card callback (xóa lá bài khi nhập sai)
  const handleDeleteCard = (cardId: string) => {
    if (socket) {
      socket.emit('delete_card', {
        id: cardId,
        roomId: currentRoomId
      });
    }
  };

  // Set custom group names callback
  const handleSetGroupNames = (names: { [groupIndex: number]: string }) => {
    setGroupNames(names);
    if (socket) {
      socket.emit('set_group_names', {
        roomId: currentRoomId,
        groupNames: names
      });
    }
  };

  // Clear cards callback
  const handleClearCards = () => {
    if (socket) {
      socket.emit('clear_cards', { roomId: currentRoomId });
    }
  };

  // Finish round callback (resets cards & DVR frame buffer for this room)
  const handleFinishRound = () => {
    if (socket) {
      socket.emit('finish_round', { roomId: currentRoomId });
    }
    setCardEntries([]);
  };

  // Undo last card callback
  const handleUndoCard = () => {
    if (socket) {
      socket.emit('undo_card', { roomId: currentRoomId });
    }
  };

  if (!token || !user) {
    return <LoginForm onLoginSuccess={handleLoginSuccess} />;
  }

  const isExpired = new Date(user.expiresAt) < new Date();

  if (isExpired) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-dark-400">
        <div className="glass-panel max-w-md w-full p-8 rounded-3xl border border-red-500/30 text-center space-y-4">
          <AlertTriangle className="w-12 h-12 text-red-400 mx-auto animate-bounce" />
          <h2 className="text-xl font-bold text-white">Tài khoản đã hết hạn sử dụng</h2>
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
          />
        ) : (
          <div className="space-y-2.5">
            {/* Room Indicator & Admin Room Switcher Bar */}
            {user.role === 'ADMIN' ? (
              <div className="flex items-center space-x-1.5 overflow-x-auto no-scrollbar bg-slate-900/90 p-1.5 rounded-xl border border-indigo-500/30">
                <span className="text-[11px] font-bold text-slate-400 px-1 whitespace-nowrap">
                  Chuyển Room:
                </span>
                <button
                  onClick={() => setCurrentRoomId(user.id)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                    currentRoomId === user.id
                      ? 'bg-indigo-600 text-white shadow'
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
                          ? 'bg-indigo-600 text-white shadow'
                          : 'bg-slate-800/80 text-slate-400 hover:text-white'
                      }`}
                    >
                      <span>Room: {u.username}</span>
                    </button>
                  ))}
              </div>
            ) : (
              <div className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-slate-900/80 border border-indigo-500/30 text-xs">
                <div className="flex items-center space-x-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  <span className="text-slate-300">
                    Đang xem: <strong className="text-white font-mono">Room: {user.username}</strong>
                  </span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded-md bg-indigo-500/20 text-indigo-300 font-mono border border-indigo-500/30">
                  Quyền Xem (Viewer)
                </span>
              </div>
            )}

            {/* Thanh chuyển đổi bố cục giao diện: Hàng Ngang / Chia Cột */}
            <div className="flex items-center justify-between bg-slate-900/80 px-3 py-1.5 rounded-xl border border-white/10 text-xs">
              <span className="text-slate-400 font-bold text-[11px] flex items-center space-x-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                <span>Bố cục hiển thị:</span>
              </span>
              <div className="flex items-center space-x-1.5">
                <button
                  onClick={() => setLayoutMode('horizontal')}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all flex items-center space-x-1 ${
                    layoutMode === 'horizontal'
                      ? 'bg-amber-400 text-slate-950 shadow-md font-black ring-1 ring-amber-300'
                      : 'bg-slate-800 text-slate-300 hover:text-white'
                  }`}
                  title="Player ở trên, Bảng nhóm dàn rộng toàn bộ hàng ngang ở dưới (Khuyên dùng)"
                >
                  <span>↔ Hàng Ngang (Khuyên dùng)</span>
                </button>
                <button
                  onClick={() => setLayoutMode('split')}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all flex items-center space-x-1 ${
                    layoutMode === 'split'
                      ? 'bg-indigo-600 text-white shadow-md font-black ring-1 ring-indigo-400'
                      : 'bg-slate-800 text-slate-300 hover:text-white'
                  }`}
                  title="Player bên trái, Bảng nhóm bên phải"
                >
                  <span>◫ Chia Cột (7/5)</span>
                </button>
              </div>
            </div>

            {layoutMode === 'horizontal' ? (
              <div className="space-y-2.5">
                {/* 1. Player ở trên, căn giữa gọn gàng */}
                <div className="w-full max-w-4xl mx-auto space-y-2">
                  <LivePlayer
                    stream={activeStream}
                    socket={socket}
                    roomId={currentRoomId}
                    roomName={activeRoomName}
                    onFinishRound={handleFinishRound}
                  />
                </div>

                {/* 2. Bảng nhóm dàn rộng 100% toàn màn hình hàng ngang ở dưới */}
                <div className="w-full">
                  <DataGroupingUI
                    entries={cardEntries}
                    roomId={currentRoomId}
                    roomName={activeRoomName}
                    groupNames={groupNames}
                    onAddCard={handleAddCard}
                    onClearCards={handleClearCards}
                    onUndoCard={handleUndoCard}
                    onFinishRound={handleFinishRound}
                    onEditCard={handleEditCard}
                    onDeleteCard={handleDeleteCard}
                    onSetGroupNames={handleSetGroupNames}
                  />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5 sm:gap-3.5 items-start">
                {/* Left Column: Custom Live Slow-Mo 240fps Player */}
                <div className="lg:col-span-7 space-y-2.5">
                  <LivePlayer
                    stream={activeStream}
                    socket={socket}
                    roomId={currentRoomId}
                    roomName={activeRoomName}
                    onFinishRound={handleFinishRound}
                  />
                </div>

                {/* Right Column: Auto Round-Robin Data Grouping System */}
                <div className="lg:col-span-5 space-y-2.5">
                  <DataGroupingUI
                    entries={cardEntries}
                    roomId={currentRoomId}
                    roomName={activeRoomName}
                    groupNames={groupNames}
                    onAddCard={handleAddCard}
                    onClearCards={handleClearCards}
                    onUndoCard={handleUndoCard}
                    onFinishRound={handleFinishRound}
                    onEditCard={handleEditCard}
                    onDeleteCard={handleDeleteCard}
                    onSetGroupNames={handleSetGroupNames}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
