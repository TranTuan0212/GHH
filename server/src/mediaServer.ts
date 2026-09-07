// @ts-ignore
import NodeMediaServer from 'node-media-server';
import path from 'path';

const mediaConfig = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: 8000,
    mediaroot: path.join(__dirname, '../media'),
    allow_origin: '*'
  }
};

export function startNativeMediaServer() {
  try {
    const nms = new NodeMediaServer(mediaConfig);

    nms.on('prePublish', (id: string, StreamPath: string, args: any) => {
      console.log(`[MediaServer] 🎥 iPhone bắt đầu phát luồng RTMP: ${StreamPath}`);
    });

    nms.on('donePublish', (id: string, StreamPath: string, args: any) => {
      console.log(`[MediaServer] 🛑 iPhone dừng phát luồng RTMP: ${StreamPath}`);
    });

    nms.run();
    console.log(`🎬 Native RTMP/HLS Media Server đang chạy tại:`);
    console.log(`   👉 RTMP Ingest (Cho iPhone): rtmp://localhost:1935/live`);
    console.log(`   👉 HTTP-FLV/HLS Egress (Cho Web Player): http://localhost:8000/live`);
  } catch (err) {
    console.log(`[MediaServer Note] Cổng 1935 đã chạy hoặc đang dùng mode Frame Relay.`);
  }
}
