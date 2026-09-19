import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://www.rezaxd.web.id/api/wa-bot/webhook';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'autoflow_webhook_secret_2026';

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// In-memory registry of active bot sockets
const activeSockets = new Map();

// Helper: Notify website webhook about bot status changes
async function notifyWebhook(rentalId, status, extra = {}) {
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rentalId,
        status,
        secret: WEBHOOK_SECRET,
        ...extra,
      }),
    });
    console.log(`[Webhook] Sent status update for ${rentalId}: ${status}`);
  } catch (err) {
    console.error(`[Webhook Error] Failed to notify for ${rentalId}:`, err.message);
  }
}

// Helper: Parse JSON body
async function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// Helper: Send JSON response
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

/**
 * Start Baileys Socket for a specific rental
 */
async function startBotSocket(rentalId, phoneNumber, isRestart = false) {
  const bail = await import('ourin-baileys');
  const makeWASocket = bail.makeWASocket || bail.default?.makeWASocket || bail.default;
  const useMultiFileAuthState = bail.useMultiFileAuthState;
  const makeCacheableSignalKeyStore = bail.makeCacheableSignalKeyStore;
  const fetchLatestWaWebVersion = bail.fetchLatestWaWebVersion;
  const DisconnectReason = bail.DisconnectReason;
  const Browsers = bail.Browsers;

  const sessionPath = path.join(SESSIONS_DIR, rentalId);
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  // Get live WhatsApp Web version
  let version = [2, 3000, 1047765575];
  try {
    if (fetchLatestWaWebVersion) {
      const vResult = await fetchLatestWaWebVersion();
      if (Array.isArray(vResult?.version)) version = vResult.version;
    }
  } catch {}

  // Multi-file auth state
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const silentLogger = {
    level: 'silent',
    trace: () => {}, debug: () => {}, info: () => {}, warn: () => {},
    error: () => {}, fatal: () => {}, child: () => silentLogger,
  };

  const auth = makeCacheableSignalKeyStore
    ? { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) }
    : state;

  const sock = makeWASocket({
    version,
    auth,
    browser: Browsers?.ubuntu?.('Chrome') || ['Ubuntu', 'Chrome', '22.04.4'],
    printQRInTerminal: true,
    logger: silentLogger,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 30000,
  });

  sock.ev.on('creds.update', saveCreds);

  // Store active socket
  activeSockets.set(rentalId, {
    sock,
    phoneNumber,
    status: isRestart ? 'RECONNECTING' : 'STARTING',
    startedAt: new Date(),
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect, isNewLogin } = update;

    console.log(`[Bot ${rentalId}] connection.update:`, { connection, hasQr: !!qr, isNewLogin });

    if (connection === 'open') {
      console.log(`✅ [Bot ${rentalId}] WhatsApp CONNECTED successfully!`);
      const botObj = activeSockets.get(rentalId);
      if (botObj) botObj.status = 'CONNECTED';

      await notifyWebhook(rentalId, 'CONNECTED', { botNumber: phoneNumber });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isRestartReq = statusCode === DisconnectReason?.restartRequired || statusCode === 515;
      const isLoggedOut = statusCode === DisconnectReason?.loggedOut || statusCode === 401;

      console.log(`⚠️ [Bot ${rentalId}] Connection closed. Code:`, statusCode, '| isRestart:', isRestartReq);

      if (isRestartReq) {
        console.log(`🔄 [Bot ${rentalId}] Restarting socket after pairing...`);
        try {
          await saveCreds();
          sock.ev.removeAllListeners('connection.update');
          sock.ev.removeAllListeners('creds.update');
          sock.ws?.close();
        } catch {}
        setTimeout(() => {
          startBotSocket(rentalId, phoneNumber, true).catch(console.error);
        }, 1500);
        return;
      }

      if (isLoggedOut) {
        console.log(`❌ [Bot ${rentalId}] Logged out.`);
        activeSockets.delete(rentalId);
        await notifyWebhook(rentalId, 'STOPPED');
      } else {
        // Auto-reconnect for network blips
        console.log(`🔄 [Bot ${rentalId}] Auto-reconnecting in 5s...`);
        setTimeout(() => {
          startBotSocket(rentalId, phoneNumber, true).catch(console.error);
        }, 5000);
      }
    }
  });

  // Handle incoming messages (bot auto-responder placeholder)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (text.toLowerCase() === '.ping') {
        await sock.sendMessage(msg.key.remoteJid, { text: '🏓 Pong! Bot aktif 24/7 di rezaxd.web.id' }, { quoted: msg });
      }
    }
  });

  return sock;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check
  if (url.pathname === '/' || url.pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'rezaxd-bot-runner',
      uptime: Math.floor(process.uptime()),
      activeBots: activeSockets.size,
      timestamp: new Date().toISOString(),
    });
  }

  // POST /api/bot/pair
  if (url.pathname === '/api/bot/pair' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const { rentalId, phoneNumber } = body;

    if (!rentalId || !phoneNumber) {
      return sendJson(res, 400, { error: 'rentalId and phoneNumber are required' });
    }

    let cleanNumber = String(phoneNumber).replace(/[^0-9]/g, '');
    if (cleanNumber.startsWith('620')) cleanNumber = '62' + cleanNumber.slice(3);
    else if (cleanNumber.startsWith('08')) cleanNumber = '62' + cleanNumber.slice(1);
    else if (cleanNumber.startsWith('8')) cleanNumber = '62' + cleanNumber;
    else if (cleanNumber.startsWith('0')) cleanNumber = '62' + cleanNumber.slice(1);

    try {
      console.log(`\n========================================`);
      console.log(`📱 Meminta Pairing Code untuk rental: ${rentalId}`);
      console.log(`📞 Nomor: ${cleanNumber}`);
      console.log(`========================================\n`);

      // Close existing socket if any
      const existing = activeSockets.get(rentalId);
      if (existing) {
        try { existing.sock?.end?.(); } catch {}
        activeSockets.delete(rentalId);
      }

      // Clean old session folder
      const sessionPath = path.join(SESSIONS_DIR, rentalId);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }

      // Start socket
      const sock = await startBotSocket(rentalId, cleanNumber, false);

      // Wait for WebSocket to open
      let waited = 0;
      while (!sock?.ws?.isOpen && waited < 4000) {
        await new Promise((r) => setTimeout(r, 200));
        waited += 200;
      }

      // Request Pairing Code
      let rawCode = '';
      try {
        rawCode = await sock.requestPairingCode(cleanNumber);
      } catch (err) {
        await new Promise((r) => setTimeout(r, 1000));
        rawCode = await sock.requestPairingCode(cleanNumber);
      }

      const formatted = rawCode.length === 8 && !rawCode.includes('-')
        ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`
        : rawCode;

      console.log(`\n🎉 [PAIRING CODE READY] ${formatted}`);
      console.log(`Kirim ke HP pembeli sekarang!\n`);

      // Notify Webhook
      await notifyWebhook(rentalId, 'PAIRING', { pairingCode: formatted, pairingNumber: cleanNumber });

      return sendJson(res, 200, {
        success: true,
        pairingCode: formatted,
        phoneNumber: cleanNumber,
        rentalId,
        message: `Kode pairing berhasil didapatkan: ${formatted}`,
      });

    } catch (err) {
      console.error('Pairing Error:', err);
      return sendJson(res, 500, { error: err.message || 'Gagal meminta kode pairing' });
    }
  }

  // GET /api/bot/status
  if (url.pathname === '/api/bot/status') {
    const rentalId = url.searchParams.get('rentalId');
    if (!rentalId) return sendJson(res, 400, { error: 'rentalId is required' });

    const botObj = activeSockets.get(rentalId);
    return sendJson(res, 200, {
      rentalId,
      running: !!botObj,
      status: botObj?.status || 'STOPPED',
      phoneNumber: botObj?.phoneNumber || null,
      startedAt: botObj?.startedAt || null,
    });
  }

  return sendJson(res, 404, { error: 'Not Found' });
});

server.listen(PORT, () => {
  console.log(`\n🚀 [REZAXD BOT RUNNER] Server berjalan di port ${PORT}`);
  console.log(`📡 Siap melayani pembeli WhatsApp 24/7!`);
});