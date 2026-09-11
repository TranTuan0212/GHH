import os from 'os';
import { Request } from 'express';

/**
 * Trước đây hai bản gần-như-giống-hệt-nhau của getPrimaryIp() và resolveRtmpHostForClient()
 * tồn tại độc lập ở index.ts và routes/stream.ts. Rủi ro: sửa domain tunnel mới (vd thêm
 * ".pinggy.online") ở một chỗ mà quên chỗ kia sẽ khiến /api/server-info và /api/stream/start
 * trả về host RTMP khác nhau cho cùng một client. Gộp về đây, cả 2 nơi cùng import.
 */

export function getPrimaryIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

export function getLocalIpAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

/**
 * Xác định host:port RTMP phù hợp với client đang kết nối.
 * - Override qua header X-RTMP-Host / X-RTMP-Port nếu user cấu hình tay (vd 5G + Pinggy tunnel).
 * - Nếu Host header là tunnel domain (Cloudflare Quick Tunnel / ngrok): trả về chính host đó.
 *   YÊU CẦU: tunnel phải forward TCP port 1935 riêng, vì Cloudflare Quick Tunnel là HTTP-only.
 * - Nếu Host header là IP LAN của chính server: trả về IP LAN.
 * - Fallback: IP LAN (kèm cảnh báo log vì có thể client ở ngoài LAN thật, ví dụ 5G).
 */
export function resolveRtmpHostForClient(req: Pick<Request, 'headers'>): { rtmpHost: string; rtmpPort: number } {
  const overrideHost = (req.headers['x-rtmp-host'] as string | undefined)?.trim();
  const overridePort = parseInt((req.headers['x-rtmp-port'] as string | undefined) || '');

  if (overrideHost) {
    console.log(`[Network] RTMP host override: ${overrideHost}:${overridePort || 1935}`);
    return { rtmpHost: overrideHost, rtmpPort: overridePort || 1935 };
  }

  const hostHeader = ((req.headers.host as string) || '').split(':')[0];

  if (hostHeader.endsWith('trycloudflare.com') || hostHeader.endsWith('.ngrok.io') || hostHeader.endsWith('.ngrok-free.app')) {
    console.log(`[Network] Host header là tunnel domain (${hostHeader}), trả lại cho RTMP. YÊU CẦU: tunnel mở port 1935.`);
    return { rtmpHost: hostHeader, rtmpPort: overridePort || 1935 };
  }

  const primaryIp = getPrimaryIp();
  if (hostHeader === primaryIp || hostHeader === 'localhost' || hostHeader === '127.0.0.1') {
    console.log(`[Network] Host header là IP LAN/Localhost (${hostHeader}), trả lại cho RTMP.`);
    return { rtmpHost: hostHeader, rtmpPort: 1935 };
  }

  // Khi người dùng kết nối qua Tên miền (Domain) hoặc IP Public của VPS:
  // Dùng chính tên miền / IP đó cho đường truyền RTMP từ iPhone vào port 1935
  console.log(`[Network] Host header là tên miền / IP ngoài (${hostHeader}), dùng cho RTMP.`);
  return { rtmpHost: hostHeader, rtmpPort: overridePort || 1935 };
}

/**
 * Xác định connectionType để client (iOS/web) hiển thị cảnh báo phù hợp.
 */
export function classifyConnection(hostHeader: string, primaryIp: string): 'tunnel' | 'lan' | 'localhost' | 'external' {
  if (hostHeader.endsWith('trycloudflare.com') || hostHeader.endsWith('.ngrok.io') || hostHeader.endsWith('.ngrok-free.app')) {
    return 'tunnel';
  }
  if (hostHeader === primaryIp) return 'lan';
  if (hostHeader === 'localhost' || hostHeader === '127.0.0.1') return 'localhost';
  return 'external';
}
