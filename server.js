// A Node.js server for the VINI PLAY IPTV Player. 
// Implements server-side EPG parsing, secure environment variables, and improved logging.

// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const { spawn, exec } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const SQLiteStore = require('connect-sqlite3')(session);
const xmlJS = require('xml-js');
const webpush = require('web-push');
const schedule = require('node-schedule');
const disk = require('diskusage');
const si = require('systeminformation'); // NEW: For system health monitoring
// --- NEW: Live Activity Tracking for Redirects ---
const activeRedirectStreams = new Map(); // Tracks live redirect streams for the admin UI

const app = express();
const port = 8998;
const saltRounds = 10;
// Initialize global variables at the top-level scope
let notificationCheckInterval = null;
const sourceRefreshTimers = new Map();
let detectedHardware = { nvidia: null, intel_qsv: null, intel_vaapi: null }; // MODIFIED: To store specific Intel GPU info

// --- ENHANCEMENT: For Server-Sent Events (SSE) ---
// This map will store active client connections for real-time updates.
const sseClients = new Map();

// --- NEW: DVR State ---
const activeDvrJobs = new Map(); // Stores active node-schedule jobs
const runningFFmpegProcesses = new Map(); // Stores PIDs of running ffmpeg recordings

// --- MODIFIED: Active Stream Management ---
// Now maps a unique stream key (URL + UserID) to its process info
const activeStreamProcesses = new Map();
const STREAM_INACTIVITY_TIMEOUT = 30000; // 30 seconds to kill an inactive stream process

// --- Configuration ---
const DATA_DIR = '/data';
const DVR_DIR = '/dvr';
const VAPID_KEYS_PATH = path.join(DATA_DIR, 'vapid.json');
const SOURCES_DIR = path.join(DATA_DIR, 'sources');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(DATA_DIR, 'viniplay.db');
const LIVE_CHANNELS_M3U_PATH = path.join(DATA_DIR, 'live_channels.m3u'); // Renamed
const LIVE_EPG_JSON_PATH = path.join(DATA_DIR, 'epg.json'); // Renamed
const VOD_MOVIES_JSON_PATH = path.join(DATA_DIR, 'vod_movies.json'); // New
const VOD_SERIES_JSON_PATH = path.join(DATA_DIR, 'vod_series.json'); // New
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

console.log(`[INIT] Application starting. Data directory: ${DATA_DIR}, Public directory: ${PUBLIC_DIR}`);

// --- Automatic VAPID Key Generation ---
let vapidKeys = {};
try {
    if (fs.existsSync(VAPID_KEYS_PATH)) {
        console.log('[Push] Loading existing VAPID keys...');
        vapidKeys = JSON.parse(fs.readFileSync(VAPID_KEYS_PATH, 'utf-8'));
    } else {
        console.log('[Push] VAPID keys not found. Generating new keys...');
        vapidKeys = webpush.generateVAPIDKeys();
        fs.writeFileSync(VAPID_KEYS_PATH, JSON.stringify(vapidKeys, null, 2));
        console.log('[Push] New VAPID keys generated and saved.');
    }
    const vapidContactEmail = process.env.VAPID_CONTACT_EMAIL || 'mailto:admin@example.com';
    console.log(`[Push] Setting VAPID contact to: ${vapidContactEmail}`);
    webpush.setVapidDetails(vapidContactEmail, vapidKeys.publicKey, vapidKeys.privateKey);
} catch (error) {
    console.error('[Push] FATAL: Could not load or generate VAPID keys.', error);
}

// Ensure the data and dvr directories exist.
try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
    if (!fs.existsSync(SOURCES_DIR)) fs.mkdirSync(SOURCES_DIR, { recursive: true });
    if (!fs.existsSync(DVR_DIR)) fs.mkdirSync(DVR_DIR, { recursive: true });
    console.log(`[INIT] All required directories checked/created.`);
} catch (mkdirError) {
    console.error(`[INIT] FATAL: Failed to create necessary directories: ${mkdirError.message}`);
    process.exit(1);
}


// --- Database Setup ---
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error("[DB] Error opening database:", err.message);
        process.exit(1);
    } else {
        console.log("[DB] Connected to the SQLite database.");
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, isAdmin INTEGER DEFAULT 0, canUseDvr INTEGER DEFAULT 0)`, (err) => {
                if (err) {
                    console.error("[DB] Error creating 'users' table:", err.message);
                } else {
                    db.run("ALTER TABLE users ADD COLUMN canUseDvr INTEGER DEFAULT 0", () => {});
                }
            });
            db.run(`CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (user_id, key))`);
            db.run(`CREATE TABLE IF NOT EXISTS multiview_layouts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, layout_data TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channelId TEXT NOT NULL, channelName TEXT NOT NULL, channelLogo TEXT, programTitle TEXT NOT NULL, programDesc TEXT, programStart TEXT NOT NULL, programStop TEXT NOT NULL, notificationTime TEXT NOT NULL, programId TEXT NOT NULL, status TEXT DEFAULT 'pending', triggeredAt TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS notification_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, notification_id INTEGER NOT NULL, subscription_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', updatedAt TEXT NOT NULL, FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE, FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS dvr_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channelId TEXT NOT NULL, channelName TEXT NOT NULL, programTitle TEXT NOT NULL, startTime TEXT NOT NULL, endTime TEXT NOT NULL, status TEXT NOT NULL, ffmpeg_pid INTEGER, filePath TEXT, profileId TEXT, userAgentId TEXT, preBufferMinutes INTEGER, postBufferMinutes INTEGER, errorMessage TEXT, isConflicting INTEGER DEFAULT 0, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS dvr_recordings (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER, user_id INTEGER NOT NULL, channelName TEXT NOT NULL, programTitle TEXT NOT NULL, startTime TEXT NOT NULL, durationSeconds INTEGER, fileSizeBytes INTEGER, filePath TEXT UNIQUE NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (job_id) REFERENCES dvr_jobs(id) ON DELETE SET NULL)`);
            
            //-- ENHANCEMENT: Modify stream history table to include more data for the admin panel.
            db.run(`CREATE TABLE IF NOT EXISTS stream_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, username TEXT NOT NULL, channel_id TEXT, channel_name TEXT, start_time TEXT NOT NULL, end_time TEXT, duration_seconds INTEGER, status TEXT NOT NULL, client_ip TEXT, channel_logo TEXT, stream_profile_name TEXT)`, (err) => {
                if (!err) {
                    // Add new columns non-destructively if the table already exists
                    db.run("ALTER TABLE stream_history ADD COLUMN channel_logo TEXT", () => {});
                    db.run("ALTER TABLE stream_history ADD COLUMN stream_profile_name TEXT", () => {});
                }
            });
        });
    }
});

// --- Middleware ---
app.use(express.static(PUBLIC_DIR));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.includes('replace_this')) {
    console.warn('[SECURITY] Using a weak or default SESSION_SECRET.');
}

app.use(
  session({
    store: new SQLiteStore({ db: 'viniplay.db', dir: DATA_DIR, table: 'sessions' }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, secure: process.env.NODE_ENV === 'production' },
  })
);

app.use((req, res, next) => {
    // Add client IP to the request object for logging
    req.clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (req.path === '/api/events') {
        return next();
    }
    const user_info = req.session.userId ? `User ID: ${req.session.userId}, Admin: ${req.session.isAdmin}, DVR: ${req.session.canUseDvr}` : 'No session';
    console.log(`[HTTP_TRACE] ${req.method} ${req.originalUrl} - IP: ${req.clientIp} - Session: [${user_info}]`);
    next();
});

// MODIFIED: requireAuth now checks if the user still exists in the database on every request.
const requireAuth = (req, res, next) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Authentication required.' });
    }
    
    db.get("SELECT id FROM users WHERE id = ?", [req.session.userId], (err, user) => {
        if (err) {
            console.error('[AUTH_MIDDLEWARE] DB error checking user existence:', err);
            return res.status(500).json({ error: 'Server error during authentication.' });
        }
        if (!user) {
            console.warn(`[AUTH_MIDDLEWARE] User ID ${req.session.userId} from session not found in DB. Destroying session.`);
            req.session.destroy();
            res.clearCookie('connect.sid');
            return res.status(401).json({ error: 'User account no longer exists. Please log in again.' });
        }
        // User exists, proceed.
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.session && req.session.isAdmin) return next();
    return res.status(403).json({ error: 'Administrator privileges required.' });
};
const requireDvrAccess = (req, res, next) => {
    if (req.session && (req.session.canUseDvr || req.session.isAdmin)) return next();
    return res.status(403).json({ error: 'DVR access required.' });
};

// *** FIX: DVR Playback Access ***
// Removed `requireDvrAccess` from this route. Now, any authenticated user can access
// the /dvr directory to play back recorded files. The API endpoints for creating
// and managing recordings remain protected by `requireDvrAccess`.
app.use('/dvr', requireAuth, express.static(DVR_DIR));

// --- Helper Functions ---
/**
 * NEW: Sends a real-time status update to the client during source processing.
 * @param {object} req - The Express request object, used to identify the user.
 * @param {string} message - The status message to send.
 * @param {string} type - The type of message (e.g., 'info', 'success', 'error').
 */
function sendProcessingStatus(req, message, type = 'info') {
    if (req && req.session && req.session.userId) {
        sendSseEvent(req.session.userId, 'processing-status', { message, type });
    }
}


/**
 * NEW: Detects available hardware for transcoding.
 */
async function detectHardwareAcceleration() {
    console.log('[HW] Detecting hardware acceleration capabilities...');
    // Detect NVIDIA GPU
    exec('nvidia-smi --query-gpu=gpu_name --format=csv,noheader', (err, stdout, stderr) => {
        if (err || stderr) {
            console.log('[HW] NVIDIA GPU not detected or nvidia-smi failed.');
        } else {
            const gpuName = stdout.trim();
            detectedHardware.nvidia = gpuName;
            console.log(`[HW] NVIDIA GPU detected: ${gpuName}`);
        }
    });

    // MODIFIED: Use 'vainfo' for more robust detection of Intel VA-API and QSV
    exec('vainfo', (err, stdout, stderr) => {
        if (err || stderr) {
            console.log('[HW] VA-API not detected or vainfo command failed.');
            detectedHardware.intel_qsv = null;
            detectedHardware.intel_vaapi = null;
        } else {
            // iHD driver is for modern Intel GPUs (Gen9+) and is preferred for QSV
            if (stdout.includes('iHD_drv_video.so')) {
                detectedHardware.intel_qsv = 'Intel Quick Sync Video';
                console.log('[HW] Intel QSV (iHD driver) detected via VA-API.');
            }
            // i965 driver is for older Intel GPUs (pre-Gen9)
            if (stdout.includes('i965_drv_video.so')) {
                detectedHardware.intel_vaapi = 'Intel VA-API (Legacy)';
                console.log('[HW] Intel VA-API (i965 driver) detected.');
            }
        }
    });
}

// MODIFIED: This function is now mostly for multi-view scenarios.
// Single-user streams are handled more directly.
function cleanupInactiveStreams() {
    const now = Date.now();
    console.log(`[JANITOR] Running cleanup for inactive streams. Current active processes: ${activeStreamProcesses.size}`);
    
    activeStreamProcesses.forEach((streamInfo, streamKey) => {
        if (streamInfo.references <= 0 && (now - streamInfo.lastAccess > STREAM_INACTIVITY_TIMEOUT)) {
            console.log(`[JANITOR] Found stale stream process for key: ${streamKey}. Terminating PID: ${streamInfo.process.pid}.`);
            try {
                // Also update the history entry if it exists
                if (streamInfo.historyId) {
                    const endTime = new Date().toISOString();
                    const duration = Math.round((new Date(endTime).getTime() - new Date(streamInfo.startTime).getTime()) / 1000);
                    db.run("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND status = 'playing'",
                        [endTime, duration, streamInfo.historyId]);
                }
                streamInfo.process.kill('SIGKILL'); 
                activeStreamProcesses.delete(streamKey);
                //-- ENHANCEMENT: Notify admins that a stream has ended.
                broadcastAdminUpdate();
            } catch (e) {
                console.warn(`[JANITOR] Error killing stale process for ${streamKey}: ${e.message}`);
                activeStreamProcesses.delete(streamKey);
                //-- ENHANCEMENT: Notify admins even if the process kill fails, to keep UI in sync.
                broadcastAdminUpdate();
            }
        }
    });
}

function sendSseEvent(userId, eventName, data) {
    const clients = sseClients.get(userId);
    if (clients && clients.length > 0) {
        console.log(`[SSE] Sending event '${eventName}' to ${clients.length} client(s) for user ID ${userId}.`);
        const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
        clients.forEach(client => client.res.write(message));
    }
}

//-- ENHANCEMENT: New function to broadcast activity updates to all connected admins.
function broadcastAdminUpdate() {
    // Combine transcoded and redirect streams into one list for the live view
    const transcodedLive = Array.from(activeStreamProcesses.values()).map(info => ({
        streamKey: info.streamKey,
        userId: info.userId,
        username: info.username,
        channelName: info.channelName,
        channelLogo: info.channelLogo,
        streamProfileName: info.streamProfileName,
        startTime: info.startTime,
        clientIp: info.clientIp,
        isTranscoded: true,
    }));

    const redirectLive = Array.from(activeRedirectStreams.values()).map(info => ({
        // Use historyId for redirect streamKey to ensure it's unique per session
        streamKey: `${info.userId}::${info.historyId}`, 
        userId: info.userId,
        username: info.username,
        channelName: info.channelName,
        channelLogo: info.channelLogo,
        streamProfileName: info.streamProfileName,
        startTime: info.startTime,
        clientIp: info.clientIp,
        isTranscoded: false,
    }));

    const combinedLiveActivity = [...transcodedLive, ...redirectLive];

    for (const clients of sseClients.values()) {
        clients.forEach(client => {
            if (client.isAdmin) {
                const message = `event: activity-update\ndata: ${JSON.stringify({ live: combinedLiveActivity })}\n\n`;
                client.res.write(message);
            }
        });
    }
    console.log(`[SSE_ADMIN] Broadcasted combined activity update (${combinedLiveActivity.length} live streams) to all connected admins.`);
}

// NEW: Broadcasts an event to ALL connected clients, regardless of user.
function broadcastSseToAll(eventName, data) {
    const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    let clientCount = 0;
    for (const clients of sseClients.values()) {
        clients.forEach(client => {
            client.res.write(message);
            clientCount++;
        });
    }
    console.log(`[SSE_BROADCAST] Broadcasted event '${eventName}' to ${clientCount} total clients.`);
}

function getSettings() {
    const defaultSettings = {
        m3uSources: [],
        epgSources: [],
        userAgents: [{ id: `default-ua-1724778434000`, name: 'ViniPlay Default', value: 'VLC/3.0.20 (Linux; x86_64)', isDefault: true }],
        streamProfiles: [
            { id: 'ffmpeg-default', name: 'ffmpeg (Built in)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: true },
            // FINAL FIX: This is the modern, more compatible command for NVIDIA streaming.
            { id: 'ffmpeg-nvidia', name: 'ffmpeg (NVIDIA NVENC)', command: '-user_agent "{userAgent}" -re -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-nvidia-legacy', name: 'ffmpeg (NVIDIA NVENC - Legacy)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-intel', name: 'ffmpeg (Intel QSV)', command: '-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false },
            // NEW: Add this line for VA-API
            { id: 'ffmpeg-vaapi', name: 'ffmpeg (VA-API)', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf \'format=nv12,hwupload\' -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-nvidia-reconnect', name: 'ffmpeg (NVIDIA reconnect)', command: '-user_agent "{userAgent}" -re -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts pipe:1', isDefault: false },
            { id: 'redirect', name: 'Redirect (No Transcoding)', command: 'redirect', isDefault: false }
        ],
        dvr: {
            preBufferMinutes: 1,
            postBufferMinutes: 2,
            maxConcurrentRecordings: 1,
            autoDeleteDays: 0,
            activeRecordingProfileId: 'dvr-ts-default', // **MODIFIED: Point to the new default profile**
            recordingProfiles: [
                // The primary default for timeshifting, uses almost no CPU.
                { id: 'dvr-ts-default', name: 'Default TS (Stream Copy, Timeshiftable)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c copy -f mpegts "{filePath}"', isDefault: true },
                
                // The new GPU-accelerated option for timeshifting.
                { id: 'dvr-ts-nvidia', name: 'NVIDIA NVENC TS (Timeshiftable)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts "{filePath}"', isDefault: false },
                { id: 'dvr-ts-nvidia-reconnect', name: 'NVIDIA NVENC TS reconnect', command: '-user_agent "{userAgent}" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts "{filePath}"', isDefault: false },

                // Legacy MP4 profiles, no longer default.
                { id: 'dvr-mp4-default', name: 'Legacy MP4 (H.264/AAC)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false },
                { id: 'dvr-mp4-nvidia', name: 'NVIDIA NVENC MP4 (H.264/AAC)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false },
                { id: 'dvr-mp4-intel', name: 'Intel QSV MP4 (H.264/AAC)', command: '-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false },
                // NEW: Add this line for VA-API recording
                { id: 'dvr-mp4-vaapi', name: 'VA-API MP4 (H.264/AAC)', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf \'format=nv12,hwupload\' -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false }
            ]
        },
        activeUserAgentId: `default-ua-1724778434000`,
        activeStreamProfileId: 'ffmpeg-default',
        searchScope: 'channels_only',
        notificationLeadTime: 10,
        sourcesLastUpdated: null
    };

    if (!fs.existsSync(SETTINGS_PATH)) {
        console.log('[SETTINGS] settings.json not found, creating default settings.');
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(defaultSettings, null, 2));
        return defaultSettings;
    }
    try {
        let settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
        
        // --- SETTINGS MIGRATION LOGIC ---
        let needsSave = false;
        
        defaultSettings.streamProfiles.forEach(defaultProfile => {
            const existingProfile = settings.streamProfiles.find(p => p.id === defaultProfile.id);
            if (!existingProfile) {
                console.log(`[SETTINGS_MIGRATE] Adding missing stream profile: ${defaultProfile.name}`);
                settings.streamProfiles.push(defaultProfile);
                needsSave = true;
            } else if (existingProfile.isDefault) {
                 // FINAL FIX: Forcibly update the command of default profiles to ensure users get the latest fixes.
                 if (existingProfile.command !== defaultProfile.command) {
                    console.log(`[SETTINGS_MIGRATE] Updating outdated default stream profile command for: ${defaultProfile.name}`);
                    existingProfile.command = defaultProfile.command;
                    needsSave = true;
                }
            }
        });
        
        if (!settings.dvr) {
            console.log(`[SETTINGS_MIGRATE] Initializing DVR settings block.`);
            settings.dvr = defaultSettings.dvr;
            needsSave = true;
        } else {
            defaultSettings.dvr.recordingProfiles.forEach(defaultProfile => {
                const existingProfile = settings.dvr.recordingProfiles.find(p => p.id === defaultProfile.id);
                if (!existingProfile) {
                    console.log(`[SETTINGS_MIGRATE] Adding missing DVR recording profile: ${defaultProfile.name}`);
                    settings.dvr.recordingProfiles.push(defaultProfile);
                    needsSave = true;
                } else if (existingProfile.isDefault) {
                    // FINAL FIX: Forcibly update the command of default DVR profiles.
                    if (existingProfile.command !== defaultProfile.command) {
                        console.log(`[SETTINGS_MIGRATE] Updating outdated default DVR profile command for: ${defaultProfile.name}`);
                        existingProfile.command = defaultProfile.command;
                        needsSave = true;
                    }
                }
            });
        }
        
        if (needsSave) {
            console.log('[SETTINGS_MIGRATE] Saving updated settings file after migration.');
            fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        }

        return settings;

    } catch (e) {
        console.error("[SETTINGS] Could not parse settings.json, returning default. Error:", e.message);
        return defaultSettings;
    }
}

// ... existing helper functions (saveSettings, fetchUrlContent, parseEpgTime, processAndMergeSources, updateAndScheduleSourceRefreshes) remain the same ...
function saveSettings(settings) {
    try {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        console.log('[SETTINGS] Settings saved successfully.');
        updateAndScheduleSourceRefreshes();
    } catch (e) {
        console.error("[SETTINGS] Error saving settings:", e);
    }
}

function fetchUrlContent(url, options = {}) { // <-- MODIFIED
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const TIMEOUT_DURATION = 60000;
        console.log(`[FETCH] Attempting to fetch URL content: ${url} (Timeout: ${TIMEOUT_DURATION/1000}s)`);

        const request = protocol.get(url, { timeout: TIMEOUT_DURATION, ...options }, (res) => { // <-- MODIFIED
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                console.log(`[FETCH] Redirecting to: ${res.headers.location}`);
                request.abort(); 
                return fetchUrlContent(new URL(res.headers.location, url).href, options).then(resolve, reject); // <-- MODIFIED
            }
            if (res.statusCode !== 200) {
                console.error(`[FETCH] Failed to fetch ${url}: Status Code ${res.statusCode}`);
                return reject(new Error(`Failed to fetch: Status Code ${res.statusCode}`));
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                console.log(`[FETCH] Successfully fetched content from: ${url}`);
                resolve(data);
            });
        });

        request.on('timeout', () => {
            request.destroy();
            const timeoutError = new Error(`Request to ${url} timed out after ${TIMEOUT_DURATION / 1000} seconds.`);
            console.error(`[FETCH] ${timeoutError.message}`);
            reject(timeoutError);
        });

        request.on('error', (err) => {
            console.error(`[FETCH] Network error fetching ${url}: ${err.message}`);
            reject(err);
        });
    });
}


// --- EPG Parsing and Caching Logic ---
const parseEpgTime = (timeStr, offsetHours = 0) => {
    const match = timeStr.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*(([+-])(\d{2})(\d{2}))?/);
    if (!match) {
        console.warn(`[EPG_PARSE] Invalid time format encountered: ${timeStr}`);
        return new Date();
    }
    
    const [ , year, month, day, hours, minutes, seconds, , sign, tzHours, tzMinutes] = match;
    let date;
    if (sign && tzHours && tzMinutes) {
        const epgOffsetMinutes = (parseInt(tzHours) * 60 + parseInt(tzMinutes)) * (sign === '+' ? 1 : -1);
        date = new Date(Date.UTC(year, parseInt(month) - 1, day, hours, minutes, seconds));
        date.setUTCMinutes(date.getUTCMinutes() - epgOffsetMinutes);
    } else {
        date = new Date(Date.UTC(year, parseInt(month) - 1, day, hours, minutes, seconds));
        date.setUTCHours(date.getUTCHours() - offsetHours);
    }
    return date;
};

// server.js -> Replace the entire function with this corrected version

async function processAndMergeSources(req) {
    console.log('[PROCESS] Starting to process and merge all active sources.');
    sendProcessingStatus(req, 'Starting to process sources...', 'info');
    const settings = getSettings();

    // --- NEW: Data holders for separated content ---
    let mergedLiveM3uContent = '#EXTM3U\n';
    let mergedVodMovies = [];
    let mergedVodSeries = [];
    let liveChannelIdSet = new Set(); // To track which channels need EPG
    const groupTitleRegex = /group-title="([^"]*)"/;
    // ---

    const activeM3uSources = settings.m3uSources.filter(s => s.isActive);
    const activeEpgSources = settings.epgSources.filter(s => s.isActive);

    if (activeM3uSources.length === 0) {
        console.log('[PROCESS] No active M3U sources found.');
        sendProcessingStatus(req, 'No active M3U sources found.', 'info');
    }

    for (const source of activeM3uSources) {
        console.log(`[M3U] Processing source: "${source.name}" (ID: ${source.id}, Type: ${source.type}, Path: ${source.path})`);
        sendProcessingStatus(req, `Processing M3U source: "${source.name}"...`, 'info');
        
        // --- NEW: Group Filter Logic ---
        const selectedGroups = source.selectedGroups || [];
        const isGroupFilteringActive = selectedGroups.length > 0;
        if (isGroupFilteringActive) {
            sendProcessingStatus(req, ` -> Applying group filter. ${selectedGroups.length} groups selected.`, 'info');
        }
        // ---

        try {
            let content = '';
            let sourcePathForLog = source.path;
            let m3uFetchOptions = {}; // NEW: For XC User-Agent

            if (source.type === 'file') {
                const sourceFilePath = path.join(SOURCES_DIR, path.basename(source.path));
                if (fs.existsSync(sourceFilePath)) {
                    content = fs.readFileSync(sourceFilePath, 'utf-8');
                    sourcePathForLog = sourceFilePath;
                } else {
                    const errorMsg = `File not found for source "${source.name}". Skipping.`;
                    sendProcessingStatus(req, `Error: ${errorMsg}`, 'error');
                    source.status = 'Error';
                    source.statusMessage = 'File not found.';
                    continue;
                }
            } else if (source.type === 'url') {
                sendProcessingStatus(req, ` -> Fetching content from URL...`, 'info');
                content = await fetchUrlContent(source.path);
                sendProcessingStatus(req, ` -> Successfully fetched M3U content.`, 'info');
            } else if (source.type === 'xc') {
                if (!source.xc_data) {
                    throw new Error("XC source is missing credential data (xc_data).");
                }
                const xcInfo = JSON.parse(source.xc_data);
                const { server, username, password } = xcInfo;

                if (!server || !username || !password) {
                    throw new Error("XC source is missing server, username, or password.");
                }

                // Use the default user agent for XC requests
                m3uFetchOptions = { headers: { 'User-Agent': 'VLC/3.0.20 (Linux; x86_64)' } };
                const m3uUrl = `${server}/get.php?username=${username}&password=${password}&type=m3u_plus&output=ts`;
                console.log(`[M3U] Constructed XC URL for "${source.name}": ${m3uUrl}`);
                sendProcessingStatus(req, ` -> Fetching content from XC server...`, 'info');
                content = await fetchUrlContent(m3uUrl, m3uFetchOptions);
                sourcePathForLog = m3uUrl;
                sendProcessingStatus(req, ` -> Successfully fetched M3U content from XC server.`, 'info');

                const epgUrl = `${server}/xmltv.php?username=${username}&password=${password}`;
                const epgSource = {
                    id: `epg_for_${source.id}`,
                    name: `${source.name} (EPG)`,
                    type: 'url',
                    path: epgUrl,
                    isActive: true,
                    isXcEpg: true,
                    fetchOptions: m3uFetchOptions // Pass fetch options to EPG
                };

                if (!activeEpgSources.some(s => s.id === epgSource.id)) {
                    activeEpgSources.push(epgSource);
                    sendProcessingStatus(req, ` -> Automatically added EPG source for "${source.name}".`, 'info');
                }
            }

            const lines = content.split('\n');
            let currentExtInf = '';
            let liveStreamCount = 0;
            let movieCount = 0;
            let seriesCount = 0;

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].trim();
                if (line.startsWith('#EXTINF:')) {
                    currentExtInf = line;
                    continue;
                }

                if (line.startsWith('http') && currentExtInf) {
                    const streamUrl = line;
                    
                    // --- GROUP FILTER LOGIC ---
                    const groupMatch = currentExtInf.match(groupTitleRegex);
                    const groupTitle = (groupMatch && groupMatch[1]) ? groupMatch[1] : 'Uncategorized';
                    if (isGroupFilteringActive && !selectedGroups.includes(groupTitle)) {
                        currentExtInf = ''; // Reset for next entry
                        continue; // Skip this entry
                    }
                    
                    // --- VOD DETECTION & SEPARATION ---
                    const idMatch = currentExtInf.match(/tvg-id="([^"]*)"/);
                    const tvgId = idMatch ? idMatch[1] : `no-id-${Math.random()}`;
                    const uniqueChannelId = `${source.id}_${tvgId}`;
                    const logoMatch = currentExtInf.match(/tvg-logo="([^"]*)"/);
                    const commaIndex = currentExtInf.lastIndexOf(',');
                    const name = (commaIndex !== -1) ? currentExtInf.substring(commaIndex + 1).trim() : 'Unknown';

                    const baseVodObject = {
                        id: uniqueChannelId,
                        sourceId: source.id,
                        name: name,
                        logo: logoMatch ? logoMatch[1] : '',
                        group: groupTitle,
                        url: streamUrl
                    };

                    // VOD Detection Rules (now checks URL and Group Title)
                    const groupLower = groupTitle.toLowerCase();
                    const isMovie = streamUrl.includes('/movie/') || groupLower.includes('movie') || (groupLower.includes('vod') && !groupLower.includes('series'));
                    const isSeries = streamUrl.includes('/series/') || groupLower.includes('series') || (groupLower.includes('vod') && groupLower.includes('series'));

                    if (isMovie) {
                        mergedVodMovies.push(baseVodObject);
                        movieCount++;
                    } else if (isSeries) {
                        mergedVodSeries.push(baseVodObject);
                        seriesCount++;
                    } else {
                        // --- LIVE CHANNEL ---
                        liveStreamCount++;
                        let processedExtInf = currentExtInf;
                        
                        // Inject unique ID
                        if (idMatch) {
                            processedExtInf = processedExtInf.replace(/tvg-id="[^"]*"/, `tvg-id="${uniqueChannelId}"`);
                        } else {
                            const extinfEnd = processedExtInf.indexOf(' ') + 1;
                            processedExtInf = processedExtInf.slice(0, extinfEnd) + `tvg-id="${uniqueChannelId}" ` + processedExtInf.slice(extinfEnd);
                        }
                        
                        // Inject source name (Corrected Position)
                        const extinfEndWithId = processedExtInf.indexOf(' ') + 1;
                        processedExtInf = processedExtInf.slice(0, extinfEndWithId) + `vini-source="${source.name}" ` + processedExtInf.slice(extinfEndWithId);

                        mergedLiveM3uContent += processedExtInf + '\n' + streamUrl + '\n';
                        liveChannelIdSet.add(uniqueChannelId);
                    }
                    
                    currentExtInf = ''; // Reset for next entry
                }
            }

            source.status = 'Success';
            source.statusMessage = `Processed ${liveStreamCount} Live, ${movieCount} Movies, ${seriesCount} Series.`;
            console.log(`[M3U] Source "${source.name}" processed successfully from ${sourcePathForLog}.`);
            sendProcessingStatus(req, ` -> Processed ${liveStreamCount} Live, ${movieCount} Movies, ${seriesCount} Series from "${source.name}".`, 'info');

        } catch (error) {
            const errorMsg = `Failed to process source "${source.name}" from ${source.path}: ${error.message}`;
            console.error(`[M3U] ${errorMsg}`);
            sendProcessingStatus(req, `Error: ${errorMsg}`, 'error');
            source.status = 'Error';
            source.statusMessage = `Processing failed: ${error.message.substring(0, 100)}...`;
        }
        source.lastUpdated = new Date().toISOString();
    }
    
    // --- Save the new separated files ---
    try {
        fs.writeFileSync(LIVE_CHANNELS_M3U_PATH, mergedLiveM3uContent);
        console.log(`[M3U] Merged LIVE CHANNELS content saved to ${LIVE_CHANNELS_M3U_PATH}.`);
        sendProcessingStatus(req, `Successfully merged all live channels.`, 'success');
        
        fs.writeFileSync(VOD_MOVIES_JSON_PATH, JSON.stringify(mergedVodMovies, null, 2));
        console.log(`[VOD] Merged VOD MOVIES content saved to ${VOD_MOVIES_JSON_PATH}.`);
        sendProcessingStatus(req, `Successfully merged ${mergedVodMovies.length} movies.`, 'success');

        fs.writeFileSync(VOD_SERIES_JSON_PATH, JSON.stringify(mergedVodSeries, null, 2));
        console.log(`[VOD] Merged VOD SERIES content saved to ${VOD_SERIES_JSON_PATH}.`);
        sendProcessingStatus(req, `Successfully merged ${mergedVodSeries.length} series episodes.`, 'success');
        
    } catch (writeErr) {
        console.error(`[PROCESS] Error writing separated content files: ${writeErr.message}`);
        sendProcessingStatus(req, `Error writing output files: ${writeErr.message}`, 'error');
    }

    // --- EPG Processing (now filtered) ---
    const mergedProgramData = {};
    const timezoneOffset = settings.timezoneOffset || 0;

    if (activeEpgSources.length === 0) {
        console.log('[PROCESS] No active EPG sources found.');
        sendProcessingStatus(req, 'No active EPG sources found.', 'info');
    }

    for (const source of activeEpgSources) {
        if (!source.isActive && !source.isXcEpg) continue;

        console.log(`[EPG] Processing source: "${source.name}" (ID: ${source.id}, Type: ${source.type}, Path: ${source.path})`);
        sendProcessingStatus(req, `Processing EPG source: "${source.name}"...`, 'info');
        try {
            let xmlString = '';
            let epgFilePath = path.join(SOURCES_DIR, `epg_${source.id}.xml`);

            if (source.type === 'file') {
                if (fs.existsSync(source.path)) {
                    xmlString = fs.readFileSync(source.path, 'utf-8');
                } else {
                    const errorMsg = `File not found for source "${source.name}". Skipping.`;
                    sendProcessingStatus(req, `Error: ${errorMsg}`, 'error');
                    source.status = 'Error';
                    source.statusMessage = 'File not found.';
                    continue;
                }
            } else if (source.type === 'url') {
                sendProcessingStatus(req, ` -> Fetching content from URL...`, 'info');
                xmlString = await fetchUrlContent(source.path, source.fetchOptions || {});
                sendProcessingStatus(req, ` -> Successfully fetched EPG content.`, 'info');
                try {
                    fs.writeFileSync(epgFilePath, xmlString);
                    console.log(`[EPG] Downloaded EPG for "${source.name}" saved to ${epgFilePath}.`);
                } catch (writeErr) {
                    console.error(`[EPG] Error saving EPG file from URL for "${source.name}": ${writeErr.message}`);
                }
            }

            const epgJson = xmlJS.xml2js(xmlString, { compact: true });
            const programs = epgJson.tv && epgJson.tv.programme ? [].concat(epgJson.tv.programme) : [];
            let programCount = 0;
            let epgAddedCount = 0; // NEW: Count only added programs

            if (programs.length === 0) {
                sendProcessingStatus(req, `Warning: No programs found in "${source.name}".`, 'info');
            }

            const m3uSourceProviders = settings.m3uSources.filter(m3u => m3u.isActive);

            for (const prog of programs) {
                const originalChannelId = prog._attributes?.channel;
                if (!originalChannelId) continue;
                programCount++;

                for(const m3uSource of m3uSourceProviders) {
                    const uniqueChannelId = `${m3uSource.id}_${originalChannelId}`;

                    // --- NEW: EPG FILTERING ---
                    // Only add EPG data if the channel is in our live channel list
                    if (!liveChannelIdSet.has(uniqueChannelId)) {
                        continue;
                    }
                    // ---

                    if (!mergedProgramData[uniqueChannelId]) {
                        mergedProgramData[uniqueChannelId] = [];
                    }
                    
                    epgAddedCount++; // Increment count of *added* programs

                    const titleNode = prog.title && prog.title._cdata ? prog.title._cdata : (prog.title?._text || 'No Title');
                    const descNode = prog.desc && prog.desc._cdata ? prog.desc._cdata : (prog.desc?._text || '');

                    mergedProgramData[uniqueChannelId].push({
                        start: parseEpgTime(prog._attributes.start, timezoneOffset).toISOString(),
                        stop: parseEpgTime(prog._attributes.stop, timezoneOffset).toISOString(),
                        title: titleNode.trim(),
                        desc: descNode.trim()
                    });
                }
            }
            if (!source.isXcEpg) {
                 source.status = 'Success';
                 source.statusMessage = `Processed ${programCount} programs, added ${epgAddedCount} to live guide.`;
                 console.log(`[EPG] Source "${source.name}" processed successfully from ${source.path}.`);
            }
            sendProcessingStatus(req, ` -> Processed ${programCount} programs, added ${epgAddedCount} to live guide from "${source.name}".`, 'info');

        } catch (error) {
            const errorMsg = `Failed to process source "${source.name}" from ${source.path}: ${error.message}`;
            console.error(`[EPG] ${errorMsg}`);
            sendProcessingStatus(req, `Error: ${errorMsg}`, 'error');
             if (!source.isXcEpg) {
                 source.status = 'Error';
                 source.statusMessage = `Processing failed: ${error.message.substring(0, 100)}...`;
             }
        }
         if (!source.isXcEpg) {
            source.lastUpdated = new Date().toISOString();
         }
    }
    for (const channelId in mergedProgramData) {
        mergedProgramData[channelId].sort((a, b) => new Date(a.start) - new Date(b.start));
    }
    try {
        fs.writeFileSync(LIVE_EPG_JSON_PATH, JSON.stringify(mergedProgramData));
        console.log(`[EPG] Merged EPG JSON content saved to ${LIVE_EPG_JSON_PATH}.`);
        sendProcessingStatus(req, `Successfully merged all EPG data for live channels.`, 'success');
    } catch (writeErr) {
        console.error(`[EPG] Error writing merged EPG JSON file: ${writeErr.message}`);
        sendProcessingStatus(req, `Error writing merged EPG JSON file: ${writeErr.message}`, 'error');
    }

    settings.sourcesLastUpdated = new Date().toISOString();
    console.log(`[PROCESS] Finished processing. New 'sourcesLastUpdated' timestamp: ${settings.sourcesLastUpdated}`);
    sendProcessingStatus(req, 'All sources processed successfully!', 'final_success');

    return { success: true, message: 'Sources merged successfully.', updatedSettings: settings };
}

const updateAndScheduleSourceRefreshes = () => {
    console.log('[SCHEDULER] Updating and scheduling all source refreshes...');
    const settings = getSettings();
    const allSources = [...(settings.m3uSources || []), ...(settings.epgSources || [])];
    const activeUrlSources = new Set();

    allSources.forEach(source => {
        if (source.type === 'url' && source.isActive && source.refreshHours > 0) {
            activeUrlSources.add(source.id);
            if (sourceRefreshTimers.has(source.id)) {
                clearTimeout(sourceRefreshTimers.get(source.id));
            }

            console.log(`[SCHEDULER] Scheduling refresh for "${source.name}" (ID: ${source.id}) every ${source.refreshHours} hours.`);
            
            const scheduleNext = () => {
                const timeoutId = setTimeout(async () => {
                    console.log(`[SCHEDULER_RUN] Auto-refresh triggered for "${source.name}".`);
                    try {
                        const result = await processAndMergeSources();
                        if(result.success) {
                            fs.writeFileSync(SETTINGS_PATH, JSON.stringify(result.updatedSettings, null, 2));
                            console.log(`[SCHEDULER_RUN] Successfully refreshed and processed sources for "${source.name}".`);
                        }
                    } catch (error) {
                        console.error(`[SCHEDULER_RUN] Auto-refresh for "${source.name}" failed:`, error.message);
                    }
                    scheduleNext();
                }, source.refreshHours * 3600 * 1000);

                sourceRefreshTimers.set(source.id, timeoutId);
            };

            scheduleNext();
        }
    });

    for (const [sourceId, timeoutId] of sourceRefreshTimers.entries()) {
        if (!activeUrlSources.has(sourceId)) {
            console.log(`[SCHEDULER] Clearing obsolete refresh timer for source ID: ${sourceId}`);
            clearTimeout(timeoutId);
            sourceRefreshTimers.delete(sourceId);
        }
    }
    console.log(`[SCHEDULER] Finished scheduling. Active timers: ${sourceRefreshTimers.size}`);
};
// ... existing helper functions ...

// --- Authentication API Endpoints ---
app.get('/api/auth/needs-setup', (req, res) => {
    console.log('[AUTH_API] Received request for /api/auth/needs-setup');
    db.get("SELECT COUNT(*) as count FROM users WHERE isAdmin = 1", [], (err, row) => {
        if (err) {
            console.error('[AUTH_API] Error checking admin user count:', err.message);
            return res.status(500).json({ error: err.message });
        }
        const needsSetup = row.count === 0;
        console.log(`[AUTH_API] Admin user count: ${row.count}. Needs setup: ${needsSetup}`);
        res.json({ needsSetup });
    });
});

app.post('/api/auth/setup-admin', (req, res) => {
    console.log('[AUTH_API] Received request for /api/auth/setup-admin');
    db.get("SELECT COUNT(*) as count FROM users", [], (err, row) => {
        if (err) {
            console.error('[AUTH_API] Error checking user count during admin setup:', err.message);
            return res.status(500).json({ error: err.message });
        }
        if (row.count > 0) {
            console.warn('[AUTH_API] Setup attempted but users already exist. Denying setup.');
            return res.status(403).json({ error: "Setup has already been completed." });
        }
        
        const { username, password } = req.body;
        if (!username || !password) {
            console.warn('[AUTH_API] Admin setup failed: Username and/or password missing.');
            return res.status(400).json({ error: "Username and password are required." });
        }

        bcrypt.hash(password, saltRounds, (err, hash) => {
            if (err) {
                console.error('[AUTH_API] Error hashing password during admin setup:', err);
                return res.status(500).json({ error: 'Error hashing password.' });
            }
            db.run("INSERT INTO users (username, password, isAdmin, canUseDvr) VALUES (?, ?, 1, 1)", [username, hash], function(err) {
                if (err) {
                    console.error('[AUTH_API] Error inserting admin user:', err.message);
                    return res.status(500).json({ error: err.message });
                }
                req.session.userId = this.lastID;
                req.session.username = username;
                req.session.isAdmin = true;
                req.session.canUseDvr = true;
                console.log(`[AUTH_API] Admin user "${username}" created successfully (ID: ${this.lastID}). Session set.`);
                res.json({ success: true, user: { username: req.session.username, isAdmin: req.session.isAdmin, canUseDvr: req.session.canUseDvr } });
            });
        });
    });
});

app.post('/api/auth/login', (req, res) => {
    console.log('[AUTH_API] Received request for /api/auth/login');
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (err) {
            console.error('[AUTH_API] Error querying user during login:', err.message);
            return res.status(500).json({ error: err.message });
        }
        if (!user) {
            console.warn(`[AUTH_API] Login failed for username "${username}": User not found.`);
            return res.status(401).json({ error: "Invalid username or password." });
        }
        
        bcrypt.compare(password, user.password, (err, result) => {
            if (err) {
                console.error('[AUTH_API] Error comparing password hash:', err);
                return res.status(500).json({ error: 'Authentication error.' });
            }
            if (result) {
                req.session.userId = user.id;
                req.session.username = user.username;
                req.session.isAdmin = user.isAdmin === 1;
                req.session.canUseDvr = user.canUseDvr === 1;
                console.log(`[AUTH_API] User "${username}" (ID: ${user.id}) logged in successfully. Session set.`);
                res.json({
                    success: true,
                    user: { username: user.username, isAdmin: user.isAdmin === 1, canUseDvr: user.canUseDvr === 1 }
                });
            } else {
                console.warn(`[AUTH_API] Login failed for username "${username}": Incorrect password.`);
                res.status(401).json({ error: "Invalid username or password." });
            }
        });
    });
});

app.post('/api/auth/logout', (req, res) => {
    console.log('[AUTH_API] Received request for /api/auth/logout');
    const username = req.session.username || 'unknown';
    req.session.destroy(err => {
        if (err) {
            console.error(`[AUTH_API] Error destroying session for user ${username}:`, err);
            return res.status(500).json({ error: 'Could not log out.' });
        }
        res.clearCookie('connect.sid');
        console.log(`[AUTH_API] User ${username} logged out. Session destroyed.`);
        res.json({ success: true });
    });
});

// --- NEW ENDPOINT FOR GROUP FILTERING ---
app.post('/api/sources/fetch-groups', requireAuth, async (req, res) => {
    const { type, url, xc } = req.body;
    let fetchUrl;
    let fetchOptions = {};
    let content = '';

    console.log(`[API_GROUPS] Fetching groups for type: ${type}`);

    try {
        if (type === 'url' && url) {
            fetchUrl = url;
        } else if (type === 'xc' && xc) {
            const xcInfo = JSON.parse(xc);
            if (!xcInfo.server || !xcInfo.username || !xcInfo.password) {
                return res.status(400).json({ error: 'XC source requires server, username, and password.' });
            }
            fetchUrl = `${xcInfo.server}/get.php?username=${xcInfo.username}&password=${xcInfo.password}&type=m3u_plus&output=ts`;
            fetchOptions = { headers: { 'User-Agent': 'VLC/3.0.20 (Linux; x86_64)' } };
        } else {
            return res.status(400).json({ error: 'Valid URL or XC credentials are required.' });
        }

        content = await fetchUrlContent(fetchUrl, fetchOptions);

        const lines = content.split('\n');
        const groups = new Set();
        const groupRegex = /group-title="([^"]*)"/;

        for (const line of lines) {
            if (line.startsWith('#EXTINF:')) {
                const match = line.match(groupRegex);
                if (match && match[1]) {
                    groups.add(match[1]);
                }
            }
        }

        const sortedGroups = Array.from(groups).sort((a, b) => a.localeCompare(b));
        console.log(`[API_GROUPS] Found ${sortedGroups.length} groups.`);
        res.json({ success: true, groups: sortedGroups });

    } catch (error) {
        console.error(`[API_GROUPS] Failed to fetch or parse M3U for groups: ${error.message}`);
        res.status(500).json({ error: `Failed to fetch groups: ${error.message}` });
    }
});

app.get('/api/auth/status', (req, res) => {
    console.log(`[AUTH_API] GET /api/auth/status - Checking session ID: ${req.sessionID}`);
    if (req.session && req.session.userId) {
        console.log(`[AUTH_API_STATUS] Valid session found for user "${req.session.username}" (ID: ${req.session.userId}). Responding with isLoggedIn: true.`);
        res.json({ isLoggedIn: true, user: { username: req.session.username, isAdmin: req.session.isAdmin, canUseDvr: req.session.canUseDvr } });
    } else {
        console.log('[AUTH_API_STATUS] No valid session found. Responding with isLoggedIn: false.');
        res.json({ isLoggedIn: false });
    }
});
// ... existing User Management API Endpoints ...
app.get('/api/users', requireAdmin, (req, res) => {
    console.log('[USER_API] Fetching all users.');
    db.all("SELECT id, username, isAdmin, canUseDvr FROM users ORDER BY username", [], (err, rows) => {
        if (err) {
            console.error('[USER_API] Error fetching users:', err.message);
            return res.status(500).json({ error: err.message });
        }
        console.log(`[USER_API] Found ${rows.length} users.`);
        res.json(rows);
    });
});

app.post('/api/users', requireAdmin, (req, res) => {
    console.log('[USER_API] Adding new user.');
    const { username, password, isAdmin, canUseDvr } = req.body;
    if (!username || !password) {
        console.warn('[USER_API] Add user failed: Username and/or password missing.');
        return res.status(400).json({ error: "Username and password are required." });
    }
    
    bcrypt.hash(password, saltRounds, (err, hash) => {
        if (err) {
            console.error('[USER_API] Error hashing password for new user:', err);
            return res.status(500).json({ error: 'Error hashing password' });
        }
        db.run("INSERT INTO users (username, password, isAdmin, canUseDvr) VALUES (?, ?, ?, ?)", [username, hash, isAdmin ? 1 : 0, canUseDvr ? 1 : 0], function (err) {
            if (err) {
                console.error('[USER_API] Error inserting new user:', err.message);
                return res.status(400).json({ error: "Username already exists." });
            }
            console.log(`[USER_API] User "${username}" added successfully (ID: ${this.lastID}).`);
            res.json({ success: true, id: this.lastID });
        });
    });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const { username, password, isAdmin, canUseDvr } = req.body;
    console.log(`[USER_API] Updating user ID: ${id}. Username: ${username}, IsAdmin: ${isAdmin}, CanUseDvr: ${canUseDvr}`);

    const updateUser = () => {
        if (password) {
            bcrypt.hash(password, saltRounds, (err, hash) => {
                if (err) {
                    console.error('[USER_API] Error hashing password during user update:', err);
                    return res.status(500).json({ error: 'Error hashing password' });
                }
                db.run("UPDATE users SET username = ?, password = ?, isAdmin = ?, canUseDvr = ? WHERE id = ?", [username, hash, isAdmin ? 1 : 0, canUseDvr ? 1 : 0, id], (err) => {
                    if (err) {
                        console.error(`[USER_API] Error updating user ${id} with new password:`, err.message);
                        return res.status(500).json({ error: err.message });
                    }
                    if (req.session.userId == id) {
                        req.session.username = username;
                        req.session.isAdmin = isAdmin;
                        req.session.canUseDvr = canUseDvr;
                        console.log(`[USER_API] Current user's session (ID: ${id}) updated.`);
                    }
                    console.log(`[USER_API] User ${id} updated successfully (with password change).`);
                    res.json({ success: true });
                });
            });
        } else {
            db.run("UPDATE users SET username = ?, isAdmin = ?, canUseDvr = ? WHERE id = ?", [username, isAdmin ? 1 : 0, canUseDvr ? 1 : 0, id], (err) => {
                if (err) {
                    console.error(`[USER_API] Error updating user ${id} without password change:`, err.message);
                    return res.status(500).json({ error: err.message });
                }
                 if (req.session.userId == id) {
                    req.session.username = username;
                    req.session.isAdmin = isAdmin;
                    req.session.canUseDvr = canUseDvr;
                    console.log(`[USER_API] Current user's session (ID: ${id}) updated.`);
                 }
                console.log(`[USER_API] User ${id} updated successfully (without password change).`);
                res.json({ success: true });
            });
        }
    };
    
    if (req.session.userId == id && !isAdmin) {
        console.log(`[USER_API] Attempting to demote current admin user ${id}. Checking if last admin.`);
         db.get("SELECT COUNT(*) as count FROM users WHERE isAdmin = 1", [], (err, row) => {
            if (err) {
                console.error('[USER_API] Error checking admin count for demotion:', err.message);
                return res.status(500).json({ error: err.message });
            }
            if (row.count <= 1) {
                console.warn(`[USER_API] Cannot demote user ${id}: They are the last administrator.`);
                return res.status(403).json({error: "Cannot remove the last administrator."});
            }
            updateUser();
         });
    } else {
        updateUser();
    }
});

// MODIFIED: User deletion now terminates active streams and forces logout.
app.delete('/api/users/:id', requireAdmin, (req, res) => {
    const idToDelete = parseInt(req.params.id, 10);
    console.log(`[USER_API] Deleting user ID: ${idToDelete}`);
    if (req.session.userId == idToDelete) {
        console.warn(`[USER_API] Attempted to delete own account for user ${idToDelete}.`);
        return res.status(403).json({ error: "You cannot delete your own account." });
    }

    // --- NEW: Terminate active streams for the deleted user ---
    let streamsKilled = 0;
    for (const [streamKey, streamInfo] of activeStreamProcesses.entries()) {
        if (streamInfo.userId === idToDelete) {
            console.log(`[USER_DELETION] Found active stream for deleted user ${idToDelete}. Terminating PID: ${streamInfo.process.pid}.`);
            try {
                streamInfo.process.kill('SIGKILL');
                activeStreamProcesses.delete(streamKey);
                streamsKilled++;
            } catch (e) {
                console.warn(`[USER_DELETION] Error killing stream process for user ${idToDelete}: ${e.message}`);
            }
        }
    }
    if (streamsKilled > 0) {
        console.log(`[USER_DELETION] Terminated ${streamsKilled} active stream(s) for deleted user ${idToDelete}.`);
    }

    // --- NEW: Force logout via SSE ---
    sendSseEvent(idToDelete, 'force-logout', { reason: 'Your account has been deleted by an administrator.' });
    
    db.run("DELETE FROM users WHERE id = ?", idToDelete, function(err) {
        if (err) {
            console.error(`[USER_API] Error deleting user ${idToDelete}:`, err.message);
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            console.warn(`[USER_API] User ${idToDelete} not found for deletion.`);
            return res.status(404).json({ error: 'User not found.' });
        }
        console.log(`[USER_API] User ${idToDelete} deleted successfully from database.`);
        res.json({ success: true });
    });
});
// --- Protected IPTV API Endpoints ---
app.get('/api/config', requireAuth, (req, res) => {
    try {
        // ADDED vodMovies and vodSeries
        let config = { m3uContent: null, epgContent: null, settings: {}, vodMovies: [], vodSeries: [] };
        let globalSettings = getSettings();
        config.settings = globalSettings;

        // UPDATED path
        if (fs.existsSync(LIVE_CHANNELS_M3U_PATH)) {
            config.m3uContent = fs.readFileSync(LIVE_CHANNELS_M3U_PATH, 'utf-8');
            console.log(`[API] Loaded M3U content from ${LIVE_CHANNELS_M3U_PATH}.`);
        } else {
            console.log(`[API] No merged M3U file found at ${LIVE_CHANNELS_M3U_PATH}.`);
        }
        
        // UPDATED path
        if (fs.existsSync(LIVE_EPG_JSON_PATH)) {
            try {
                config.epgContent = JSON.parse(fs.readFileSync(LIVE_EPG_JSON_PATH, 'utf-8'));
                console.log(`[API] Loaded EPG content from ${LIVE_EPG_JSON_PATH}.`);
            } catch (parseError) {
                console.error(`[API] Error parsing merged EPG JSON from ${LIVE_EPG_JSON_PATH}: ${parseError.message}`);
                config.epgContent = {};
            }
        } else {
            console.log(`[API] No merged EPG JSON file found at ${LIVE_EPG_JSON_PATH}.`);
        }

        // --- NEW: Load VOD Files ---
        if (fs.existsSync(VOD_MOVIES_JSON_PATH)) {
            try {
                config.vodMovies = JSON.parse(fs.readFileSync(VOD_MOVIES_JSON_PATH, 'utf-8'));
                console.log(`[API] Loaded ${config.vodMovies.length} movies from ${VOD_MOVIES_JSON_PATH}.`);
            } catch (parseError) {
                console.error(`[API] Error parsing VOD Movies JSON: ${parseError.message}`);
            }
        } else {
            console.log(`[API] No VOD Movies file found at ${VOD_MOVIES_JSON_PATH}.`);
        }

        if (fs.existsSync(VOD_SERIES_JSON_PATH)) {
            try {
                config.vodSeries = JSON.parse(fs.readFileSync(VOD_SERIES_JSON_PATH, 'utf-8'));
                console.log(`[API] Loaded ${config.vodSeries.length} series episodes from ${VOD_SERIES_JSON_PATH}.`);
            } catch (parseError) {
                console.error(`[API] Error parsing VOD Series JSON: ${parseError.message}`);
            }
        } else {
            console.log(`[API] No VOD Series file found at ${VOD_SERIES_JSON_PATH}.`);
        }
        // --- END NEW VOD ---
        
        db.all(`SELECT key, value FROM user_settings WHERE user_id = ?`, [req.session.userId], (err, rows) => {
            if (err) {
                console.error("[API] Error fetching user settings:", err);
                return res.status(200).json(config);
            }
            if (rows) {
                const userSettings = {};
                rows.forEach(row => {
                    try {
                        userSettings[row.key] = JSON.parse(row.value);
                    } catch (e) {
                        userSettings[row.key] = row.value;
                        console.warn(`[API] User setting key "${row.key}" could not be parsed as JSON. Storing as raw string.`);
                    }
                });
                
                config.settings = { ...config.settings, ...userSettings };
                console.log(`[API] Merged user settings for user ID: ${req.session.userId}`);
            }
            res.status(200).json(config);
        });

    } catch (error) {
        console.error("[API] Error reading config or related files:", error);
        res.status(500).json({ error: "Could not load configuration from server." });
    }
});


const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            if (!fs.existsSync(SOURCES_DIR)) {
                fs.mkdirSync(SOURCES_DIR, { recursive: true });
            }
            cb(null, SOURCES_DIR);
        },
        filename: (req, file, cb) => {
            cb(null, `${file.fieldname}-${Date.now()}${path.extname(file.originalname)}`);
        }
    })
});


app.post('/api/sources', requireAuth, upload.single('sourceFile'), async (req, res) => {
    // ADD selectedGroups to the destructured body
    const { sourceType, name, url, isActive, id, refreshHours, xc, selectedGroups } = req.body;
    
    console.log(`[SOURCES_API] ${id ? 'Updating' : 'Adding'} source. Type: ${sourceType}, Name: ${name}`);

    if (!sourceType || !name) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.warn('[SOURCES_API] Source type or name missing for source operation.');
        return res.status(400).json({ error: 'Source type and name are required.' });
    }

    const settings = getSettings();
    const sourceList = sourceType === 'm3u' ? settings.m3uSources : settings.epgSources;

    if (id) { // Update existing source
        const sourceIndex = sourceList.findIndex(s => s.id === id);
        if (sourceIndex === -1) {
            if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            console.warn(`[SOURCES_API] Source ID ${id} not found for update.`);
            return res.status(404).json({ error: 'Source to update not found.' });
        }

        const sourceToUpdate = sourceList[sourceIndex];
        console.log(`[SOURCES_API] Found existing source for update: ${sourceToUpdate.name}`);
        sourceToUpdate.name = name;
        sourceToUpdate.isActive = isActive === 'true';
        sourceToUpdate.refreshHours = parseInt(refreshHours, 10) || 0;
        sourceToUpdate.lastUpdated = new Date().toISOString();
        
        // ADDED: Save selectedGroups
        try {
            sourceToUpdate.selectedGroups = JSON.parse(selectedGroups || '[]');
        } catch (e) {
            console.warn(`[SOURCES_API] Could not parse selectedGroups for source ${id}, saving as empty array.`);
            sourceToUpdate.selectedGroups = [];
        }


        if (req.file) {
            console.log(`[SOURCES_API] New file uploaded for source ${id}. Deleting old file if exists.`);
            if (sourceToUpdate.type === 'file' && fs.existsSync(sourceToUpdate.path)) {
                try {
                    fs.unlinkSync(sourceToUpdate.path);
                    console.log(`[SOURCES_API] Deleted old file: ${sourceToUpdate.path}`);
                } catch (e) { console.error("[SOURCES_API] Could not delete old source file:", e); }
            }
            const extension = sourceType === 'm3u' ? '.m3u' : '.xml';
            const newPath = path.join(SOURCES_DIR, `${sourceType}_${id}${extension}`);
            try {
                fs.renameSync(req.file.path, newPath);
                sourceToUpdate.path = newPath;
                sourceToUpdate.type = 'file';
                delete sourceToUpdate.xc_data;
                console.log(`[SOURCES_API] Renamed uploaded file to: ${newPath}`);
            } catch (e) {
                console.error('[SOURCES_API] Error renaming updated source file:', e);
                return res.status(500).json({ error: 'Could not save updated file.' });
            }
        } else if (url !== undefined && url !== null) {
            console.log(`[SOURCES_API] URL provided for source ${id}.`);
            if (sourceToUpdate.type === 'file' && fs.existsSync(sourceToUpdate.path)) {
                try {
                    fs.unlinkSync(sourceToUpdate.path);
                    console.log(`[SOURCES_API] Deleted old file (switching to URL): ${sourceToUpdate.path}`);
                } catch (e) { console.error("[SOURCES_API] Could not delete old source file (on type change):", e); }
            }
            sourceToUpdate.path = url;
            sourceToUpdate.type = 'url';
            delete sourceToUpdate.xc_data;
        } else if (xc) {
            console.log(`[SOURCES_API] XC credentials provided for source ${id}.`);
             if (sourceToUpdate.type === 'file' && fs.existsSync(sourceToUpdate.path)) {
                try {
                    fs.unlinkSync(sourceToUpdate.path);
                } catch (e) { console.error("[SOURCES_API] Could not delete old source file (on type change):", e); }
            }
            sourceToUpdate.xc_data = xc;
            sourceToUpdate.type = 'xc';
            try {
                const xcData = JSON.parse(xc);
                sourceToUpdate.path = xcData.server || 'Xtream Codes Source';
            } catch(e) {
                sourceToUpdate.path = 'Xtream Codes Source';
            }
        } else if (sourceToUpdate.type === 'file' && !req.file && (!sourceToUpdate.path || !fs.existsSync(sourceToUpdate.path))) {
            console.warn(`[SOURCES_API] Existing file source ${id} has no file and no new file/URL provided.`);
            return res.status(400).json({ error: 'Existing file source requires a new file if original is missing.' });
        }

        saveSettings(settings);
        console.log(`[SOURCES_API] Source ${id} updated successfully.`);
        res.json({ success: true, message: 'Source updated successfully.', settings: getSettings() });

    } else { // Add new source
        let newSource;
        
        // Parse selectedGroups for new sources
        let parsedSelectedGroups = [];
        try {
            parsedSelectedGroups = JSON.parse(selectedGroups || '[]');
        } catch (e) {
            console.warn(`[SOURCES_API] Could not parse selectedGroups for new source, saving as empty array.`);
        }
        
        if (xc) { // It's an XC source
             let xcData = {};
             try {
                 xcData = JSON.parse(xc);
             } catch (e) {
                 console.error("Failed to parse XC JSON data:", e);
                 return res.status(400).json({ error: 'Invalid XC data format.' });
             }
             newSource = {
                 id: `src-${Date.now()}`,
                 name,
                 type: 'xc',
                 path: xcData.server || 'Xtream Codes Source',
                 xc_data: xc,
                 isActive: isActive === 'true',
                 refreshHours: parseInt(refreshHours, 10) || 0,
                 lastUpdated: new Date().toISOString(),
                 status: 'Pending',
                 statusMessage: 'Source added. Process to load data.',
                 selectedGroups: parsedSelectedGroups // ADDED
             };
        } else { // It's a URL or File source
            newSource = {
                id: `src-${Date.now()}`,
                name,
                type: req.file ? 'file' : 'url',
                path: req.file ? req.file.path : url,
                isActive: isActive === 'true',
                refreshHours: parseInt(refreshHours, 10) || 0,
                lastUpdated: new Date().toISOString(),
                status: 'Pending',
                statusMessage: 'Source added. Process to load data.',
                selectedGroups: parsedSelectedGroups // ADDED
            };
        }
        
        if (newSource.type === 'url' && !newSource.path) {
            console.warn('[SOURCES_API] New URL source failed: URL is required.');
            return res.status(400).json({ error: 'URL is required for URL-type source.' });
        }
        if (newSource.type === 'file' && !req.file) {
            console.warn('[SOURCES_API] New file source failed: A file must be selected.');
            return res.status(400).json({ error: 'A file must be selected for new file-based sources.' });
        }

        if (req.file) {
            const extension = sourceType === 'm3u' ? '.m3u' : '.xml';
            const newPath = path.join(SOURCES_DIR, `${sourceType}_${newSource.id}${extension}`);
            try {
                fs.renameSync(req.file.path, newPath);
                newSource.path = newPath;
                console.log(`[SOURCES_API] Renamed uploaded file for new source to: ${newPath}`);
            } catch (e) {
                console.error('[SOURCES_API] Error renaming new source file:', e);
                return res.status(500).json({ error: 'Could not save uploaded file.' });
            }
        }

        sourceList.push(newSource);
        saveSettings(settings);
        console.log(`[SOURCES_API] New source "${name}" added successfully (ID: ${newSource.id}).`);
        res.json({ success: true, message: 'Source added successfully.', settings: getSettings() });
    }
});


app.put('/api/sources/:sourceType/:id', requireAuth, (req, res) => {
    const { sourceType, id } = req.params;
    const { name, path: newPath, isActive } = req.body;
    console.log(`[SOURCES_API] Partial update source ID: ${id}, Type: ${sourceType}, isActive: ${isActive}`);
    
    const settings = getSettings();
    const sourceList = sourceType === 'm3u' ? settings.m3uSources : settings.epgSources;
    const sourceIndex = sourceList.findIndex(s => s.id === id);

    if (sourceIndex === -1) {
        console.warn(`[SOURCES_API] Source ID ${id} not found for partial update.`);
        return res.status(404).json({ error: 'Source not found.' });
    }

    const source = sourceList[sourceIndex];
    source.name = name ?? source.name;
    source.isActive = isActive ?? source.isActive;
    if (source.type === 'url' && newPath !== undefined) {
        source.path = newPath;
    }
    source.lastUpdated = new Date().toISOString();

    saveSettings(settings);
    console.log(`[SOURCES_API] Source ${id} partially updated.`);
    res.json({ success: true, message: 'Source updated.', settings: getSettings() });
});

app.delete('/api/sources/:sourceType/:id', requireAuth, (req, res) => {
    const { sourceType, id } = req.params;
    console.log(`[SOURCES_API] Deleting source ID: ${id}, Type: ${sourceType}`);
    
    const settings = getSettings();
    let sourceList = sourceType === 'm3u' ? settings.m3uSources : settings.epgSources;
    const source = sourceList.find(s => s.id === id);
    
    if (source && source.type === 'file' && fs.existsSync(source.path)) {
        try {
            fs.unlinkSync(source.path);
            console.log(`[SOURCES_API] Deleted associated file: ${source.path}`);
        } catch (e) {
            console.error(`[SOURCES_API] Could not delete source file: ${source.path}`, e);
        }
    }
    
    const initialLength = sourceList.length;
    const newList = sourceList.filter(s => s.id !== id);
    if (sourceType === 'm3u') settings.m3uSources = newList;
    else settings.epgSources = newList;

    if (newList.length === initialLength) {
        console.warn(`[SOURCES_API] Source ID ${id} not found for deletion.`);
        return res.status(404).json({ error: 'Source not found.' });
    }

    saveSettings(settings);
    console.log(`[SOURCES_API] Source ${id} deleted successfully.`);
    res.json({ success: true, message: 'Source deleted.', settings: getSettings() });
});

app.post('/api/process-sources', requireAuth, async (req, res) => {
    console.log('[API] Received request to /api/process-sources (manual trigger).');
    try {
        const result = await processAndMergeSources(req); // <-- MODIFIED: Pass req

        if (result.success) {
            fs.writeFileSync(SETTINGS_PATH, JSON.stringify(result.updatedSettings, null, 2));
            console.log('[API] Source processing completed and settings saved (manual trigger).');
            res.json({ success: true, message: 'Sources merged successfully.'});
        } else {
            res.status(500).json({ error: result.message || 'Failed to process sources.' });
        }
    }
    catch (error) {
        console.error("[API] Error during manual source processing:", error);
        sendProcessingStatus(req, `A critical error occurred: ${error.message}`, 'error'); // <-- MODIFIED
        res.status(500).json({ error: 'Failed to process sources. Check server logs.' });
    }
});


app.post('/api/save/settings', requireAuth, async (req, res) => {
    console.log('[API] Received request to /api/save/settings.');
    try {
        let currentSettings = getSettings();
        
        const oldTimezone = currentSettings.timezoneOffset;

        const updatedSettings = { ...currentSettings };
        for (const key in req.body) {
            if (!['favorites', 'playerDimensions', 'programDetailsDimensions', 'recentChannels', 'multiviewLayouts'].includes(key)) {
                updatedSettings[key] = req.body[key];
            } else {
                console.warn(`[SETTINGS_SAVE] Attempted to save user-specific key "${key}" to global settings. This is ignored.`);
            }
        }

        saveSettings(updatedSettings);
        
        if (updatedSettings.timezoneOffset !== oldTimezone) {
            console.log("[API] Timezone setting changed, re-processing sources.");
            const result = await processAndMergeSources();
             if (result.success) {
                fs.writeFileSync(SETTINGS_PATH, JSON.stringify(result.updatedSettings, null, 2));
             }
        }

        res.json({ success: true, message: 'Settings saved.', settings: getSettings() });
    } catch (error) {
        console.error("[API] Error saving global settings:", error);
        res.status(500).json({ error: "Could not save settings. Check server logs." });
    }
});
// ... existing endpoint ...
app.post('/api/user/settings', requireAuth, (req, res) => {
    const { key, value } = req.body;
    const userId = req.session.userId;
    console.log(`[API] Saving user setting for user ${userId}: ${key}`);

    if (!key) {
        return res.status(400).json({ error: 'A setting key is required.' });
    }
    
    const valueJson = JSON.stringify(value);

    const saveAndRespond = () => {
        let globalSettings = getSettings();
        db.all(`SELECT key, value FROM user_settings WHERE user_id = ?`, [userId], (err, rows) => {
            if (err) {
                console.error("[API] Error re-fetching user settings after save:", err);
                return res.status(500).json({ error: 'Could not retrieve updated settings.' });
            }
            const userSettings = {};
            rows.forEach(row => {
                try { userSettings[row.key] = JSON.parse(row.value); } 
                catch (e) { userSettings[row.key] = row.value; }
            });

            const finalSettings = { ...globalSettings, ...userSettings };
            res.json({ success: true, settings: finalSettings });
        });
    };

    db.run(
        `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
        [userId, key, valueJson],
        function (err) {
            if (err) {
                console.error(`[API] Error saving user setting for user ${userId}, key ${key}:`, err);
                return res.status(500).json({ error: 'Could not save user setting.' });
            }
            console.log(`[API] User setting for user ${userId}, key ${key} saved successfully.`);
            saveAndRespond();
        }
    );
});
// --- Notification Endpoints ---
// ... existing endpoints ...
app.get('/api/notifications/vapid-public-key', requireAuth, (req, res) => {
    console.log('[PUSH_API] Request for VAPID public key.');
    if (!vapidKeys.publicKey) {
        console.error('[PUSH_API] VAPID public key not available on the server.');
        return res.status(500).json({ error: 'VAPID public key not available on the server.' });
    }
    res.send(vapidKeys.publicKey);
});

app.post('/api/notifications/subscribe', requireAuth, (req, res) => {
    console.log(`[PUSH_API] Subscribe request for user ${req.session.userId}.`);
    const subscription = req.body;
    const userId = req.session.userId;

    if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
        console.warn('[PUSH_API] Invalid subscription object received.');
        return res.status(400).json({ error: 'Invalid subscription object.' });
    }

    const { endpoint, keys: { p256dh, auth } } = subscription;

    db.run(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`,
        [userId, endpoint, p256dh, auth],
        function(err) {
            if (err) {
                console.error(`[PUSH_API] Error saving push subscription for user ${userId}:`, err);
                return res.status(500).json({ error: 'Could not save subscription.' });
            }
            console.log(`[PUSH] User ${userId} subscribed with endpoint: ${endpoint}. (ID: ${this.lastID || 'existing'})`);
            res.status(201).json({ success: true });
        }
    );
});

app.post('/api/notifications/unsubscribe', requireAuth, (req, res) => {
    console.log(`[PUSH_API] Unsubscribe request for user ${req.session.userId}.`);
    const { endpoint } = req.body;
    if (!endpoint) {
        console.warn('[PUSH_API] Unsubscribe failed: Endpoint is required.');
        return res.status(400).json({ error: 'Endpoint is required to unsubscribe.' });
    }

    db.run("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?", [endpoint, req.session.userId], function(err) {
        if (err) {
            console.error(`[PUSH_API] Error deleting push subscription for user ${req.session.userId}, endpoint ${endpoint}:`, err);
            return res.status(500).json({ error: 'Could not unsubscribe.' });
        }
        if (this.changes === 0) {
            console.warn(`[PUSH_API] No subscription found for user ${req.session.userId} with endpoint ${endpoint} for deletion.`);
            return res.status(404).json({ error: 'Subscription not found or unauthorized.' });
        }
        console.log(`[PUSH] User ${req.session.userId} unsubscribed from endpoint: ${endpoint}`);
        res.json({ success: true });
    });
});

app.post('/api/notifications', requireAuth, (req, res) => {
    const { channelId, channelName, channelLogo, programTitle, programDesc, programStart, programStop, scheduledTime, programId } = req.body;
    const userId = req.session.userId;

    if (!channelId || !programTitle || !programStart || !scheduledTime || !programId || !channelName) {
        console.error(`[PUSH_API_ERROR] Add notification failed for user ${userId} due to missing data.`, { body: req.body });
        return res.status(400).json({ error: 'Invalid notification data. All required fields must be provided.' });
    }
    
    console.log(`[PUSH_API] Adding notification for user ${userId}. Program: "${programTitle}", Channel: "${channelName}", Scheduled Time: ${scheduledTime}`);

    db.run(`INSERT INTO notifications (user_id, channelId, channelName, channelLogo, programTitle, programDesc, programStart, programStop, notificationTime, programId, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [userId, channelId, channelName, channelLogo || '', programTitle, programDesc || '', programStart, programStop, scheduledTime, programId],
        function (err) {
            if (err) {
                console.error(`[PUSH_API_ERROR] Database error adding notification for user ${userId}:`, err);
                return res.status(500).json({ error: 'Could not add notification to the database.' });
            }
            const notificationId = this.lastID;
            console.log(`[PUSH_API] Notification added successfully for program "${programTitle}" (DB ID: ${notificationId}) for user ${userId}.`);
            
            db.all("SELECT id FROM push_subscriptions WHERE user_id = ?", [userId], (subErr, subs) => {
                if (subErr) {
                    console.error(`[PUSH_API_ERROR] Could not fetch subscriptions for user ${userId} to create deliveries.`, subErr);
                    return;
                }
                const now = new Date().toISOString();
                const deliveryStmt = db.prepare("INSERT INTO notification_deliveries (notification_id, subscription_id, status, updatedAt) VALUES (?, ?, 'pending', ?)");
                subs.forEach(sub => {
                    deliveryStmt.run(notificationId, sub.id, now);
                });
                deliveryStmt.finalize(finalizeErr => {
                    if (finalizeErr) console.error(`[PUSH_API_ERROR] Error finalizing delivery creation for notification ${notificationId}.`, finalizeErr);
                    else console.log(`[PUSH_API] Created ${subs.length} delivery records for notification ${notificationId}.`);
                });
            });

            res.status(201).json({ success: true, id: notificationId });
        }
    );
});
app.get('/api/notifications', requireAuth, (req, res) => {
    console.log(`[PUSH_API] Fetching notifications for user ${req.session.userId}.`);
    const query = `
        SELECT
            n.id,
            n.user_id,
            n.channelId,
            n.channelName,
            n.channelLogo,
            n.programTitle,
            n.programDesc,
            n.programStart,
            n.programStop,
            n.notificationTime as scheduledTime,
            n.programId,
            -- Determine the overall status based on its deliveries
            CASE
                WHEN (SELECT COUNT(*) FROM notification_deliveries WHERE notification_id = n.id AND status = 'sent') > 0 THEN 'sent'
                WHEN (SELECT COUNT(*) FROM notification_deliveries WHERE notification_id = n.id AND status = 'expired') > 0 THEN 'expired'
                ELSE n.status
            END as status,
            -- Use the latest delivery update time as the triggeredAt time for consistency
            (SELECT MAX(updatedAt) FROM notification_deliveries WHERE notification_id = n.id AND status = 'sent') as triggeredAt
        FROM notifications n
        WHERE n.user_id = ?
        ORDER BY n.notificationTime DESC
    `;
    db.all(query, [req.session.userId], (err, rows) => {
        if (err) {
            console.error('[PUSH_API] Error fetching consolidated notifications from database:', err);
            return res.status(500).json({ error: 'Could not retrieve notifications.' });
        }
        console.log(`[PUSH_API] Found ${rows.length} consolidated notifications for user ${req.session.userId}.`);
        res.json(rows);
    });
});

// MODIFIED: Reordered this route to be BEFORE the /:id route to fix the 404 error.
app.delete('/api/notifications/past', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const now = new Date().toISOString();
    console.log(`[PUSH_API] Clearing all past notifications for user ${userId}.`);
    
    // This query deletes notifications whose scheduled trigger time is in the past.
    db.run(`DELETE FROM notifications WHERE user_id = ? AND notificationTime <= ?`,
        [userId, now],
        function(err) {
            if (err) {
                console.error(`[PUSH_API] Error deleting past notifications for user ${userId}:`, err.message);
                return res.status(500).json({ error: 'Could not clear past notifications.' });
            }
            console.log(`[PUSH_API] Cleared ${this.changes} past notifications for user ${userId}.`);
            res.json({ success: true, deletedCount: this.changes });
        }
    );
});

app.delete('/api/notifications/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    console.log(`[PUSH_API] Deleting notification ID: ${id} for user ${req.session.userId}.`);
    db.run(`DELETE FROM notifications WHERE id = ? AND user_id = ?`,
        [id, req.session.userId],
        function (err) {
            if (err) {
                console.error(`[PUSH_API] Error deleting notification ${id} from database:`, err);
                return res.status(500).json({ error: 'Could not delete notification.' });
            }
            if (this.changes === 0) {
                console.warn(`[PUSH_API] Notification ${id} not found or unauthorized for user ${req.session.userId}.`);
                return res.status(404).json({ error: 'Notification not found or unauthorized.' });
            }
            console.log(`[PUSH_API] Notification ${id} deleted successfully for user ${req.session.userId}.`);
            res.json({ success: true });
    });
});

app.delete('/api/data', requireAuth, requireAdmin, (req, res) => {
    console.log(`[API_RESET] ADMIN ACTION: Received request to /api/data (HARD RESET) from admin ${req.session.username}.`);
    try {
        console.log('[API_RESET] Stopping all scheduled tasks...');
        if (notificationCheckInterval) clearInterval(notificationCheckInterval);
        for (const timer of sourceRefreshTimers.values()) clearTimeout(timer);
        sourceRefreshTimers.clear();
        for (const job of activeDvrJobs.values()) job.cancel();
        activeDvrJobs.clear();
        for (const { process: ffmpegProcess } of activeStreamProcesses.values()) {
             try { ffmpegProcess.kill('SIGKILL'); } catch (e) {}
        }
        activeStreamProcesses.clear();
        for (const pid of runningFFmpegProcesses.values()) {
            try { process.kill(pid, 'SIGKILL'); } catch (e) {}
        }
        runningFFmpegProcesses.clear();

        console.log('[API_RESET] Wiping all data files...');
        const filesToDelete = [LIVE_CHANNELS_M3U_PATH, LIVE_EPG_JSON_PATH, VOD_MOVIES_JSON_PATH, VOD_SERIES_JSON_PATH, SETTINGS_PATH, VAPID_KEYS_PATH];
        filesToDelete.forEach(file => {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        });
        
        [SOURCES_DIR, DVR_DIR].forEach(dir => {
            if(fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
                fs.mkdirSync(dir, { recursive: true });
            }
        });
        
        console.log('[API_RESET] Wiping all database tables...');
        const tables = ['stream_history', 'dvr_recordings', 'dvr_jobs', 'notification_deliveries', 'notifications', 'push_subscriptions', 'multiview_layouts', 'user_settings', 'users', 'sessions'];
        db.serialize(() => {
            tables.forEach(table => {
                db.run(`DELETE FROM ${table}`, (err) => {
                    if (err) console.error(`[API_RESET] Error clearing table ${table}:`, err.message);
                });
            });
        });

        console.log('[API_RESET] Hard reset complete. The application is now in a fresh-install state.');
        res.json({ success: true, message: 'All application data has been cleared.' });

    } catch (error) {
        console.error("[API_RESET] Critical error during hard reset:", error);
        res.status(500).json({ error: "Failed to reset application data." });
    }
});


// MODIFIED: Stream endpoint now logs to history and has enhanced tracking.
app.get('/stream', requireAuth, async (req, res) => {
    const streamUrl = req.query.url;
    const profileId = req.query.profileId;
    const userAgentId = req.query.userAgentId;
    const userId = req.session.userId;
    const username = req.session.username;
    const clientIp = req.clientIp;
    
    // A unique key for this user and this stream URL
    const streamKey = `${userId}::${streamUrl}`;

    const activeStreamInfo = activeStreamProcesses.get(streamKey);
    
    if (activeStreamInfo) {
        activeStreamInfo.references++;
        activeStreamInfo.lastAccess = Date.now();
        console.log(`[STREAM] Existing stream requested. Key: ${streamKey}. New ref count: ${activeStreamInfo.references}.`);
        activeStreamInfo.process.stdout.pipe(res);
        
        req.on('close', () => {
            console.log(`[STREAM] Client closed connection for existing stream ${streamKey}. Decrementing ref count.`);
            activeStreamInfo.references--;
            activeStreamInfo.lastAccess = Date.now();
            if (activeStreamInfo.references <= 0) {
                console.log(`[STREAM] Last client disconnected. Ref count is 0. Process for PID: ${activeStreamInfo.process.pid} will be cleaned up by the janitor.`);
            }
        });
        return;
    }

    console.log(`[STREAM] New request: URL=${streamUrl}, ProfileID=${profileId}, UserAgentID=${userAgentId}`);
    if (!streamUrl) return res.status(400).send('Error: `url` query parameter is required.');

    let settings = getSettings();
    const profile = (settings.streamProfiles || []).find(p => p.id === profileId);

    if (!profile) {
        console.error(`[STREAM] Stream profile with ID "${profileId}" not found in settings.`);
        return res.status(404).send(`Error: Stream profile with ID "${profileId}" not found.`);
    }
    
    // NEW: Determine if this is a transcoding or direct stream
    const isTranscoded = profile.command !== 'redirect';

    if (!isTranscoded) {
        console.log(`[STREAM] Redirecting to stream URL: ${streamUrl}`);
        return res.redirect(302, streamUrl);
    }
    
    const userAgent = (settings.userAgents || []).find(ua => ua.id === userAgentId);
    if (!userAgent) {
        console.error(`[STREAM] User agent with ID "${userAgentId}" not found in settings.`);
        return res.status(404).send(`Error: User agent with ID "${userAgentId}" not found.`);
    }

    //-- ENHANCEMENT: Find channel name and logo for logging.
    const allChannels = parseM3U(fs.existsSync(LIVE_CHANNELS_M3U_PATH) ? fs.readFileSync(LIVE_CHANNELS_M3U_PATH, 'utf-8') : '');
    const channel = allChannels.find(c => c.url === streamUrl);
    const channelName = channel ? channel.displayName || channel.name : 'Direct Stream';
    const channelId = channel ? channel.id : null;
    const channelLogo = channel ? channel.logo : null;
    const streamProfileName = profile ? profile.name : 'Unknown Profile';
    
    console.log(`[STREAM] Using Profile='${profile.name}' (ID=${profile.id}), UserAgent='${userAgent.name}'`);

    const commandTemplate = profile.command
        .replace(/{streamUrl}/g, streamUrl)
        .replace(/{userAgent}|{clientUserAgent}/g, userAgent.value);
        
    const args = (commandTemplate.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(arg => arg.replace(/^"|"$/g, ''));

    console.log(`[STREAM] FFmpeg command args: ffmpeg ${args.join(' ')}`);
    const ffmpeg = spawn('ffmpeg', args);

    //-- ENHANCEMENT: Log richer stream start data to history.
    const startTime = new Date().toISOString();
    db.run(
        `INSERT INTO stream_history (user_id, username, channel_id, channel_name, start_time, status, client_ip, channel_logo, stream_profile_name) VALUES (?, ?, ?, ?, ?, 'playing', ?, ?, ?)`,
        [userId, username, channelId, channelName, startTime, clientIp, channelLogo, streamProfileName],
        function(err) {
            if (err) {
                console.error('[STREAM_HISTORY] Error logging stream start:', err.message);
            } else {
                const historyId = this.lastID;
                console.log(`[STREAM_HISTORY] Logged stream start with history ID: ${historyId}`);
                
                // Now that we have the history ID, store it with the process
                const newStreamInfo = {
                    process: ffmpeg,
                    references: 1,
                    lastAccess: Date.now(),
                    userId,
                    username,
                    channelId,
                    channelName,
                    channelLogo, // Store logo
                    streamProfileName, // Store profile name
                    startTime,
                    historyId,
                    clientIp,
                    streamKey,
                    isTranscoded, // NEW: Store transcoding status
                };
                activeStreamProcesses.set(streamKey, newStreamInfo);
                console.log(`[STREAM] Started FFMPEG process with PID: ${ffmpeg.pid} for user ${userId} for stream key: ${streamKey}.`);
                //-- ENHANCEMENT: Notify admins that a new stream has started.
                broadcastAdminUpdate();
            }
        }
    );
    
    res.setHeader('Content-Type', 'video/mp2t');
    ffmpeg.stdout.pipe(res);
    
    ffmpeg.stderr.on('data', (data) => console.error(`[FFMPEG_ERROR] Stream: ${streamKey} - ${data.toString().trim()}`));
    
    const cleanupOnExit = () => {
        const info = activeStreamProcesses.get(streamKey);
        if (info && info.historyId) {
            const endTime = new Date().toISOString();
            const duration = Math.round((new Date(endTime).getTime() - new Date(info.startTime).getTime()) / 1000);
            db.run("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND status = 'playing'",
                [endTime, duration, info.historyId]);
        }
        activeStreamProcesses.delete(streamKey);
        //-- ENHANCEMENT: Notify admins that a stream has ended.
        broadcastAdminUpdate();
    };

    ffmpeg.on('close', (code) => {
        console.log(`[STREAM] ffmpeg process for ${streamKey} exited with code ${code}`);
        cleanupOnExit();
        if (!res.headersSent) res.status(500).send('FFmpeg stream ended unexpectedly or failed to start.');
        else res.end();
    });
    ffmpeg.on('error', (err) => {
        console.error(`[STREAM] Failed to start ffmpeg process for ${streamKey}: ${err.message}`);
        cleanupOnExit();
        if (!res.headersSent) res.status(500).send('Failed to start streaming service. Check server logs.');
    });
    
    req.on('close', () => {
        const info = activeStreamProcesses.get(streamKey);
        if (info) {
             console.log(`[STREAM] Client closed connection for new stream ${streamKey}. Decrementing ref count.`);
             info.references--;
             info.lastAccess = Date.now();
             if (info.references <= 0) {
                console.log(`[STREAM] Last client disconnected. Ref count is 0. Process for PID: ${info.process.pid} will be cleaned up by the janitor.`);
            }
        } else {
            console.log(`[STREAM] Client closed connection for ${streamKey}, but no process was found in the map.`);
        }
    });
});

app.post('/api/stream/stop', requireAuth, (req, res) => {
    const { url: streamUrl } = req.body;
    const streamKey = `${req.session.userId}::${streamUrl}`;

    if (!streamUrl) {
        return res.status(400).json({ error: "Stream URL is required to stop the stream." });
    }

    const activeStreamInfo = activeStreamProcesses.get(streamKey);

    if (activeStreamInfo) {
        console.log(`[STREAM_STOP_API] Received request to stop stream for user ${req.session.userId}. Terminating key: ${streamKey}`);
        try {
            if (activeStreamInfo.historyId) {
                const endTime = new Date().toISOString();
                const duration = Math.round((new Date(endTime).getTime() - new Date(activeStreamInfo.startTime).getTime()) / 1000);
                db.run("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND status = 'playing'",
                    [endTime, duration, activeStreamInfo.historyId]);
            }
            activeStreamInfo.process.kill('SIGKILL');
            activeStreamProcesses.delete(streamKey);
            //-- ENHANCEMENT: Notify admins that a stream has ended.
            broadcastAdminUpdate();
            console.log(`[STREAM_STOP_API] Successfully terminated process for key: ${streamKey}`);
        } catch (e) {
            console.warn(`[STREAM_STOP_API] Could not kill process for key: ${streamKey}. It might have already exited. Error: ${e.message}`);
        }
        res.json({ success: true, message: `Stream process for ${streamKey} terminated.` });
    } else {
        console.log(`[STREAM_STOP_API] Received stop request for user ${req.session.userId}, but no active stream was found for key: ${streamKey}`);
        res.json({ success: true, message: 'No active stream to stop.' });
    }
});

app.post('/api/activity/start-redirect', requireAuth, (req, res) => {
    const { streamUrl, channelId, channelName, channelLogo } = req.body;
    const userId = req.session.userId;
    const username = req.session.username;
    const clientIp = req.clientIp;
    const startTime = new Date().toISOString();

    db.run(
        `INSERT INTO stream_history (user_id, username, channel_id, channel_name, start_time, status, client_ip, channel_logo, stream_profile_name) VALUES (?, ?, ?, ?, ?, 'playing', ?, ?, ?)`,
        [userId, username, channelId, channelName, startTime, clientIp, channelLogo, 'Redirect'],
        function(err) {
            if (err) {
                console.error('[REDIRECT_LOG] Error logging redirect stream start:', err.message);
                return res.status(500).json({ error: 'Could not log stream start.' });
            }
            const historyId = this.lastID;
            console.log(`[REDIRECT_LOG] Logged redirect stream start for user ${username} with history ID: ${historyId}`);
            
            // --- NEW: Add to live tracking ---
            const streamKey = `${userId}::${historyId}`;
            activeRedirectStreams.set(streamKey, {
                streamKey,
                userId,
                username,
                channelId,
                channelName,
                channelLogo,
                streamProfileName: 'Redirect',
                startTime,
                clientIp,
                isTranscoded: false,
                historyId,
            });
            broadcastAdminUpdate(); // Notify admins
            // --- END NEW ---

            res.status(201).json({ success: true, historyId });
        }
    );
});

app.post('/api/activity/stop-redirect', requireAuth, (req, res) => {
    const { historyId } = req.body;
    if (!historyId) {
        return res.status(400).json({ error: 'History ID is required.' });
    }

    // --- NEW: Remove from live tracking ---
    const streamKey = `${req.session.userId}::${historyId}`;
    if (activeRedirectStreams.has(streamKey)) {
        activeRedirectStreams.delete(streamKey);
        broadcastAdminUpdate(); // Notify admins
    }
    // --- END NEW ---

    const endTime = new Date().toISOString();
    db.get("SELECT start_time FROM stream_history WHERE id = ? AND user_id = ?", [historyId, req.session.userId], (err, row) => {
        if (err || !row) {
            // Even if history isn't found, we should respond successfully as the client's goal is to stop.
            return res.status(200).json({ success: true, message: 'Stream stopped, history record not found.' });
        }
        const duration = Math.round((new Date(endTime).getTime() - new Date(row.start_time).getTime()) / 1000);
        db.run("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND end_time IS NULL",
            [endTime, duration, historyId],
            (updateErr) => {
                if (updateErr) {
                    console.error(`[REDIRECT_LOG] Error updating redirect stream end for history ID ${historyId}:`, updateErr.message);
                    return res.status(500).json({ error: 'Could not log stream end.' });
                }
                console.log(`[REDIRECT_LOG] Logged redirect stream end for history ID: ${historyId}`);
                res.json({ success: true });
            }
        );
    });
});

// --- NEW/MODIFIED: Admin Monitoring Endpoints ---
app.get('/api/admin/activity', requireAuth, requireAdmin, async (req, res) => {
    // 1. Get Live Activity (already up-to-date in memory)
    const transcodedLive = Array.from(activeStreamProcesses.values()).map(info => ({
        streamKey: info.streamKey,
        userId: info.userId,
        username: info.username,
        channelName: info.channelName,
        channelLogo: info.channelLogo,
        streamProfileName: info.streamProfileName,
        startTime: info.startTime,
        clientIp: info.clientIp,
        isTranscoded: true,
    }));

    const redirectLive = Array.from(activeRedirectStreams.values()).map(info => ({
        streamKey: `${info.userId}::${info.historyId}`,
        userId: info.userId,
        username: info.username,
        channelName: info.channelName,
        channelLogo: info.channelLogo,
        streamProfileName: info.streamProfileName,
        startTime: info.startTime,
        clientIp: info.clientIp,
        isTranscoded: false,
    }));
    
    const liveActivity = [...transcodedLive, ...redirectLive];

    // 2. Get Paginated and Filtered History
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const pageSize = parseInt(req.query.pageSize, 10) || 25;
        const search = req.query.search || '';
        const dateFilter = req.query.dateFilter || 'all';
        const customStart = req.query.startDate;
        const customEnd = req.query.endDate;

        const offset = (page - 1) * pageSize;

        let whereClauses = [];
        let queryParams = [];

        if (search) {
            whereClauses.push(`(username LIKE ? OR channel_name LIKE ? OR client_ip LIKE ? OR stream_profile_name LIKE ?)`);
            const searchTerm = `%${search}%`;
            queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
        }

        const now = new Date();
        if (dateFilter === '24h') {
            whereClauses.push(`start_time >= ?`);
            queryParams.push(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());
        } else if (dateFilter === '7d') {
            whereClauses.push(`start_time >= ?`);
            queryParams.push(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
        } else if (dateFilter === 'custom' && customStart && customEnd) {
            whereClauses.push(`start_time BETWEEN ? AND ?`);
            queryParams.push(new Date(customStart).toISOString(), new Date(customEnd).toISOString());
        }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // Count total items with filters
        const countResult = await new Promise((resolve, reject) => {
            db.get(`SELECT COUNT(*) as total FROM stream_history ${whereString}`, queryParams, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        const totalItems = countResult.total;

        // Get paginated items with filters
        const historyItems = await new Promise((resolve, reject) => {
            const query = `SELECT * FROM stream_history ${whereString} ORDER BY start_time DESC LIMIT ? OFFSET ?`;
            db.all(query, [...queryParams, pageSize, offset], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
        
        const history = {
            items: historyItems,
            totalItems: totalItems,
            totalPages: Math.ceil(totalItems / pageSize),
            currentPage: page,
            pageSize: pageSize,
        };

        res.json({ live: liveActivity, history });

    } catch (err) {
        console.error('[ADMIN_API] Error fetching paginated stream history:', err.message);
        return res.status(500).json({ error: "Could not retrieve stream history." });
    }
});


app.post('/api/admin/stop-stream', requireAuth, requireAdmin, (req, res) => {
    const { streamKey } = req.body;
    if (!streamKey) {
        return res.status(400).json({ error: "A streamKey is required to stop the stream." });
    }

    const streamInfo = activeStreamProcesses.get(streamKey);
    if (streamInfo) {
        console.log(`[ADMIN_API] Admin ${req.session.username} is terminating stream ${streamKey} for user ${streamInfo.username}.`);
        try {
            if (streamInfo.historyId) {
                const endTime = new Date().toISOString();
                const duration = Math.round((new Date(endTime).getTime() - new Date(streamInfo.startTime).getTime()) / 1000);
                db.run("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND status = 'playing'",
                    [endTime, duration, streamInfo.historyId]);
            }
            streamInfo.process.kill('SIGKILL');
            activeStreamProcesses.delete(streamKey);
            //-- ENHANCEMENT: Notify admins that a stream has ended.
            broadcastAdminUpdate();
            res.json({ success: true, message: `Stream terminated for user ${streamInfo.username}.` });
        } catch (e) {
            console.error(`[ADMIN_API] Error terminating stream ${streamKey}: ${e.message}`);
            res.status(500).json({ error: "Failed to terminate stream process." });
        }
    } else {
        res.status(404).json({ error: "Active stream not found." });
    }
});

//-- ENHANCEMENT: New endpoint for admins to change a user's live stream.
app.post('/api/admin/change-stream', requireAuth, requireAdmin, (req, res) => {
    // FIX: Parse userId from the request body as an integer to prevent type mismatch.
    const { userId: userIdString, streamKey, channel } = req.body;
    const userId = parseInt(userIdString, 10);

    if (!userId || !streamKey || !channel) {
        return res.status(400).json({ error: "User ID, stream key, and channel data are required." });
    }

    const streamInfo = activeStreamProcesses.get(streamKey);
    // The comparison below will now work correctly because userId is a number.
    if (!streamInfo || streamInfo.userId !== userId) {
        return res.status(404).json({ error: "The specified stream is not active for this user." });
    }

    console.log(`[ADMIN_API] Admin ${req.session.username} is changing channel for user ${streamInfo.username} to "${channel.name}".`);

    // Send the change-channel event to the target user's client(s)
    // Use the parsed numeric userId to find the correct SSE client
    sendSseEvent(userId, 'change-channel', { channel });

    res.json({ success: true, message: `Change channel command sent to user ${streamInfo.username}.` });
});

// NEW: Endpoint for system health metrics
app.get('/api/admin/system-health', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [cpu, mem, fs] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.fsSize()
        ]);

        const dataDisk = fs.find(d => d.mount === DATA_DIR) || {};
        const dvrDisk = fs.find(d => d.mount === DVR_DIR) || {};

        res.json({
            cpu: {
                load: cpu.currentLoad.toFixed(2)
            },
            memory: {
                total: mem.total,
                used: mem.used,
                percent: ((mem.used / mem.total) * 100).toFixed(2)
            },
            disks: {
                data: {
                    total: dataDisk.size || 0,
                    used: dataDisk.used || 0,
                    percent: dataDisk.use || 0
                },
                dvr: {
                    total: dvrDisk.size || 0,
                    used: dvrDisk.used || 0,
                    percent: dvrDisk.use || 0
                }
            }
        });
    } catch (e) {
        console.error('[ADMIN_API] Error fetching system health:', e);
        res.status(500).json({ error: 'Could not retrieve system health information.' });
    }
});

// NEW: Endpoint for analytics widgets
app.get('/api/admin/analytics', requireAuth, requireAdmin, async (req, res) => {
    try {
        const topChannelsQuery = `
            SELECT channel_name, SUM(duration_seconds) as total_duration
            FROM stream_history
            WHERE channel_name IS NOT NULL AND duration_seconds IS NOT NULL
            GROUP BY channel_name
            ORDER BY total_duration DESC
            LIMIT 5`;
        
        const topUsersQuery = `
            SELECT username, SUM(duration_seconds) as total_duration
            FROM stream_history
            WHERE duration_seconds IS NOT NULL
            GROUP BY username
            ORDER BY total_duration DESC
            LIMIT 5`;
            
        const topChannels = await new Promise((resolve, reject) => {
            db.all(topChannelsQuery, [], (err, rows) => err ? reject(err) : resolve(rows));
        });
        
        const topUsers = await new Promise((resolve, reject) => {
            db.all(topUsersQuery, [], (err, rows) => err ? reject(err) : resolve(rows));
        });

        res.json({ topChannels, topUsers });

    } catch (e) {
        console.error('[ADMIN_API] Error fetching analytics data:', e);
        res.status(500).json({ error: 'Could not retrieve analytics data.' });
    }
});

// NEW: Endpoint for broadcasting messages
app.post('/api/admin/broadcast', requireAuth, requireAdmin, (req, res) => {
    const { message } = req.body;
    if (!message || message.trim().length === 0) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
    }

    broadcastSseToAll('broadcast-message', {
        message: message.trim(),
        sender: req.session.username,
    });

    res.json({ success: true, message: 'Broadcast sent successfully.' });
});

// ... existing Multi-View Layout API Endpoints ...
app.get('/api/multiview/layouts', requireAuth, (req, res) => {
    console.log(`[LAYOUT_API] Fetching layouts for user ${req.session.userId}.`);
    db.all("SELECT id, name, layout_data FROM multiview_layouts WHERE user_id = ?", [req.session.userId], (err, rows) => {
        if (err) {
            console.error('[LAYOUT_API] Error fetching layouts:', err.message);
            return res.status(500).json({ error: 'Could not retrieve layouts.' });
        }
        const layouts = rows.map(row => ({
            ...row,
            layout_data: JSON.parse(row.layout_data)
        }));
        console.log(`[LAYOUT_API] Found ${layouts.length} layouts for user ${req.session.userId}.`);
        res.json(layouts);
    });
});

app.post('/api/multiview/layouts', requireAuth, (req, res) => {
    const { name, layout_data } = req.body;
    console.log(`[LAYOUT_API] Saving layout "${name}" for user ${req.session.userId}.`);
    if (!name || !layout_data) {
        console.warn('[LAYOUT_API] Save failed: Name or layout_data is missing.');
        return res.status(400).json({ error: 'Layout name and data are required.' });
    }

    const layoutJson = JSON.stringify(layout_data);

    db.run("INSERT INTO multiview_layouts (user_id, name, layout_data) VALUES (?, ?, ?)",
        [req.session.userId, name, layoutJson],
        function (err) {
            if (err) {
                console.error('[LAYOUT_API] Error saving layout:', err.message);
                return res.status(500).json({ error: 'Could not save layout.' });
            }
            console.log(`[LAYOUT_API] Layout "${name}" saved with ID ${this.lastID} for user ${req.session.userId}.`);
            res.status(201).json({ success: true, id: this.lastID, name, layout_data });
        }
    );
});

app.delete('/api/multiview/layouts/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    console.log(`[LAYOUT_API] Deleting layout ID: ${id} for user ${req.session.userId}.`);
    db.run("DELETE FROM multiview_layouts WHERE id = ? AND user_id = ?", [id, req.session.userId], function(err) {
        if (err) {
            console.error(`[LAYOUT_API] Error deleting layout ${id}:`, err.message);
            return res.status(500).json({ error: 'Could not delete layout.' });
        }
        if (this.changes === 0) {
            console.warn(`[LAYOUT_API] Layout ${id} not found or user ${req.session.userId} not authorized.`);
            return res.status(404).json({ error: 'Layout not found or you do not have permission to delete it.' });
        }
        console.log(`[LAYOUT_API] Layout ${id} deleted successfully.`);
        res.json({ success: true });
    });
});
// --- Notification Scheduler ---
// ... existing checkAndSendNotifications ...
async function checkAndSendNotifications() {
    console.log('[PUSH_CHECKER] Running scheduled notification check for all devices.');
    const now = new Date();
    const nowIso = now.toISOString();
    
    const timeoutCutoff = new Date(now.getTime() - (24 * 60 * 60 * 1000)).toISOString();

    try {
        db.run(`
            UPDATE notification_deliveries
            SET status = 'expired', updatedAt = ?
            WHERE status = 'pending' AND notification_id IN (
                SELECT id FROM notifications WHERE notificationTime < ?
            )
        `, [nowIso, timeoutCutoff], function(err) {
            if (err) {
                console.error('[PUSH_CHECKER_CLEANUP] Error expiring old notifications:', err.message);
            } else if (this.changes > 0) {
                console.log(`[PUSH_CHECKER_CLEANUP] Expired ${this.changes} old notification deliveries.`);
            }
        });

        const dueDeliveries = await new Promise((resolve, reject) => {
            const query = `
                SELECT
                    d.id as delivery_id,
                    d.status,
                    n.*,
                    s.id as subscription_id,
                    s.endpoint,
                    s.p256dh,
                    s.auth
                FROM notification_deliveries d
                JOIN notifications n ON d.notification_id = n.id
                JOIN push_subscriptions s ON d.subscription_id = s.id
                WHERE d.status = 'pending' AND n.notificationTime <= ?
            `;
            db.all(query, [nowIso], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        if (dueDeliveries.length > 0) {
            console.log(`[PUSH_CHECKER] Found ${dueDeliveries.length} due notification deliveries to process.`);
        } else {
            return;
        }

        for (const delivery of dueDeliveries) {
            console.log(`[PUSH_CHECKER] Processing delivery ID ${delivery.delivery_id} for program "${delivery.programTitle}" to subscription ${delivery.subscription_id}.`);
            
            const payload = JSON.stringify({
                type: 'program_reminder',
                data: {
                    programTitle: delivery.programTitle,
                    programStart: delivery.programStart,
                    channelName: delivery.channelName,
                    channelLogo: delivery.channelLogo || 'https://i.imgur.com/rwa8SjI.png',
                    url: `/tvguide?channelId=${delivery.channelId}&programId=${delivery.programId}&programStart=${delivery.programStart}`
                }
            });

            const pushSubscription = {
                endpoint: delivery.endpoint,
                keys: { p256dh: delivery.p256dh, auth: delivery.auth }
            };
            
            const pushOptions = {
                TTL: 86400 // 24 hours in seconds
            };

            webpush.sendNotification(pushSubscription, payload, pushOptions)
                .then(() => {
                    console.log(`[PUSH_CHECKER] Successfully sent notification for delivery ID ${delivery.delivery_id}.`);
                    db.run("UPDATE notification_deliveries SET status = 'sent', updatedAt = ? WHERE id = ?", [nowIso, delivery.delivery_id]);
                })
                .catch(error => {
                    console.error(`[PUSH_CHECKER] Error sending notification for delivery ID ${delivery.delivery_id}:`, error.statusCode, error.body || error.message);
                    
                    if (error.statusCode === 410 || error.statusCode === 404) {
                        console.log(`[PUSH_CHECKER] Subscription ${delivery.subscription_id} is invalid (410/404). Deleting subscription and failing deliveries.`);
                        
                        sendSseEvent(delivery.user_id, 'subscription-invalidated', {
                            endpoint: delivery.endpoint,
                            reason: `Push service returned status ${error.statusCode}.`
                        });

                        db.run("DELETE FROM push_subscriptions WHERE id = ?", [delivery.subscription_id]);
                        db.run("UPDATE notification_deliveries SET status = 'failed', updatedAt = ? WHERE subscription_id = ? AND status = 'pending'", [nowIso, delivery.subscription_id]);
                    } else {
                        db.run("UPDATE notification_deliveries SET status = 'failed', updatedAt = ? WHERE id = ?", [nowIso, delivery.delivery_id]);
                    }
                });
        }
    } catch (error) {
        console.error('[PUSH_CHECKER] Unhandled error in checkAndSendNotifications:', error);
    }
}
// --- DVR Engine ---
// ... existing DVR functions (stopRecording, startRecording, etc.) ...
function stopRecording(jobId) {
    const pid = runningFFmpegProcesses.get(jobId);
    if (pid) {
        console.log(`[DVR] Gracefully stopping recording for job ${jobId} (PID: ${pid}). Sending SIGINT.`);
        try {
            process.kill(pid, 'SIGINT');
        } catch (e) {
            console.error(`[DVR] Error sending SIGINT to ffmpeg process for job ${jobId}: ${e.message}. Trying SIGKILL.`);
            try { process.kill(pid, 'SIGKILL'); } catch (e2) {}
        }
    } else {
        console.warn(`[DVR] Cannot stop job ${jobId}: No running ffmpeg process found.`);
    }
}


async function startRecording(job) {
    console.log(`[DVR] Starting recording for job ${job.id}: "${job.programTitle}"`);
    const settings = getSettings();
    const allChannels = parseM3U(fs.existsSync(LIVE_CHANNELS_M3U_PATH) ? fs.readFileSync(LIVE_CHANNELS_M3U_PATH, 'utf-8') : '');
    const channel = allChannels.find(c => c.id === job.channelId);

    if (!channel) {
        const errorMsg = `Channel ID ${job.channelId} not found in M3U.`;
        console.error(`[DVR] Cannot start recording job ${job.id}: ${errorMsg}`);
        db.run("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = ? WHERE id = ?", [errorMsg, job.id]);
        return;
    }
    
    // MODIFIED: Simplified logic. Directly use the profile ID from the job.
    const recProfile = (settings.dvr.recordingProfiles || []).find(p => p.id === job.profileId);
    if (!recProfile) {
        const errorMsg = `Recording profile ID "${job.profileId}" not found.`;
        console.error(`[DVR] Cannot start recording job ${job.id}: ${errorMsg}`);
        db.run("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = ? WHERE id = ?", [errorMsg, job.id]);
        return;
    }

    const userAgent = (settings.userAgents || []).find(ua => ua.id === job.userAgentId);
    if (!userAgent) {
        const errorMsg = `User agent not found.`;
        console.error(`[DVR] Cannot start recording job ${job.id}: ${errorMsg}`);
        db.run("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = ? WHERE id = ?", [errorMsg, job.id]);
        return;
    }

    console.log(`[DVR] Using recording profile: "${recProfile.name}"`);

    const streamUrlToRecord = channel.url;
    // **MODIFIED: Change file extension based on profile to support .ts files.**
    const fileExtension = recProfile.command.includes('-f mp4') ? '.mp4' : '.ts';
    const safeFilename = `${job.id}_${job.programTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase()}${fileExtension}`;
    const fullFilePath = path.join(DVR_DIR, safeFilename);

    const commandTemplate = recProfile.command
        .replace(/{streamUrl}/g, streamUrlToRecord)
        .replace(/{userAgent}/g, userAgent.value)
        .replace(/{filePath}/g, fullFilePath);
        
    const args = (commandTemplate.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(arg => arg.replace(/^"|"$/g, ''));

    console.log(`[DVR] Spawning ffmpeg for job ${job.id} with command: ffmpeg ${args.join(' ')}`);
    const ffmpeg = spawn('ffmpeg', args);
    runningFFmpegProcesses.set(job.id, ffmpeg.pid);

    db.run("UPDATE dvr_jobs SET status = 'recording', ffmpeg_pid = ?, filePath = ? WHERE id = ?", [ffmpeg.pid, fullFilePath, job.id]);
    
    let ffmpegErrorOutput = '';
    ffmpeg.stderr.on('data', (data) => {
        const line = data.toString().trim();
        console.log(`[FFMPEG_DVR][${job.id}] ${line}`);
        ffmpegErrorOutput += line + '\n';
    });

    ffmpeg.on('close', (code) => {
        runningFFmpegProcesses.delete(job.id);
        const wasStoppedIntentionally = ffmpegErrorOutput.includes('Exiting normally, received signal 2');
        const logMessage = (code === 0 || wasStoppedIntentionally) ? 'finished gracefully' : `exited with error code ${code}`;
        console.log(`[DVR] Recording process for job ${job.id} ("${job.programTitle}") ${logMessage}.`);

        fs.stat(fullFilePath, (statErr, stats) => {
            if ((code === 0 || wasStoppedIntentionally) && !statErr && stats && stats.size > 1024) { 
                const durationSeconds = (new Date(job.endTime) - new Date(job.startTime)) / 1000;
                db.run(`INSERT INTO dvr_recordings (job_id, user_id, channelName, programTitle, startTime, durationSeconds, fileSizeBytes, filePath) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [job.id, job.user_id, job.channelName, job.programTitle, job.startTime, Math.round(durationSeconds), stats.size, fullFilePath],
                    (insertErr) => {
                        if (insertErr) {
                            console.error(`[DVR] Failed to create dvr_recordings entry for job ${job.id}:`, insertErr.message);
                        } else {
                            console.log(`[DVR] Job ${job.id} logged to completed recordings.`);
                        }
                    }
                );
                db.run("UPDATE dvr_jobs SET status = 'completed', ffmpeg_pid = NULL WHERE id = ?", [job.id]);
            } else {
                const finalErrorMessage = `Recording failed. FFmpeg exit code: ${code}. ${statErr ? 'File stat error: ' + statErr.message : ''}. FFmpeg output: ${ffmpegErrorOutput.slice(-1000)}`;
                console.error(`[DVR] Recording for job ${job.id} failed. ${finalErrorMessage}`);
                db.run("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = ? WHERE id = ?", [finalErrorMessage, job.id]);
                if (!statErr && stats.size <= 1024) { 
                    fs.unlink(fullFilePath, (unlinkErr) => {
                        if (unlinkErr) console.error(`[DVR] Could not delete failed recording file: ${fullFilePath}`, unlinkErr);
                    });
                }
            }
        });
    });

    ffmpeg.on('error', (err) => {
        const errorMsg = `Failed to spawn ffmpeg process: ${err.message}`;
        console.error(`[DVR] ${errorMsg} for job ${job.id}`);
        runningFFmpegProcesses.delete(job.id);
        db.run("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = ? WHERE id = ?", [errorMsg, job.id]);
    });
}

function scheduleDvrJob(job) {
    if (activeDvrJobs.has(job.id)) {
        activeDvrJobs.get(job.id)?.cancel();
        activeDvrJobs.delete(job.id);
    }

    const startTime = new Date(job.startTime);
    const endTime = new Date(job.endTime);
    const now = new Date();

    if (endTime <= now) {
        console.log(`[DVR] Job ${job.id} for "${job.programTitle}" is already in the past. Skipping schedule.`);
        if (job.status === 'scheduled') {
            db.run("UPDATE dvr_jobs SET status = 'error', errorMessage = 'Job was scheduled for a time in the past.' WHERE id = ?", [job.id]);
        }
        return;
    }

    if (startTime > now) {
        const startJob = schedule.scheduleJob(startTime, () => startRecording(job));
        activeDvrJobs.set(job.id, startJob);
        console.log(`[DVR] Scheduled recording start for job ${job.id} at ${startTime}`);
    } else {
        startRecording(job);
    }

    schedule.scheduleJob(endTime, () => stopRecording(job.id));
    console.log(`[DVR] Scheduled recording stop for job ${job.id} at ${endTime}`);
}


function loadAndScheduleAllDvrJobs() {
    console.log('[DVR] Loading and scheduling all pending DVR jobs from database...');
    db.run("UPDATE dvr_jobs SET status = 'error', errorMessage = 'Server restarted during recording.' WHERE status = 'recording'", [], (err) => {
        if (err) {
            console.error('[DVR] Error updating recording jobs status on startup:', err.message);
        } else {
            console.log("[DVR] Updated status of previous 'recording' jobs to 'error'.");
        }
        
        db.all("SELECT * FROM dvr_jobs WHERE status = 'scheduled'", [], (err, jobs) => {
            if (err) {
                console.error('[DVR] Error fetching pending DVR jobs:', err);
                return;
            }
            console.log(`[DVR] Found ${jobs.length} jobs to schedule.`);
            jobs.forEach(scheduleDvrJob);
        });
    });
}
// ... existing functions ...

async function checkForConflicts(newJob, userId) {
    return new Promise((resolve, reject) => {
        const settings = getSettings();
        const maxConcurrent = settings.dvr?.maxConcurrentRecordings || 1;
        
        db.all("SELECT * FROM dvr_jobs WHERE user_id = ? AND status = 'scheduled'", [userId], (err, scheduledJobs) => {
            if (err) return reject(err);

            const newStart = new Date(newJob.startTime).getTime();
            const newEnd = new Date(newJob.endTime).getTime();
            
            const conflictingJobs = scheduledJobs.filter(existingJob => {
                const existingStart = new Date(existingJob.startTime).getTime();
                const existingEnd = new Date(existingJob.endTime).getTime();
                return newStart < existingEnd && newEnd > existingStart;
            });

            if (conflictingJobs.length >= maxConcurrent) {
                resolve(conflictingJobs);
            } else {
                resolve([]);
            }
        });
    });
}

async function autoDeleteOldRecordings() {
    console.log('[DVR_STORAGE] Running daily check for old recordings to delete.');
    db.all("SELECT id FROM users", [], (err, users) => {
        if(err) return console.error('[DVR_STORAGE] Could not fetch users for auto-delete check:', err);

        users.forEach(user => {
            db.get("SELECT value FROM user_settings WHERE user_id = ? AND key = 'dvr'", [user.id], (err, row) => {
                const settings = getSettings();
                const userDvrSettings = row ? { ...settings.dvr, ...JSON.parse(row.value) } : settings.dvr;
                
                const deleteDays = userDvrSettings.autoDeleteDays;
                if (!deleteDays || deleteDays <= 0) {
                    return;
                }

                const cutoffDate = new Date();
                cutoffDate.setDate(cutoffDate.getDate() - deleteDays);
                
                db.all("SELECT id, filePath FROM dvr_recordings WHERE user_id = ? AND startTime < ?", [user.id, cutoffDate.toISOString()], (err, recordingsToDelete) => {
                    if(err) return console.error(`[DVR_STORAGE] Error fetching old recordings for user ${user.id}:`, err);
                    if(recordingsToDelete.length > 0) {
                        console.log(`[DVR_STORAGE] Found ${recordingsToDelete.length} old recording(s) to delete for user ${user.id}.`);
                    }
                    
                    recordingsToDelete.forEach(rec => {
                        if (fs.existsSync(rec.filePath)) {
                            fs.unlink(rec.filePath, (unlinkErr) => {
                                if (unlinkErr) {
                                    console.error(`[DVR_STORAGE] Failed to delete file ${rec.filePath}:`, unlinkErr);
                                } else {
                                    db.run("DELETE FROM dvr_recordings WHERE id = ?", [rec.id]);
                                    console.log(`[DVR_STORAGE] Deleted old recording file and DB record: ${rec.filePath}`);
                                }
                            });
                        } else {
                            db.run("DELETE FROM dvr_recordings WHERE id = ?", [rec.id]);
                        }
                    });
                });
            });
        });
    });
}
// --- DVR API Endpoints (MODIFIED & NEW) ---
// ... existing DVR API Endpoints ...

// **NEW: Timeshift/Chase Play Endpoint**
app.get('/api/dvr/timeshift/:jobId', requireAuth, requireDvrAccess, (req, res) => {
    const { jobId } = req.params;
    const userId = req.session.userId;
    console.log(`[DVR_TIMESHIFT] Received request for job ${jobId} from user ${userId}.`);

    db.get("SELECT filePath, status FROM dvr_jobs WHERE id = ? AND user_id = ?", [jobId, userId], (err, job) => {
        if (err) {
            console.error(`[DVR_TIMESHIFT] DB error fetching job ${jobId}:`, err);
            return res.status(500).send('Server error.');
        }
        if (!job) {
            return res.status(404).send('Recording job not found or not authorized.');
        }
        if (job.status !== 'recording') {
            return res.status(400).send('Cannot timeshift a recording that is not in progress.');
        }
        if (!job.filePath || !fs.existsSync(job.filePath)) {
            return res.status(404).send('Recording file not found on disk.');
        }

        console.log(`[DVR_TIMESHIFT] Streaming file: ${job.filePath}`);
        res.setHeader('Content-Type', 'video/mp2t');
        const stream = fs.createReadStream(job.filePath);
        stream.pipe(res);

        stream.on('error', (streamErr) => {
            console.error(`[DVR_TIMESHIFT] Error streaming file ${job.filePath}:`, streamErr);
            res.end();
        });
    });
});


app.post('/api/dvr/schedule', requireAuth, requireDvrAccess, async (req, res) => {
    const { channelId, channelName, programTitle, programStart, programStop } = req.body;
    const settings = getSettings();
    const dvrSettings = settings.dvr || {};
    const preBuffer = (dvrSettings.preBufferMinutes || 0) * 60 * 1000;
    const postBuffer = (dvrSettings.postBufferMinutes || 0) * 60 * 1000;

    const newJob = {
        user_id: req.session.userId,
        channelId,
        channelName,
        programTitle,
        startTime: new Date(new Date(programStart).getTime() - preBuffer).toISOString(),
        endTime: new Date(new Date(programStop).getTime() + postBuffer).toISOString(),
        status: 'scheduled',
        profileId: dvrSettings.activeRecordingProfileId,
        userAgentId: settings.activeUserAgentId,
        preBufferMinutes: dvrSettings.preBufferMinutes || 0,
        postBufferMinutes: dvrSettings.postBufferMinutes || 0
    };
    
    const conflictingJobs = await checkForConflicts(newJob, req.session.userId);
    if (conflictingJobs.length > 0) {
        return res.status(409).json({ error: 'Recording conflict detected.', newJob, conflictingJobs });
    }

    db.run(`INSERT INTO dvr_jobs (user_id, channelId, channelName, programTitle, startTime, endTime, status, profileId, userAgentId, preBufferMinutes, postBufferMinutes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newJob.user_id, newJob.channelId, newJob.channelName, newJob.programTitle, newJob.startTime, newJob.endTime, newJob.status, newJob.profileId, newJob.userAgentId, newJob.preBufferMinutes, newJob.postBufferMinutes],
        function(err) {
            if (err) {
                console.error('[DVR_API] Error scheduling new recording:', err);
                return res.status(500).json({ error: 'Could not schedule recording.' });
            }
            const jobWithId = { ...newJob, id: this.lastID };
            scheduleDvrJob(jobWithId);
            res.status(201).json({ success: true, job: jobWithId });
        }
    );
});

app.post('/api/dvr/schedule/manual', requireAuth, requireDvrAccess, async (req, res) => {
    const { channelId, channelName, startTime, endTime } = req.body;
    const settings = getSettings();
    const dvrSettings = settings.dvr || {};

    const newJob = {
        user_id: req.session.userId,
        channelId,
        channelName,
        programTitle: `Manual Recording: ${channelName}`,
        startTime,
        endTime,
        status: 'scheduled',
        profileId: dvrSettings.activeRecordingProfileId,
        userAgentId: settings.activeUserAgentId,
        preBufferMinutes: 0,
        postBufferMinutes: 0
    };
    
    const conflictingJobs = await checkForConflicts(newJob, req.session.userId);
    if (conflictingJobs.length > 0) {
        return res.status(409).json({ error: 'Recording conflict detected.', newJob, conflictingJobs });
    }

    db.run(`INSERT INTO dvr_jobs (user_id, channelId, channelName, programTitle, startTime, endTime, status, profileId, userAgentId, preBufferMinutes, postBufferMinutes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newJob.user_id, newJob.channelId, newJob.channelName, newJob.programTitle, newJob.startTime, newJob.endTime, newJob.status, newJob.profileId, newJob.userAgentId, newJob.preBufferMinutes, newJob.postBufferMinutes],
        function(err) {
            if (err) return res.status(500).json({ error: 'Could not schedule recording.' });
            const jobWithId = { ...newJob, id: this.lastID };
            scheduleDvrJob(jobWithId);
            res.status(201).json({ success: true, job: jobWithId });
        }
    );
});

// MODIFIED: Endpoint logic to show all jobs to admin, or user's jobs to them.
app.get('/api/dvr/jobs', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
        // Admins see all jobs, with username
        const query = "SELECT j.*, u.username FROM dvr_jobs j JOIN users u ON j.user_id = u.id ORDER BY j.startTime DESC";
        db.all(query, [], (err, rows) => {
            if (err) return res.status(500).json({ error: 'Failed to retrieve all recording jobs.' });
            res.json(rows);
        });
    } else if (req.session.canUseDvr) {
        // Users with DVR access see only their own jobs
        const query = "SELECT * FROM dvr_jobs WHERE user_id = ? ORDER BY startTime DESC";
        db.all(query, [req.session.userId], (err, rows) => {
            if (err) return res.status(500).json({ error: 'Failed to retrieve your recording jobs.' });
            // Add a username to be consistent with admin view
            const jobsWithUser = rows.map(r => ({...r, username: req.session.username}));
            res.json(jobsWithUser);
        });
    } else {
        // Users without DVR access see an empty list of scheduled jobs
        res.json([]);
    }
});

// MODIFIED: Endpoint to show all completed recordings to everyone.
app.get('/api/dvr/recordings', requireAuth, (req, res) => {
    // All authenticated users can see all completed recordings, with username
    const query = "SELECT r.*, u.username FROM dvr_recordings r JOIN users u ON r.user_id = u.id ORDER BY r.startTime DESC";
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Failed to retrieve recordings.' });
        const recordingsWithFilename = rows.map(r => ({...r, filename: path.basename(r.filePath)}));
        res.json(recordingsWithFilename);
    });
});


// MODIFIED: Loosened permission to requireAuth, as non-DVR users now see the DVR page.
app.get('/api/dvr/storage', requireAuth, (req, res) => {
    // Only return storage info if user has DVR access, otherwise return empty state.
    if (!req.session.canUseDvr && !req.session.isAdmin) {
        return res.json({ total: 0, used: 0, percentage: 0 });
    }
    try {
        disk.check(DVR_DIR, (err, info) => {
            if (err) {
                console.error('[DVR_STORAGE] Error checking disk usage:', err);
                return res.status(500).json({ error: 'Could not get storage information.' });
            }
            const used = info.total - info.free;
            const percentage = Math.round((used / info.total) * 100);
            res.json({
                total: info.total,
                used: used,
                percentage: percentage
            });
        });
    } catch (e) {
        console.error('[DVR_STORAGE] Unhandled error in diskusage:', e);
        res.status(500).json({ error: 'Server error checking storage.' });
    }
});

app.delete('/api/dvr/jobs/all', requireAuth, requireDvrAccess, (req, res) => {
    const userId = req.session.userId;
    console.log(`[DVR_API] Clearing all scheduled/historical jobs for user ${userId}.`);

    db.all("SELECT id FROM dvr_jobs WHERE user_id = ? AND status = 'scheduled'", [userId], (err, scheduledJobs) => {
        if (err) {
            return res.status(500).json({ error: 'Could not fetch jobs to cancel.' });
        }
        scheduledJobs.forEach(job => {
            if (activeDvrJobs.has(job.id)) {
                activeDvrJobs.get(job.id)?.cancel();
                activeDvrJobs.delete(job.id);
            }
        });

        db.run("DELETE FROM dvr_jobs WHERE user_id = ?", [userId], function(err) {
            if (err) {
                return res.status(500).json({ error: 'Could not clear jobs from database.' });
            }
            res.json({ success: true, deletedCount: this.changes });
        });
    });
});

app.delete('/api/dvr/recordings/all', requireAuth, requireDvrAccess, (req, res) => {
    const userId = req.session.userId;
    console.log(`[DVR_API] Deleting all completed recordings for user ${userId}.`);

    db.all("SELECT id, filePath FROM dvr_recordings WHERE user_id = ?", [userId], (err, recordings) => {
        if (err) {
            return res.status(500).json({ error: 'Could not fetch recordings to delete.' });
        }
        
        recordings.forEach(rec => {
            if (fs.existsSync(rec.filePath)) {
                fs.unlink(rec.filePath, (unlinkErr) => {
                    if (unlinkErr) console.error(`[DVR_API] Failed to delete file ${rec.filePath}:`, unlinkErr);
                });
            }
        });

        db.run("DELETE FROM dvr_recordings WHERE user_id = ?", [userId], function(err) {
            if (err) {
                return res.status(500).json({ error: 'Could not clear recordings from database.' });
            }
            res.json({ success: true, deletedCount: this.changes });
        });
    });
});


app.delete('/api/dvr/jobs/:id', requireAuth, requireDvrAccess, (req, res) => {
    const { id } = req.params;
    const jobId = parseInt(id, 10);
    if (activeDvrJobs.has(jobId)) {
        activeDvrJobs.get(jobId)?.cancel();
        activeDvrJobs.delete(jobId);
    }
    // MODIFIED: Admin can cancel any job, user can only cancel their own.
    const query = req.session.isAdmin ? "UPDATE dvr_jobs SET status = 'cancelled' WHERE id = ?" : "UPDATE dvr_jobs SET status = 'cancelled' WHERE id = ? AND user_id = ?";
    const params = req.session.isAdmin ? [jobId] : [jobId, req.session.userId];

    db.run(query, params, function(err) {
        if (err) return res.status(500).json({ error: 'Could not cancel job.' });
        if(this.changes === 0) return res.status(404).json({ error: 'Job not found or not authorized to cancel.' });
        console.log(`[DVR_API] Cancelled job ${jobId}.`);
        res.json({ success: true });
    });
});

app.delete('/api/dvr/recordings/:id', requireAuth, requireDvrAccess, (req, res) => {
    const { id } = req.params;
    // MODIFIED: Admin can delete any recording, user can only delete their own.
    const query = req.session.isAdmin ? "SELECT filePath FROM dvr_recordings WHERE id = ?" : "SELECT filePath FROM dvr_recordings WHERE id = ? AND user_id = ?";
    const params = req.session.isAdmin ? [id] : [id, req.session.userId];

    db.get(query, params, (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Recording not found or not authorized.' });

        if (fs.existsSync(row.filePath)) {
            fs.unlink(row.filePath, (unlinkErr) => {
                if (unlinkErr) console.error(`[DVR_API] Failed to delete file ${row.filePath}:`, unlinkErr);
            });
        }
        db.run("DELETE FROM dvr_recordings WHERE id = ?", [id], (deleteErr) => {
            if (deleteErr) return res.status(500).json({ error: 'Failed to delete recording record.' });
            res.json({ success: true });
        });
    });
});

app.post('/api/dvr/jobs/:id/stop', requireAuth, requireDvrAccess, (req, res) => {
    const { id } = req.params;
    const jobId = parseInt(id, 10);
    console.log(`[DVR_API] Received request to stop recording for job ${jobId}.`);
    stopRecording(jobId);

    // MODIFIED: Admin can stop any job, user can only stop their own.
    const query = req.session.isAdmin ? "UPDATE dvr_jobs SET status = 'completed' WHERE id = ?" : "UPDATE dvr_jobs SET status = 'completed' WHERE id = ? AND user_id = ?";
    const params = req.session.isAdmin ? [jobId] : [jobId, req.session.userId];
    
    db.run(query, params, function(err){
        if (err) return res.status(500).json({ error: 'Could not update job status after stop.' });
        if(this.changes === 0) return res.status(404).json({ error: 'Job not found or not authorized to stop.' });
        res.json({ success: true });
    });
});

app.put('/api/dvr/jobs/:id', requireAuth, requireDvrAccess, (req, res) => {
    const { id } = req.params;
    const { startTime, endTime } = req.body;
    if (!startTime || !endTime) {
        return res.status(400).json({ error: 'Both startTime and endTime are required.' });
    }
    
    // MODIFIED: Admin can edit any job, user can only edit their own.
    const getQuery = req.session.isAdmin ? "SELECT * from dvr_jobs WHERE id = ?" : "SELECT * from dvr_jobs WHERE id = ? AND user_id = ?";
    const getParams = req.session.isAdmin ? [id] : [id, req.session.userId];

    db.get(getQuery, getParams, (err, job) => {
        if (err) return res.status(500).json({ error: 'DB error fetching job.'});
        if (!job) return res.status(404).json({ error: 'Job not found or unauthorized.' });
        if (job.status !== 'scheduled') return res.status(400).json({ error: 'Only scheduled jobs can be modified.' });
        
        db.run("UPDATE dvr_jobs SET startTime = ?, endTime = ? WHERE id = ?", [startTime, endTime, id], function(err) {
            if (err) return res.status(500).json({ error: 'Could not update job.' });
            
            const updatedJob = { ...job, startTime, endTime };
            scheduleDvrJob(updatedJob);
            
            console.log(`[DVR_API] Updated and rescheduled job ${id}.`);
            res.json({ success: true, job: updatedJob });
        });
    });
});

app.delete('/api/dvr/jobs/:id/history', requireAuth, requireDvrAccess, (req, res) => {
    const { id } = req.params;
    // MODIFIED: Admin can delete any job history, user can only delete their own.
    const query = req.session.isAdmin ? "SELECT status FROM dvr_jobs WHERE id = ?" : "SELECT status FROM dvr_jobs WHERE id = ? AND user_id = ?";
    const params = req.session.isAdmin ? [id] : [id, req.session.userId];

    db.get(query, params, (err, job) => {
        if (err || !job) {
             return res.status(404).json({ error: 'Job not found or unauthorized.' });
        }
        if (['error', 'cancelled', 'completed'].includes(job.status)) {
            db.run("DELETE FROM dvr_jobs WHERE id = ?", [id], function(err) {
                if(err) return res.status(500).json({ error: 'Could not delete job history.' });
                console.log(`[DVR_API] Deleted job history for job ${id}.`);
                res.json({ success: true });
            });
        } else {
            return res.status(400).json({ error: 'Only completed, cancelled, or error jobs can be removed from history.' });
        }
    });
});
// ... existing SSE and other endpoints ...
app.get('/api/events', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const clientId = Date.now();
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    if (!sseClients.has(userId)) {
        sseClients.set(userId, []);
    }
    
    const clients = sseClients.get(userId);
    //-- ENHANCEMENT: Store isAdmin status with the client for easy broadcasting.
    clients.push({ id: clientId, res, isAdmin: req.session.isAdmin });
    console.log(`[SSE] Client ${clientId} connected for user ID ${userId}. Total clients for user: ${clients.length}.`);

    res.write(`event: connected\ndata: ${JSON.stringify({ message: "Connection established" })}\n\n`);

    req.on('close', () => {
        const userClients = sseClients.get(userId);
        if (userClients) {
            const index = userClients.findIndex(c => c.id === clientId);
            if (index !== -1) {
                userClients.splice(index, 1);
                console.log(`[SSE] Client ${clientId} disconnected for user ID ${userId}. Remaining clients for user: ${userClients.length}.`);
                if (userClients.length === 0) {
                    sseClients.delete(userId);
                }
            }
        }
    });
});

app.post('/api/validate-url', requireAuth, async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required.' });
    }
    console.log(`[VALIDATE_URL] Testing URL: ${url}`);
    try {
        await fetchUrlContent(url);
        res.json({ success: true, message: 'URL is reachable and returned a successful response.' });
    } catch (error) {
        res.status(400).json({ success: false, error: `URL is not reachable. Error: ${error.message}` });
    }
});

// --- NEW: Hardware Info Endpoint ---
app.get('/api/hardware', requireAuth, (req, res) => {
    res.json(detectedHardware);
});

app.get('/api/public-ip', requireAuth, (req, res) => {
    console.log('[IP_API] Fetching public IP address...');
    https.get('https://ifconfig.me/ip', (ipRes) => {
        let data = '';
        ipRes.on('data', (chunk) => {
            data += chunk;
        });
        ipRes.on('end', () => {
            res.json({ publicIp: data.trim() });
        });
    }).on('error', (err) => {
        console.error('[IP_API] Error fetching public IP:', err.message);
        res.status(500).json({ error: 'Could not fetch public IP address.' });
    });
});

// --- Backup & Restore Endpoints ---
const settingsUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, DATA_DIR),
        filename: (req, file, cb) => cb(null, 'settings.tmp.json')
    }),
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/json') {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JSON is allowed.'), false);
        }
    }
});

app.get('/api/settings/export', requireAdmin, (req, res) => {
    if (fs.existsSync(SETTINGS_PATH)) {
        res.download(SETTINGS_PATH, 'viniplay-settings-backup.json', (err) => {
            if (err) {
                console.error('[SETTINGS_EXPORT] Error sending settings file:', err);
            }
        });
    } else {
        res.status(404).json({ error: 'Settings file not found.' });
    }
});

app.post('/api/settings/import', requireAdmin, settingsUpload.single('settingsFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No settings file was uploaded.' });
    }
    const tempPath = path.join(DATA_DIR, 'settings.tmp.json');
    try {
        const fileContent = fs.readFileSync(tempPath, 'utf-8');
        JSON.parse(fileContent); // Validate that it's valid JSON
        fs.renameSync(tempPath, SETTINGS_PATH);
        console.log('[SETTINGS_IMPORT] Settings file imported successfully. App will now use new settings.');
        res.json({ success: true, message: 'Settings imported. The application will use them on next load.' });
    } catch (error) {
        console.error('[SETTINGS_IMPORT] Error processing imported settings file:', error.message);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        res.status(400).json({ error: `Invalid settings file. Error: ${error.message}` });
    }
});
// --- Main Route Handling ---
app.get('*', (req, res) => {
    const filePath = path.join(PUBLIC_DIR, req.path);
    if(fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()){
        return res.sendFile(filePath);
    }
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- Server Start ---
// NEW: Run hardware detection before starting the server
detectHardwareAcceleration().then(() => {
    app.listen(port, () => {
        console.log(`\n======================================================`);
        console.log(` VINI PLAY server listening at http://localhost:${port}`);
        console.log(`======================================================\n`);

        processAndMergeSources().then((result) => {
            console.log('[INIT] Initial source processing complete.');
            if(result.success) fs.writeFileSync(SETTINGS_PATH, JSON.stringify(result.updatedSettings, null, 2));
            updateAndScheduleSourceRefreshes();
        }).catch(error => console.error('[INIT] Initial source processing failed:', error.message));

        if (notificationCheckInterval) clearInterval(notificationCheckInterval);
        notificationCheckInterval = setInterval(checkAndSendNotifications, 60000);
        console.log('[Push] Notification checker started.');
        
        setInterval(cleanupInactiveStreams, 60000);
        console.log('[JANITOR] Inactive stream cleanup process started.');

        schedule.scheduleJob('0 2 * * *', autoDeleteOldRecordings);
        console.log('[DVR_STORAGE] Scheduled daily cleanup of old recordings.');
        
        // **NEW: Load and schedule DVR jobs on startup**
        loadAndScheduleAllDvrJobs();
    });
});

// --- Helper Functions (Full Implementation) ---
function parseM3U(data) {
    if (!data) return [];
    const lines = data.split('\n');
    const channels = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
            const nextLine = lines[i + 1]?.trim();
            // Ensure the next line is a valid URL
            if (nextLine && (nextLine.startsWith('http') || nextLine.startsWith('rtp'))) {
                const idMatch = line.match(/tvg-id="([^"]*)"/);
                const logoMatch = line.match(/tvg-logo="([^"]*)"/);
                const nameMatch = line.match(/tvg-name="([^"]*)"/);
                const groupMatch = line.match(/group-title="([^"]*)"/);
                const chnoMatch = line.match(/tvg-chno="([^"]*)"/);
                const sourceMatch = line.match(/vini-source="([^"]*)"/);
                const commaIndex = line.lastIndexOf(',');
                const displayName = (commaIndex !== -1) ? line.substring(commaIndex + 1).trim() : 'Unknown';

                channels.push({
                    id: idMatch ? idMatch[1] : `unknown-${Math.random()}`,
                    logo: logoMatch ? logoMatch[1] : '',
                    name: nameMatch ? nameMatch[1] : displayName,
                    group: groupMatch ? groupMatch[1] : 'Uncategorized',
                    chno: chnoMatch ? chnoMatch[1] : null,
                    source: sourceMatch ? sourceMatch[1] : 'Default',
                    displayName: displayName,
                    url: nextLine
                });
                i++; // Skip the URL line in the next iteration
            }
        }
    }
    return channels;
}
