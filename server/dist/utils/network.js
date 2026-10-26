"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPrimaryIp = getPrimaryIp;
exports.getLocalIpAddresses = getLocalIpAddresses;
exports.resolveRtmpHostForClient = resolveRtmpHostForClient;
exports.classifyConnection = classifyConnection;
const os_1 = __importDefault(require("os"));
function getPrimaryIp() {
    const interfaces = os_1.default.networkInterfaces();
    const candidates = [];
    for (const name of Object.keys(interfaces)) {
        const lowerName = name.toLowerCase();
        for (const iface of interfaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) {
                const ip = iface.address;
                if (ip.startsWith('169.254.'))
                    continue;
                if (ip.startsWith('127.'))
                    continue;
                let priority = 10;
                if (lowerName.includes('wi-fi') || lowerName.includes('wifi') || lowerName.includes('wlan')) {
                    priority = 100;
                }
                else if (lowerName.includes('ethernet') || lowerName.includes('eth') || lowerName.startsWith('en')) {
                    priority = 80;
                }
                else if (lowerName.includes('local area connection')) {
                    priority = 50;
                }
                if (lowerName.includes('bluetooth') || lowerName.includes('vmware') || lowerName.includes('virtual') || lowerName.includes('vethernet')) {
                    priority = 5;
                }
                candidates.push({ name, ip, priority });
            }
        }
    }
    candidates.sort((a, b) => b.priority - a.priority);
    if (candidates.length > 0) {
        return candidates[0].ip;
    }
    return 'localhost';
}
function getLocalIpAddresses() {
    const interfaces = os_1.default.networkInterfaces();
    const addresses = [];
    const primaryIp = getPrimaryIp();
    if (primaryIp && primaryIp !== 'localhost') {
        addresses.push(primaryIp);
    }
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) {
                const ip = iface.address;
                if (!ip.startsWith('169.254.') && !ip.startsWith('127.') && !addresses.includes(ip)) {
                    addresses.push(ip);
                }
            }
        }
    }
    return addresses;
}
function resolveRtmpHostForClient(req) {
    const overrideHost = req.headers?.['x-rtmp-host']?.trim();
    const overridePort = parseInt(req.headers?.['x-rtmp-port'] || '');
    if (overrideHost) {
        console.log('[Network] RTMP host override: ' + overrideHost + ':' + (overridePort || 1935));
        return { rtmpHost: overrideHost, rtmpPort: overridePort || 1935 };
    }
    const rawHostHeader = (req.headers?.host || '').split(':')[0].trim();
    if (rawHostHeader.endsWith('trycloudflare.com') || rawHostHeader.endsWith('.ngrok.io') ||
        rawHostHeader.endsWith('.ngrok-free.app') || rawHostHeader.endsWith('.pinggy.link') ||
        rawHostHeader.endsWith('.pinggy.online')) {
        console.log('[Network] Host header là tunnel domain (' + rawHostHeader + '), trả lại cho RTMP.');
        return { rtmpHost: rawHostHeader, rtmpPort: overridePort || 1935 };
    }
    const isIpv4Pattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    if (isIpv4Pattern.test(rawHostHeader) && rawHostHeader !== '127.0.0.1') {
        console.log('[Network] Dynamic Echo: iPhone kết nối qua IP ' + rawHostHeader + ', tự động trích xuất làm RTMP Host.');
        return { rtmpHost: rawHostHeader, rtmpPort: 1935 };
    }
    const socketLocalIp = (req.socket?.localAddress || '').replace(/^::ffff:/, '').trim();
    if (isIpv4Pattern.test(socketLocalIp) && socketLocalIp !== '127.0.0.1' && !socketLocalIp.startsWith('169.254.')) {
        console.log('[Network] Socket Local IP nhận diện được: ' + socketLocalIp + ', sử dụng cho RTMP.');
        return { rtmpHost: socketLocalIp, rtmpPort: 1935 };
    }
    const primaryIp = getPrimaryIp();
    console.log('[Network] Sử dụng Primary LAN IP (' + primaryIp + ') cho RTMP.');
    return { rtmpHost: primaryIp, rtmpPort: 1935 };
}
function classifyConnection(hostHeader, primaryIp) {
    if (hostHeader.endsWith('trycloudflare.com') || hostHeader.endsWith('.ngrok.io') || hostHeader.endsWith('.ngrok-free.app')) {
        return 'tunnel';
    }
    if (hostHeader === primaryIp)
        return 'lan';
    if (hostHeader === 'localhost' || hostHeader === '127.0.0.1')
        return 'localhost';
    return 'external';
}
