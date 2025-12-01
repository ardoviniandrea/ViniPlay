// A Node.js server for the VINI PLAY IPTV Player. 
// Implements server-side EPG parsing, secure environment variables, and improved logging.

// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
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
const zlib = require('zlib');
const webpush = require('web-push');
const schedule = require('node-schedule');
const disk = require('diskusage');
const si = require('systeminformation'); // NEW: For system health monitoring
//vod processor
const { refreshVodContent, processM3uVod } = require('./vodProcessor');
const XtreamClient = require('./xtreamClient');


// --- NEW: Live Activity Tracking for Redirects ---
const activeRedirectStreams = new Map(); // Tracks live redirect streams for the admin UI

const app = express();
const port = 8998;
const saltRounds = 10;
// Initialize global variables at the top-level scope
let notificationCheckInterval = null;
const sourceRefreshTimers = new Map();
let detectedHardware = { nvidia: null, intel_qsv: null, intel_vaapi: null, radeon_vaapi: null }; // MODIFIED: To store specific Intel GPU info

// Used to validate settings.
const validFFmpegLogLevels = ["debug", "verbose", "info", "warning", "error"];

// --- ENHANCEMENT: For Server-Sent Events (SSE) ---
// This map will store active client connections for real-time updates.
const sseClients = new Map();

// --- CAST: Token-based authentication ---
// Stores short-lived tokens for Chromecast authentication
const activeCastTokens = new Map(); // token -> { userId, streamUrl, expiresAt }

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
const LOGS_DIR = path.join(DATA_DIR, 'logs'); // NEW: Log management directory
const VAPID_KEYS_PATH = path.join(DATA_DIR, 'vapid.json');
const SOURCES_DIR = path.join(DATA_DIR, 'sources');
const RAW_CACHE_DIR = path.join(SOURCES_DIR, 'raw_cache');
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
    if (!fs.existsSync(RAW_CACHE_DIR)) fs.mkdirSync(RAW_CACHE_DIR, { recursive: true });
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
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
                    db.run("ALTER TABLE users ADD COLUMN canUseDvr INTEGER DEFAULT 0", () => { });
                }
            });
            db.run(`CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (user_id, key))`);
            db.run(`CREATE TABLE IF NOT EXISTS multiview_layouts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, layout_data TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channelId TEXT NOT NULL, channelName TEXT NOT NULL, channelLogo TEXT, programTitle TEXT NOT NULL, programDesc TEXT, programStart TEXT NOT NULL, programStop TEXT NOT NULL, notificationTime TEXT NOT NULL, programId TEXT NOT NULL, status TEXT DEFAULT 'pending', triggeredAt TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS notification_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, notification_id INTEGER NOT NULL, subscription_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', updatedAt TEXT NOT NULL, FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE, FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS dvr_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channelId TEXT NOT NULL, channelName TEXT NOT NULL, programTitle TEXT NOT NULL, startTime TEXT NOT NULL, endTime TEXT NOT NULL, status TEXT NOT NULL, ffmpeg_pid INTEGER, filePath TEXT, profileId TEXT, userAgentId TEXT, preBufferMinutes INTEGER, postBufferMinutes INTEGER, errorMessage TEXT, isConflicting INTEGER DEFAULT 0, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS dvr_recordings (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER, user_id INTEGER NOT NULL, channelName TEXT NOT NULL, programTitle TEXT NOT NULL, startTime TEXT NOT NULL, durationSeconds INTEGER, fileSizeBytes INTEGER, filePath TEXT UNIQUE NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (job_id) REFERENCES dvr_jobs(id) ON DELETE SET NULL)`);

            // --- NEW: VOD Tables ---
            db.run(`CREATE TABLE IF NOT EXISTS movies (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				year INTEGER,
				description TEXT,
				logo TEXT,
				tmdb_id TEXT,
				imdb_id TEXT,
				category_name TEXT,
				provider_unique_id TEXT UNIQUE,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP
			)`, (err) => { if (err) console.error("[DB] Error creating 'movies' table:", err.message); });

            db.run(`CREATE TABLE IF NOT EXISTS series (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				year INTEGER,
				description TEXT,
				logo TEXT,
				tmdb_id TEXT,
				imdb_id TEXT,
				category_name TEXT,
				provider_unique_id TEXT UNIQUE,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP
			)`, (err) => { if (err) console.error("[DB] Error creating 'series' table:", err.message); });

            db.run(`CREATE TABLE IF NOT EXISTS episodes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				series_id INTEGER NOT NULL,
				season_num INTEGER NOT NULL,
				episode_num INTEGER NOT NULL,
				name TEXT,
				description TEXT,
				air_date TEXT,
				tmdb_id TEXT,
				imdb_id TEXT,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
			)`, (err) => { if (err) console.error("[DB] Error creating 'episodes' table:", err.message); });

            db.run(`CREATE TABLE IF NOT EXISTS vod_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id TEXT UNIQUE NOT NULL,
                category_name TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )`, (err) => { if (err) console.error("[DB] Error creating 'vod_categories' table:", err.message); });

            // --- NEW: VOD Relation Tables (Linking Providers to Content) ---
            // Note: Assuming 'provider_id' refers to the ID of the M3U source entry in settings
            // We'll store the source ID (e.g., 'src-12345678') as TEXT for flexibility
            db.run(`CREATE TABLE IF NOT EXISTS provider_movie_relations (
                provider_id TEXT NOT NULL,
                movie_id INTEGER NOT NULL,
                stream_id TEXT NOT NULL,
                container_extension TEXT,
                last_seen TEXT NOT NULL,
                FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE,
                PRIMARY KEY (provider_id, stream_id)
            )`, (err) => { if (err) console.error("[DB] Error creating 'provider_movie_relations' table:", err.message); });

            db.run(`CREATE TABLE IF NOT EXISTS provider_series_relations (
                provider_id TEXT NOT NULL,
                series_id INTEGER NOT NULL,
                external_series_id TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
                PRIMARY KEY (provider_id, external_series_id)
            )`, (err) => { if (err) console.error("[DB] Error creating 'provider_series_relations' table:", err.message); });

            db.run(`CREATE TABLE IF NOT EXISTS provider_episode_relations (
                provider_id TEXT NOT NULL,
                episode_id INTEGER NOT NULL,
                provider_stream_id TEXT NOT NULL, -- The stream ID for the episode from XC
                container_extension TEXT,
                last_seen TEXT NOT NULL,
                FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
                PRIMARY KEY (provider_id, episode_id)
             )`, (err) => {
                if (err) {
                    console.error("[DB] Error creating 'provider_episode_relations' table:", err.message);
                } else {
                    // Add new column non-destructively
                    db.run("ALTER TABLE provider_episode_relations ADD COLUMN container_extension TEXT", () => { });
                }
            });
            // --- END NEW VOD TABLES ---

            //-- ENHANCEMENT: Modify stream history table to include more data for the admin panel.
            db.run(`CREATE TABLE IF NOT EXISTS stream_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                channel_id TEXT,
                channel_name TEXT,
                start_time TEXT NOT NULL,
                end_time TEXT,
                duration_seconds INTEGER,
                status TEXT NOT NULL,
                client_ip TEXT,
                channel_logo TEXT,
                stream_profile_name TEXT
            )`, (err) => {
                if (!err) {
                    // Add new columns non-destructively if the table already exists
                    db.run("ALTER TABLE stream_history ADD COLUMN channel_logo TEXT", () => { });
                    db.run("ALTER TABLE stream_history ADD COLUMN stream_profile_name TEXT", () => { });
                }
            });
            // --- DVR Job Loading and Scheduling (Moved from main execution flow) ---
            console.log('[DVR] Loading and scheduling all pending DVR jobs from database...');
            db.run("UPDATE dvr_jobs SET status = 'error', errorMessage = 'Server restarted during recording.' WHERE status = 'recording'", [], (err) => {
                if (err) {
                    console.error('[DVR] Error updating recording jobs status on startup:', err.message);
                }
            });

            db.all("SELECT * FROM dvr_jobs WHERE status = 'scheduled'", [], (err, jobs) => {
                if (err) {
                    console.error('[DVR] Error fetching pending DVR jobs:', err);
                    return;
                }
                jobs.forEach(job => {
                    scheduleDvrJob(job);
                });
                console.log(`[DVR] Loaded and scheduled ${jobs.length} pending DVR jobs.`);
            });
            // --- End DVR Job Loading and Scheduling ---
        });
    }
});

// --- Middleware ---
app.use(express.static(PUBLIC_DIR));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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
                        if (result.success) {
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

function saveSettings(settings) {
    try {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        console.log('[SETTINGS] Settings saved successfully.');
        updateAndScheduleSourceRefreshes();
    } catch (e) {
        console.error("[SETTINGS] Error saving settings:", e);
    }
}

// --- Session Management ---
let sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret) {
    console.log('[SECURITY] SESSION_SECRET not found in environment. Checking settings.json...');
    let settings = getSettings();
    if (settings.generatedSessionSecret) {
        console.log('[SECURITY] Found existing session secret in settings.json.');
        sessionSecret = settings.generatedSessionSecret;
    } else {
        console.log('[SECURITY] No secret in settings.json. Generating a new one...');
        sessionSecret = crypto.randomBytes(64).toString('hex');
        settings.generatedSessionSecret = sessionSecret;
        saveSettings(settings);
        console.log('[SECURITY] New session secret generated and saved to settings.json.');
    }
} else {
    console.log('[SECURITY] Loaded SESSION_SECRET from environment variable.');
}

if (sessionSecret.includes('replace_this')) {
    console.warn('[SECURITY] Using a weak or default SESSION_SECRET. Please replace it.');
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

// --- Database Helper Functions ---
/**
 * Promisified version of db.run
 * @param {sqlite3.Database} db - The database instance.
 * @param {string} sql - The SQL query.
 * @param {Array} params - Query parameters.
 * @returns {Promise<object>} - { lastID, changes }
 */
const dbRun = (db, sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
};

/**
 * Promisified version of db.get
 * @param {sqlite3.Database} db - The database instance.
 * @param {string} sql - The SQL query.
 * @param {Array} params - Query parameters.
 * @returns {Promise<object|null>} - The first row found.
 */
const dbGet = (db, sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
};

/**
 * Promisified version of db.all
 * @param {sqlite3.Database} db - The database instance.
 * @param {string} sql - The SQL query.
 * @param {Array} params - Query parameters.
 * @returns {Promise<Array>} - An array of rows.
 */
const dbAll = (db, sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
};
// --- End Database Helper Functions ---


/**
 * NEW: Extracts GPU details from vainfo output.
 */
function extractVainfoGPUDetails(vainfo_stdout) {
    const start_tag = "Driver version: ";
    const end_tag = "vainfo: Supported profile";

    let vainfo_gpu_details = vainfo_stdout.substring(
        vainfo_stdout.indexOf(start_tag) + start_tag.length,
        vainfo_stdout.lastIndexOf(end_tag) - 1
    );
    // If we can't find the relevant GPU info section, return all to debug.
    // Likely means the output format of vainfo has been changed.
    if (vainfo_gpu_details === "") {
        vainfo_gpu_details = vainfo_stdout;
    } else {
        console.log(`[HW] Detected: ${vainfo_gpu_details}`)
    }
    return vainfo_gpu_details;
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

    // MODIFIED: Use 'vainfo' for more robust detection of AMD, Intel VA-API
    // and QSV GPUs. vainfo gives driver detection info on stderr and full
    // detected GPU detail on stdout.
    exec('vainfo', (err, stdout, stderr) => {
        if (stderr) {
            let found = false;
            const trimmed_stdout = stdout.trim()

            // iHD driver is for modern Intel GPUs (Gen9+) and is preferred for QSV
            if (stderr.includes('iHD_drv_video.so')) {
                detectedHardware.intel_qsv = extractVainfoGPUDetails(trimmed_stdout);
                found = true;
            }
            // AMD Radeon detection
            if (stderr.includes('radeonsi_drv_video.so')) {
                detectedHardware.radeon_vaapi = extractVainfoGPUDetails(trimmed_stdout);
                found = true;
            }
            // i965 driver is for older Intel GPUs (pre-Gen9)
            if (stderr.includes('i965_drv_video.so')) {
                detectedHardware.intel_vaapi = extractVainfoGPUDetails(trimmed_stdout);
                found = true;
            }

            if (!found) {
                // Show full vainfo output for info/debug purposes.
                console.log("[HW] vainfo did not detect any recognized GPU");
                if (stderr) {
                    console.log(`[HW] vainfo init (stderr): ${stderr.trim()}`);
                }
                if (stdout) {
                    console.log(`[HW] vainfo GPU info (stdout): ${stdout.trim()}`);
                }
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
            { id: 'redirect', name: 'Redirect (No Transcoding)', command: 'redirect', isDefault: true },
            { id: 'ffmpeg-default', name: 'ffmpeg (Built in)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-nvidia', name: 'ffmpeg (NVIDIA NVENC)', command: '-user_agent "{userAgent}" -re -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-nvidia-reconnect', name: 'ffmpeg (NVIDIA reconnect)', command: '-user_agent "{userAgent}" -re -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-intel', name: 'ffmpeg (Intel QSV)', command: '-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-vaapi', name: 'ffmpeg (VA-API) Intel', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf "format=nv12|vaapi,hwupload" -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-vaapi-amd', name: 'ffmpeg (VA-API) Radeon/AMD', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false }
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
                { id: 'dvr-mp4-intel', name: 'Intel QSV MP4 (H.264/AAC)', command: '-hwaccel qsv -hwaccel_output_format qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -vf scale_qsv=format=nv12 -c:a aac -ac 2 -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false },
                // NEW: Add this line for VA-API recording
                { id: 'dvr-mp4-vaapi', name: 'VA-API MP4 (H.264/AAC)', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf \'format=nv12,hwupload\' -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false },
                { id: 'dvr-mp4-radeon-vaapi', name: 'Radeon/AMD VA-API MP4 (H.264/AAC)', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -preset medium -vf scale_vaapi=format=nv12 -c:a aac -ac 2 -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false }
            ]
        },
        castProfiles: [
            { id: 'cast-default', name: 'Cast Default (CPU)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: true },
            { id: 'cast-nvidia', name: 'Cast (NVIDIA NVENC)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false },
            { id: 'cast-intel', name: 'Cast (Intel QSV)', command: '-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false },
            { id: 'cast-vaapi', name: 'Cast (VA-API Intel)', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf "format=nv12|vaapi,hwupload" -c:v h264_vaapi -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false },
            { id: 'cast-vaapi-amd', name: 'Cast (VA-API Radeon/AMD)', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false }
        ],
        activeCastProfileId: 'cast-default',
        activeUserAgentId: `default-ua-1724778434000`,
        activeStreamProfileId: 'redirect',
        playerLogLevel: 'warning',
        dvrLogLevel: 'warning',
        searchScope: 'all_channels_unfiltered',
        notificationLeadTime: 10,
        sourcesLastUpdated: null,
        logs: {
            maxFiles: 5,
            maxFileSizeBytes: 5 * 1024 * 1024, // 5MB
            autoDeleteDays: 7
        }
    };

    if (!fs.existsSync(SETTINGS_PATH)) {
        console.log('[SETTINGS] settings.json not found, creating default settings.');
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(defaultSettings, null, 2));
        return defaultSettings;
    }
    try {
        let settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));

        // --- SETTINGS MIGRATION LOGIC ---
        // This is the correct place to handle/validate newly added settings during startup.
        // Otherwise users will potentially have errors when migrating to new viniplay
        // versions that expect new settings.
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

        // Cast profiles migration
        if (!settings.castProfiles) {
            console.log(`[SETTINGS_MIGRATE] Initializing Cast profiles block.`);
            settings.castProfiles = defaultSettings.castProfiles;
            needsSave = true;
        } else {
            defaultSettings.castProfiles.forEach(defaultProfile => {
                const existingProfile = settings.castProfiles.find(p => p.id === defaultProfile.id);
                if (!existingProfile) {
                    console.log(`[SETTINGS_MIGRATE] Adding missing Cast profile: ${defaultProfile.name}`);
                    settings.castProfiles.push(defaultProfile);
                    needsSave = true;
                } else if (existingProfile.isDefault) {
                    // Update default cast profile commands
                    if (existingProfile.command !== defaultProfile.command) {
                        console.log(`[SETTINGS_MIGRATE] Updating outdated default Cast profile command for: ${defaultProfile.name}`);
                        existingProfile.command = defaultProfile.command;
                        needsSave = true;
                    }
                }
            });
        }

        if (!settings.activeCastProfileId) {
            console.log(`[SETTINGS_MIGRATE] Initializing missing activeCastProfileId to ${defaultSettings.activeCastProfileId}.`);
            settings.activeCastProfileId = defaultSettings.activeCastProfileId;
            needsSave = true;
        }

        if (!settings.playerLogLevel) {
            // There is no playerLogLevel setting.  Add it with default setting.
            console.log(`[SETTINGS_MIGRATE] Initializing missing player Log Level setting to ${defaultSettings.playerLogLevel}.`);
            settings.playerLogLevel = defaultSettings.playerLogLevel;
            needsSave = true;
        } else if (!validFFmpegLogLevels.includes(settings.playerLogLevel)) {
            // There is a playerLogLevel setting but the value is not recognized.  Set to default.
            console.log(`[SETTINGS_MIGRATE_ERROR] player Log Level setting: ${settings.playerLogLevel} is invalid, set to default: ${defaultSettings.playerLogLevel}.`);
            settings.playerLogLevel = defaultSettings.playerLogLevel;
            needsSave = true;
        }

        if (!settings.dvrLogLevel) {
            // There is no dvrLogLevel setting.  Add it with default setting.
            console.log(`[SETTINGS_MIGRATE] Initializing missing dvr Log Level setting to ${defaultSettings.dvrLogLevel}.`);
            settings.dvrLogLevel = defaultSettings.dvrLogLevel;
            needsSave = true;
        } else if (!validFFmpegLogLevels.includes(settings.dvrLogLevel)) {
            // There is a dvrLogLevel setting but the value is not recognized.  Set to default.
            console.log(`[SETTINGS_MIGRATE_ERROR] dvr Log Level setting: ${settings.dvrLogLevel} is invalid, set to default: ${defaultSettings.dvrLogLevel}.`);
            settings.dvrLogLevel = defaultSettings.dvrLogLevel;
            needsSave = true;
        }

        // NEW: Logs settings migration
        if (!settings.logs) {
            console.log(`[SETTINGS_MIGRATE] Initializing missing logs settings block.`);
            settings.logs = defaultSettings.logs;
            needsSave = true;
        } else {
            // Ensure all log sub-settings exist
            if (settings.logs.maxFiles === undefined) {
                console.log(`[SETTINGS_MIGRATE] Adding missing logs.maxFiles setting.`);
                settings.logs.maxFiles = defaultSettings.logs.maxFiles;
                needsSave = true;
            }
            if (settings.logs.maxFileSizeBytes === undefined) {
                console.log(`[SETTINGS_MIGRATE] Adding missing logs.maxFileSizeBytes setting.`);
                settings.logs.maxFileSizeBytes = defaultSettings.logs.maxFileSizeBytes;
                needsSave = true;
            }
            if (settings.logs.autoDeleteDays === undefined) {
                console.log(`[SETTINGS_MIGRATE] Adding missing logs.autoDeleteDays setting.`);
                settings.logs.autoDeleteDays = defaultSettings.logs.autoDeleteDays;
                needsSave = true;
            }
        }

        // Check that all expected settings are present and set and if not,
        // generate log to highlight missing setting(s) migration code. 
        if (!settings || typeof settings !== 'object') {
            console.log('[SETTINGS_MIGRATE_ERROR] Settings are not valid.');
        } else {
            let allSettingsValid = true;
            for (const key of Object.keys(defaultSettings)) {
                if (!(key in settings) || settings[key] === undefined) {
                    console.log(`[SETTINGS_MIGRATE_ERROR] Expected setting ${key} is missing. server.js:getSettings() needs updating.`);
                    allSettingsValid = false;
                }
            }
            if (allSettingsValid) {
                console.log('[SETTINGS_MIGRATE] Settings are all valid.');
                if (needsSave) {
                    console.log('[SETTINGS_MIGRATE] Saving updated settings file after migration.');
                    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
                }
            } else {
                console.log('[SETTINGS_MIGRATE_ERROR] Settings are not all valid.');
            }
        }

        return settings;

    } catch (e) {
        console.error("[SETTINGS] Could not parse settings.json, returning default. Error:", e.message);
        return defaultSettings;
    }
}

// --- LOG ROTATION SYSTEM ---
let currentLogStream = null;
let currentLogFilePath = null;
let currentLogSize = 0;
let cachedLogSettings = {
    maxFiles: 5,
    maxFileSizeBytes: 5 * 1024 * 1024,
    autoDeleteDays: 7
};

/**
 * Updates the cached log settings. Call this after settings are changed.
 */
function refreshLogSettings() {
    try {
        const settings = getSettings();
        if (settings.logs) {
            cachedLogSettings = settings.logs;
        }
    } catch (error) {
        // Silently fail to avoid recursion
    }
}

/**
 * Gets the current active log file path.
 * @returns {string} Path to the current log file.
 */
function getCurrentLogFilePath() {
    if (!currentLogFilePath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        currentLogFilePath = path.join(LOGS_DIR, `viniplay-${timestamp}.log`);
    }
    return currentLogFilePath;
}

/**
 * Rotates the log file when size limit is reached.
 */
function rotateLogFile() {
    try {
        if (currentLogStream) {
            currentLogStream.end();
            currentLogStream = null;
        }

        // Create new log file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        currentLogFilePath = path.join(LOGS_DIR, `viniplay-${timestamp}.log`);
        currentLogSize = 0;

        // Use original console.log to avoid recursion
        const originalLog = console.log.__original || console.log;
        originalLog.call(console, `[LOG_ROTATE] Created new log file: ${path.basename(currentLogFilePath)}`);

        // Clean up old log files based on maxFiles setting
        cleanupOldLogsByCount();
    } catch (error) {
        // Silently fail to avoid recursion
    }
}

/**
 * Cleans up old log files based on the maxFiles setting.
 */
function cleanupOldLogsByCount() {
    try {
        const maxFiles = cachedLogSettings.maxFiles || 5;

        const logFiles = fs.readdirSync(LOGS_DIR)
            .filter(file => file.startsWith('viniplay-') && file.endsWith('.log'))
            .map(file => ({
                name: file,
                path: path.join(LOGS_DIR, file),
                mtime: fs.statSync(path.join(LOGS_DIR, file)).mtime
            }))
            .sort((a, b) => b.mtime - a.mtime); // Sort by newest first

        // Delete files beyond maxFiles limit
        if (logFiles.length > maxFiles) {
            const filesToDelete = logFiles.slice(maxFiles);
            filesToDelete.forEach(file => {
                try {
                    fs.unlinkSync(file.path);
                    const originalLog = console.log.__original || console.log;
                    originalLog.call(console, `[LOG_CLEANUP] Deleted old log file: ${file.name}`);
                } catch (err) {
                    // Silently fail
                }
            });
        }
    } catch (error) {
        // Silently fail to avoid recursion
    }
}

/**
 * Cleans up log files older than the configured autoDeleteDays.
 */
function cleanupOldLogsByAge() {
    try {
        const autoDeleteDays = cachedLogSettings.autoDeleteDays || 0;

        if (autoDeleteDays === 0) {
            return; // Auto-delete disabled
        }

        const cutoffTime = Date.now() - (autoDeleteDays * 24 * 60 * 60 * 1000);

        const logFiles = fs.readdirSync(LOGS_DIR)
            .filter(file => file.startsWith('viniplay-') && file.endsWith('.log'));

        logFiles.forEach(file => {
            const filePath = path.join(LOGS_DIR, file);
            const stats = fs.statSync(filePath);

            if (stats.mtime.getTime() < cutoffTime) {
                try {
                    fs.unlinkSync(filePath);
                    const originalLog = console.log.__original || console.log;
                    originalLog.call(console, `[LOG_CLEANUP] Deleted old log file (age): ${file}`);
                } catch (err) {
                    // Silently fail
                }
            }
        });
    } catch (error) {
        // Silently fail to avoid recursion
    }
}

/**
 * Writes a log message to the current log file.
 * @param {string} message - The log message to write.
 */
function writeToLogFile(message) {
    try {
        const maxSize = cachedLogSettings.maxFileSizeBytes || (5 * 1024 * 1024);

        // Check if we need to rotate
        if (currentLogSize >= maxSize) {
            rotateLogFile();
        }

        // Create stream if it doesn't exist
        if (!currentLogStream) {
            const logPath = getCurrentLogFilePath();
            currentLogStream = fs.createWriteStream(logPath, { flags: 'a' });

            // Get current file size if file exists
            if (fs.existsSync(logPath)) {
                currentLogSize = fs.statSync(logPath).size;
            }
        }

        const logLine = `${message}\n`;
        currentLogStream.write(logLine);
        currentLogSize += Buffer.byteLength(logLine);

    } catch (error) {
        // Silently fail to avoid infinite loop
    }
}

/**
 * Initializes the log system by overriding console methods.
 */
function initializeLogSystem() {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    // Store original functions for internal use
    console.log.__original = originalLog;
    console.error.__original = originalError;
    console.warn.__original = originalWarn;

    console.log = function (...args) {
        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' ');
        originalLog.apply(console, args);
        writeToLogFile(`[LOG] ${new Date().toISOString()} ${message}`);
    };

    console.error = function (...args) {
        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' ');
        originalError.apply(console, args);
        writeToLogFile(`[ERROR] ${new Date().toISOString()} ${message}`);
    };

    console.warn = function (...args) {
        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' ');
        originalWarn.apply(console, args);
        writeToLogFile(`[WARN] ${new Date().toISOString()} ${message}`);
    };

    // Refresh settings cache initially
    refreshLogSettings();

    // Run age-based cleanup on startup and then every 24 hours
    cleanupOldLogsByAge();
    setInterval(cleanupOldLogsByAge, 24 * 60 * 60 * 1000);

    console.log('[LOG_SYSTEM] Log rotation system initialized.');
}

// Initialize the log system
initializeLogSystem();

/**
 * Initiates the VOD refresh process for a given XC provider.
 * @param {object} provider - The M3U source object (must be type 'xc').
 * @param {sqlite3.Database} dbInstance - The active database connection.
 * @param {function} sendStatus - Function to send status updates.
 */
async function triggerVodRefreshForProvider(provider, dbInstance, sendStatus = () => { }) {
    if (!provider || provider.type !== 'xc' || !provider.xc_data) {
        console.error(`[VOD Trigger] Invalid provider object passed for VOD refresh. ID: ${provider?.id}`);
        return;
    }

    console.log(`[VOD Trigger] Starting VOD refresh for provider: ${provider.name} (ID: ${provider.id})`);
    sendStatus(`Triggering VOD refresh for ${provider.name}...`, 'info');

    try {
        const settings = getSettings();
        const activeUserAgent = settings.userAgents.find(ua => ua.id === settings.activeUserAgentId)?.value || 'VLC/3.0.20 (Linux; x86_64)';
        // Call the main processing function from vodProcessor.js
        await refreshVodContent(dbInstance, dbGet, dbAll, dbRun, provider, sendStatus, activeUserAgent);

        console.log(`[VOD Trigger] Successfully finished VOD refresh for provider: ${provider.name}`);

    } catch (error) {
        console.error(`[VOD Trigger] Error during VOD refresh for ${provider.name}: ${error.message}`);
        sendStatus(`VOD refresh FAILED for ${provider.name}: ${error.message}`, 'error');
    }
}


// ... existing helper functions (fetchUrlContent, parseEpgTime, processAndMergeSources) remain the same ...

function fetchUrlContent(url, options = {}, asBuffer = false) { // <-- MODIFIED
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const TIMEOUT_DURATION = 60000;
        console.log(`[FETCH] Attempting to fetch URL content: ${url} (Timeout: ${TIMEOUT_DURATION / 1000}s)`);

        const request = protocol.get(url, { timeout: TIMEOUT_DURATION, ...options }, (res) => { // <-- MODIFIED
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                console.log(`[FETCH] Redirecting to: ${res.headers.location}`);
                request.abort();
                // Pass the asBuffer flag through redirects
                return fetchUrlContent(new URL(res.headers.location, url).href, options, asBuffer).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                console.error(`[FETCH] Failed to fetch ${url}: Status Code ${res.statusCode}`);
                return reject(new Error(`Failed to fetch: Status Code ${res.statusCode}`));
            }

            if (asBuffer) {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    console.log(`[FETCH] Successfully fetched content as buffer from: ${url}`);
                    resolve(Buffer.concat(chunks));
                });
            } else {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    console.log(`[FETCH] Successfully fetched content from: ${url}`);
                    resolve(data);
                });
            }
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

    const [, year, month, day, hours, minutes, seconds, , sign, tzHours, tzMinutes] = match;
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

async function processAndMergeSources(req) {
    console.log('[PROCESS] Starting to process and merge all active sources.');
    sendProcessingStatus(req, 'Starting to process sources...', 'info');
    const settings = getSettings();

    // --- NEW: Data holders for separated content ---
    let mergedLiveM3uContent = '#EXTM3U\n';
    //let mergedVodMovies = [];
    //let mergedVodSeries = [];
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
                // Save raw content to cache (URL) ---
                try {
                    // Define cache path (ensure it's unique per source)
                    const cacheFileName = `raw_${source.id}.m3u_cache`; // Use a distinct extension
                    const cacheFilePath = path.join(RAW_CACHE_DIR, cacheFileName);

                    // Write the fetched content to the cache file
                    fs.writeFileSync(cacheFilePath, content);
                    console.log(`[PROCESS_CACHE] Saved raw content for source "${source.name}" to ${cacheFilePath}`);

                    // Store the path in the source object (this will be saved later when settings are saved)
                    source.cachedRawPath = cacheFilePath;

                } catch (cacheWriteError) {
                    console.error(`[PROCESS_CACHE] Failed to write raw cache for source "${source.name}" (URL):`, cacheWriteError.message);
                    // Clear any potentially stale cache path if writing failed
                    delete source.cachedRawPath;
                }
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

                const activeUserAgent = settings.userAgents.find(ua => ua.id === settings.activeUserAgentId)?.value || 'VLC/3.0.20 (Linux; x86_64)';
                m3uFetchOptions = { headers: { 'User-Agent': activeUserAgent } };

                // Fetch live streams from XC API
                const liveStreamsUrl = `${server}/player_api.php?username=${username}&password=${password}&action=get_live_streams`;
                try {
                    sendProcessingStatus(req, ` -> Fetching live categories from XC server...`, 'info');
                    const liveCategoriesUrl = `${server}/player_api.php?username=${username}&password=${password}&action=get_live_categories`;
                    console.log(`[M3U] Constructed XC Categories URL for "${source.name}": ${liveCategoriesUrl}`);
                    const liveCategoriesResponse = await fetchUrlContent(liveCategoriesUrl, m3uFetchOptions);
                    const liveCategories = JSON.parse(liveCategoriesResponse);

                    sendProcessingStatus(req, ` -> Fetching live streams from XC server...`, 'info');
                    console.log(`[M3U] Constructed XC Streams URL for "${source.name}": ${liveCategoriesUrl}`);
                    const liveStreamsResponse = await fetchUrlContent(liveStreamsUrl, m3uFetchOptions);
                    const liveStreams = JSON.parse(liveStreamsResponse);

                    // Filter and convert live streams to M3U format
                    let liveM3uContent = '';
                    let liveStreamCount = 0;

                    if (Array.isArray(liveStreams)) {
                        for (const stream of liveStreams) {
                            if (stream.stream_type === 'live') {
                                liveStreamCount++;
                                const streamUrl = `${server}/live/${username}/${password}/${stream.stream_id}.ts`;

                                // Find category name from categories array
                                const categoryName = Array.isArray(liveCategories)
                                    ? liveCategories.find(cat => cat.category_id == stream.category_id)?.category_name || 'Live'
                                    : 'Live';

                                // Use epg_channel_id if available, otherwise use stream_id
                                const tvgId = stream.epg_channel_id || stream.stream_id;

                                liveM3uContent += `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${stream.name}" tvg-logo="${stream.stream_icon || ''}" group-title="${categoryName}",${stream.name}\n`;
                                liveM3uContent += `${streamUrl}\n`;
                            }
                        }
                    }

                    if (liveStreamCount > 0) {
                        content += '\n' + liveM3uContent;
                        sendProcessingStatus(req, ` -> Added ${liveStreamCount} live streams to content.`, 'info');
                    } else {
                        sendProcessingStatus(req, ` -> No live streams found with stream_type = 'live'.`, 'info');
                    }
                } catch (liveError) {
                    console.error(`[XC Live] Error fetching live streams for "${source.name}": ${liveError.message}`);
                    sendProcessingStatus(req, ` -> Warning: Could not fetch live streams: ${liveError.message}`, 'warning');
                }

                // Save raw content to cache (XC) ---
                try {
                    // Define cache path (ensure it's unique per source)
                    const cacheFileName = `raw_${source.id}.m3u_cache`; // Use a distinct extension
                    const cacheFilePath = path.join(RAW_CACHE_DIR, cacheFileName);

                    // Write the fetched content to the cache file
                    fs.writeFileSync(cacheFilePath, content);
                    console.log(`[PROCESS_CACHE] Saved raw content for source "${source.name}" to ${cacheFilePath}`);

                    // Store the path in the source object (this will be saved later when settings are saved)
                    source.cachedRawPath = cacheFilePath;

                } catch (cacheWriteError) {
                    console.error(`[PROCESS_CACHE] Failed to write raw cache for source "${source.name}" (XC):`, cacheWriteError.message);
                    // Clear any potentially stale cache path if writing failed
                    delete source.cachedRawPath;
                }

                sourcePathForLog = liveStreamsUrl;
                sendProcessingStatus(req, ` -> Successfully fetched M3U content from XC server.`, 'info');
            }

            // --- NEW: Trigger VOD Refresh for all non-XC Sources ---
            if (source.type === 'file' || source.type === 'url') {
                console.log(`[PROCESS] Source "${source.name}" is a non-XC M3U. Triggering VOD processing.`);
                sendProcessingStatus(req, ` -> Triggering VOD content processing for M3U source "${source.name}"...`, 'info');
                await processM3uVod(db, dbGet, dbAll, dbRun, content, source, (msg, type) => sendProcessingStatus(req, msg, type));
            }
            // --- END VOD Trigger ---

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
                        continue; // Skip this entry - not in selected groups
                    }
                    // --- END GROUP FILTER ---

                    // --- LIVE CHANNEL PROCESSING (Only Live Channels here now) ---
                    liveStreamCount++;
                    let processedExtInf = currentExtInf;
                    const idMatch = currentExtInf.match(/tvg-id="([^"]*)"/); // Still needed for unique ID
                    const nameMatch = line.match(/tvg-name="([^"]*)"/); // Get name if available
                    const commaIndex = currentExtInf.lastIndexOf(',');
                    const name = nameMatch ? nameMatch[1] : ((commaIndex !== -1) ? currentExtInf.substring(commaIndex + 1).trim() : 'Unknown');

                    // Consistent Unique Channel ID Generation
                    const originalTvgId = idMatch ? idMatch[1] : `no-tvg-id-${name.replace(/[^a-zA-Z0-9]/g, '')}`;
                    const finalUniqueChannelId = `${source.id}_${originalTvgId}`;

                    // Inject the *corrected* unique ID into the #EXTINF line
                    if (idMatch) {
                        processedExtInf = processedExtInf.replace(/tvg-id="[^"]*"/, `tvg-id="${finalUniqueChannelId}"`);
                    } else {
                        const extinfEnd = processedExtInf.indexOf(':') + 1;
                        processedExtInf = processedExtInf.slice(0, extinfEnd) + ` tvg-id="${finalUniqueChannelId}"` + processedExtInf.slice(extinfEnd);
                    }

                    // Inject source name
                    const tvgIdAttrEnd = processedExtInf.indexOf(`tvg-id="${finalUniqueChannelId}"`) + `tvg-id="${finalUniqueChannelId}"`.length;
                    processedExtInf = processedExtInf.slice(0, tvgIdAttrEnd) + ` vini-source="${source.name}"` + processedExtInf.slice(tvgIdAttrEnd);

                    mergedLiveM3uContent += processedExtInf + '\n' + streamUrl + '\n';
                    liveChannelIdSet.add(finalUniqueChannelId);
                    // --- END LIVE CHANNEL PROCESSING ---

                    currentExtInf = ''; // Reset for next entry
                }
            }

            source.status = 'Success';
            source.statusMessage = `Processed ${liveStreamCount} Live channels.`;
            console.log(`[M3U] Source "${source.name}" processed successfully from ${sourcePathForLog}.`);
            sendProcessingStatus(req, ` -> Processed ${liveStreamCount} Live channels from "${source.name}".`, 'info');

            // --- NEW: Trigger VOD Refresh for XC Sources ---
            if (source.type === 'xc') {
                console.log(`[PROCESS] Source "${source.name}" is XC. Triggering VOD refresh.`);
                sendProcessingStatus(req, ` -> Triggering VOD content refresh for XC source "${source.name}"...`, 'info');
                // Use setImmediate to run the VOD refresh *after* the current M3U processing finishes
                // Pass the source object and the global db instance
                await triggerVodRefreshForProvider(source, db, (msg, type) => sendProcessingStatus(req, msg, type));
            }
            // --- END VOD Trigger ---

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
    try { // Try block for saving LIVE M3U
        fs.writeFileSync(LIVE_CHANNELS_M3U_PATH, mergedLiveM3uContent);
        console.log(`[M3U] Merged LIVE CHANNELS content saved to ${LIVE_CHANNELS_M3U_PATH}.`);
        sendProcessingStatus(req, `Successfully merged all live channels.`, 'success');
    } catch (writeErr) { // Catch block for saving LIVE M3U
        console.error(`[PROCESS] Error writing LIVE M3U file: ${writeErr.message}`);
        sendProcessingStatus(req, `Error writing live channels file: ${writeErr.message}`, 'error');
    }

    // --- EPG Processing (now filtered) ---
    const mergedProgramData = {};
    const timezoneOffset = settings.timezoneOffset || 0;

    if (activeEpgSources.length === 0) {
        console.log('[PROCESS] No active EPG sources found.');
        sendProcessingStatus(req, 'No active EPG sources found.', 'info');
    }

    for (const source of activeEpgSources) {
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

                // Use a different function to fetch raw buffer for compressed files
                if (source.path.endsWith('.gz')) {
                    const buffer = await fetchUrlContent(source.path, source.fetchOptions || {}, true); // Fetch as buffer
                    xmlString = zlib.gunzipSync(buffer).toString('utf-8');
                    sendProcessingStatus(req, ` -> Successfully fetched and decompressed EPG content.`, 'info');
                } else {
                    xmlString = await fetchUrlContent(source.path, source.fetchOptions || {});
                    sendProcessingStatus(req, ` -> Successfully fetched EPG content.`, 'info');
                }

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

                for (const m3uSource of m3uSourceProviders) {
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
    try { // Try block for saving EPG JSON
        fs.writeFileSync(LIVE_EPG_JSON_PATH, JSON.stringify(mergedProgramData));
        console.log(`[EPG] Merged EPG JSON content saved to ${LIVE_EPG_JSON_PATH}.`);
        sendProcessingStatus(req, `Successfully merged all EPG data for live channels.`, 'success');
    } catch (writeErr) { // Catch block for saving EPG JSON
        console.error(`[EPG] Error writing merged EPG JSON file: ${writeErr.message}`);
        sendProcessingStatus(req, `Error writing merged EPG JSON file: ${writeErr.message}`, 'error');
    }

    settings.sourcesLastUpdated = new Date().toISOString();
    console.log(`[PROCESS] Finished processing. New 'sourcesLastUpdated' timestamp: ${settings.sourcesLastUpdated}`);
    sendProcessingStatus(req, 'All sources processed successfully!', 'final_success');

    return { success: true, message: 'Sources merged successfully.', updatedSettings: settings };
}

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
            db.run("INSERT INTO users (username, password, isAdmin, canUseDvr) VALUES (?, ?, 1, 1)", [username, hash], function (err) {
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

// --- NEW/OPTIMIZED ENDPOINT FOR GROUP FILTERING (with Caching & Refresh) ---
app.post('/api/sources/fetch-groups', requireAuth, async (req, res) => {
    // --- ADDITION: Get refresh flag from query or body ---
    const forceRefresh = req.query.refresh === 'true' || req.body.refresh === true;
    const { type, url, xc, sourceId } = req.body; // Added sourceId
    // --- END ADDITION ---

    let fetchUrl;
    let fetchOptions = {};
    let content = '';
    let usedCache = false; // Flag to track if cache was used

    console.log(`[API_GROUPS] Fetching groups for type: ${type}, SourceID: ${sourceId}, Refresh: ${forceRefresh}`);

    try {
        let sourceToUse = null;
        if (sourceId) {
            const settings = getSettings();
            // Try finding in M3U sources first, then EPG (though unlikely for M3U groups)
            sourceToUse = settings.m3uSources.find(s => s.id === sourceId) || settings.epgSources.find(s => s.id === sourceId);
        }

        // --- START CACHE CHECK ---
        if (!forceRefresh && sourceToUse && sourceToUse.cachedRawPath && fs.existsSync(sourceToUse.cachedRawPath)) {
            try {
                console.log(`[API_GROUPS] Using cached raw file: ${sourceToUse.cachedRawPath}`);
                content = fs.readFileSync(sourceToUse.cachedRawPath, 'utf-8');
                usedCache = true;
            } catch (cacheReadError) {
                console.warn(`[API_GROUPS] Failed to read cache file ${sourceToUse.cachedRawPath}. Will fetch fresh. Error:`, cacheReadError.message);
                usedCache = false; // Ensure we fetch fresh if cache read fails
            }
        }
        // --- END CACHE CHECK ---

        // --- Fetch if cache wasn't used or refresh was forced ---
        if (type === 'xc' && xc) {
            const xcInfo = JSON.parse(xc);
            if (!xcInfo.server || !xcInfo.username || !xcInfo.password) {
                return res.status(400).json({ error: 'XC source requires server, username, and password.' });
            }
            console.log('[API_GROUPS] Source is XC type. Using XtreamClient to fetch all categories.');
            const settings = getSettings();
            const activeUserAgent = settings.userAgents.find(ua => ua.id === settings.activeUserAgentId)?.value || 'VLC/3.0.20 (Linux; x86_64)';
            const client = new XtreamClient(xcInfo.server, xcInfo.username, xcInfo.password, activeUserAgent);
            const allCategories = await client.getAllCategories();
            return res.json({ success: true, groups: allCategories, usedCache: false });
        }

        if (!usedCache) {
            console.log(`[API_GROUPS] ${forceRefresh ? 'Refresh forced' : 'Cache not used/found'}. Fetching from original source.`);
            if (type === 'url' && url) {
                fetchUrl = url;
                content = await fetchUrlContent(fetchUrl, fetchOptions);
            } else if (type === 'file' && url) { // Assuming url holds file path for type file
                const filePath = sourceToUse?.path || path.join(SOURCES_DIR, path.basename(url)); // Prefer path from settings if available
                if (fs.existsSync(filePath)) {
                    content = fs.readFileSync(filePath, 'utf-8');
                } else {
                    return res.status(400).json({ error: 'File source path not found or invalid.' });
                }
            } else {
                return res.status(400).json({ error: 'Valid source details (URL, XC, or File path) are required.' });
            }
        }
        // --- End Fetch Logic ---


        // --- Efficiently Extract Groups (Handles JSON for XC and Regex for M3U) ---
        const groups = new Set();
        try {
            // First, try to parse as JSON (for XC sources which return a JSON array of categories)
            const groupJsonArray = JSON.parse(content);
            console.log(`[API_GROUPS] Successfully parsed content as JSON. Scanning for group titles.`);
            if (Array.isArray(groupJsonArray)) {
                for (const category of groupJsonArray) {
                    if (category && typeof category.category_name === 'string') {
                        const groupName = category.category_name.trim();
                        if (groupName) groups.add(groupName);
                    }
                }
            }
        } catch (jsonError) {
            // If JSON parsing fails, assume it's a plain M3U file and use regex
            console.log(`[API_GROUPS] Content is not valid JSON, attempting to parse as plain M3U.`);
            const groupTitleRegex = /group-title=\"([^\"]+)\"/g;
            let match;
            while ((match = groupTitleRegex.exec(content)) !== null) {
                const groupName = match[1].trim();
                if (groupName) {
                    groups.add(groupName);
                }
            }
        }

        const sortedGroups = Array.from(groups).sort((a, b) => a.localeCompare(b));
        console.log(`[API_GROUPS] Found ${sortedGroups.length} unique groups.`);
        res.json({ success: true, groups: sortedGroups, usedCache: usedCache }); // Optionally tell frontend if cache was used

    } catch (error) {
        console.error(`[API_GROUPS] Failed to fetch or parse M3U for groups: ${error.message}`);
        res.status(500).json({ error: `Failed to fetch or process groups: ${error.message}` });
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
                return res.status(403).json({ error: "Cannot remove the last administrator." });
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

    db.run("DELETE FROM users WHERE id = ?", idToDelete, function (err) {
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

// --- NEW: VOD Library Endpoint (Reads from DB and builds URLs) ---
app.get('/api/vod/library', requireAuth, async (req, res) => {
    console.log('[API_VOD] Request received for /api/vod/library (DB Query)');
    try {
        // 1. Get active XC providers from settings
        const settings = getSettings();
        const activeXcProviders = settings.m3uSources.filter(s => s.isActive && s.type === 'xc');
        const providerMap = new Map();
        activeXcProviders.forEach(p => {
            try {
                const xcInfo = JSON.parse(p.xc_data);
                const url = new URL(xcInfo.server);
                providerMap.set(p.id, {
                    baseUrl: `${url.protocol}//${url.host}`,
                    username: xcInfo.username,
                    password: xcInfo.password
                });
            } catch (e) {
                console.error(`[API_VOD] Skipping provider ${p.name}, invalid XC data: ${e.message}`);
            }
        });
        const activeProviderIds = Array.from(providerMap.keys());
        if (activeProviderIds.length === 0) {
            console.log('[API_VOD] No active XC providers found. Returning empty library.');
            return res.json({ movies: [], series: [] });
        }

        const providerIdPlaceholders = activeProviderIds.map(() => '?').join(',');

        // 2. Fetch all movies from active providers
        const movieQuery = `
            SELECT m.provider_unique_id, m.name, m.year, m.description, m.logo, m.tmdb_id, m.imdb_id, m.category_name, r.stream_id, r.container_extension, r.provider_id
            FROM movies m
            JOIN provider_movie_relations r ON m.id = r.movie_id
            WHERE r.provider_id IN (${providerIdPlaceholders})
            ORDER BY m.name
        `;
        const movies = await dbAll(db, movieQuery, activeProviderIds);

        const processedMovies = movies.map(m => {
            const provider = providerMap.get(m.provider_id);
            if (!provider) return null; // Skip if provider is not active
            const ext = m.container_extension || 'mp4';
            // Build the full playable URL
            const url = `${provider.baseUrl}/movie/${provider.username}/${provider.password}/${m.stream_id}.${ext}`;
            return {
                id: m.provider_unique_id, // Use the stable provider_unique_id
                name: m.name,
                year: m.year,
                description: m.description,
                logo: m.logo,
                tmdb_id: m.tmdb_id,
                imdb_id: m.imdb_id,
                url: url, // The all-important URL
                type: 'movie',
                group: m.category_name
            };
        }).filter(Boolean); // Filter out null entries
        console.log(`[API_VOD] Fetched ${processedMovies.length} movies from DB.`);

        // 3. Fetch all series headers from active providers
        const seriesQuery = `
            SELECT DISTINCT s.provider_unique_id, s.name, s.year, s.description, s.logo, s.tmdb_id, s.imdb_id, s.category_name
            FROM series s
            JOIN provider_series_relations r ON s.id = r.series_id
            WHERE r.provider_id IN (${providerIdPlaceholders})
            ORDER BY s.name
        `;
        const seriesList = await dbAll(db, seriesQuery, activeProviderIds);
        console.log(`[API_VOD] Fetched ${seriesList.length} series headers from DB.`);

        // 4. Fetch episodes for each series
        /*
        for (const series of seriesList) {
            const numericSeriesId = parseInt(String(series.id), 10);
            
            const episodeQuery = `
                SELECT e.id, e.season_num, e.episode_num, e.name, e.description, e.air_date, e.tmdb_id,
                       r.provider_stream_id, r.provider_id
                FROM episodes e
                JOIN provider_episode_relations r ON e.id = r.episode_id
                WHERE e.series_id = ? AND r.provider_id IN (${providerIdPlaceholders})
                ORDER BY e.season_num, e.episode_num
            `;
            const episodes = await dbAll(db, episodeQuery, [numericSeriesId, ...activeProviderIds]);

            // Group episodes by season
            const seasons = new Map();
            episodes.forEach(ep => {
                const provider = providerMap.get(ep.provider_id);
                if (!provider) return; // Skip episode if its provider is not active
                
                const ext = ep.container_extension || 'mp4';
                // Build the full playable URL
                const epUrl = `${provider.baseUrl}/series/${provider.username}/${provider.password}/${ep.stream_id}.${ext}`;

                const seasonNum = ep.season_num;
                if (!seasons.has(seasonNum)) {
                    seasons.set(seasonNum, []);
                }
                seasons.get(seasonNum).push({
                    id: String(ep.id),
                    name: ep.name,
                    description: ep.description,
                    air_date: ep.air_date,
                    tmdb_id: ep.tmdb_id,
                    season: ep.season_num,
                    episode: ep.episode_num,
                    url: epUrl // The all-important URL
                });
            });
            
            // Convert Map to the object structure the frontend expects
            series.seasons = Object.fromEntries(seasons);
            series.type = 'series'; // Add type
            series.id = String(series.id); // Ensure string ID
            series.group = series.category_name
        }

        console.log(`[API_VOD] Finished fetching episodes for all series.`);
        */

        // --- ADD this minimal processing step instead ---
        seriesList.forEach(series => {
            series.type = 'series';
            series.id = series.provider_unique_id; // Use the stable provider_unique_id
            series.group = series.category_name;
            // Ensure seasons object is NOT present
            delete series.seasons;
        });
        console.log(`[API_VOD] Processed series headers. Episodes will be lazy-loaded.`);

        // 5. Respond
        const categories = await dbAll(db, "SELECT category_name FROM vod_categories ORDER BY category_name");
        const categoryNames = categories.map(cat => cat.category_name);

        res.json({
            movies: processedMovies,
            series: seriesList,
            categories: categoryNames
        });

    } catch (error) {
        console.error(`[API_VOD] Error fetching VOD library from DB: ${error.message}`, error);
        res.status(500).json({ error: "Could not retrieve VOD library from database." });
    }
});

// --- NEW: Lazy Loading Endpoint for Series Details ---
app.get('/api/vod/series/:seriesId', requireAuth, async (req, res) => {
    const seriesIdParam = req.params.seriesId;

    console.log(`[API_VOD_SERIES] Request received for Series ID: ${seriesIdParam}`);

    try {
        // 1. Fetch basic series info using the provider_unique_id
        const seriesInfo = await dbGet(db, "SELECT * FROM series WHERE provider_unique_id = ?", [seriesIdParam]);
        if (!seriesInfo) {
            return res.status(404).json({ error: 'Series not found.' });
        }
        const numericSeriesId = seriesInfo.id; // Get the internal numeric ID for relations

        // 2. Check if episodes exist in DB
        const existingEpisodes = await dbAll(db, `
            SELECT e.*, r.provider_id, r.provider_stream_id, r.container_extension
            FROM episodes e
            JOIN provider_episode_relations r ON e.id = r.episode_id
            WHERE e.series_id = ?
            ORDER BY e.season_num, e.episode_num
        `, [numericSeriesId]);

        let episodesToReturn = existingEpisodes;

        // 3. If no episodes in DB, fetch from XC API and save
        if (existingEpisodes.length === 0) {
            console.log(`[API_VOD_SERIES] No episodes found in DB for Series ID ${numericSeriesId}. Fetching from provider...`);

            // Find the provider details for this series
            const relation = await dbGet(db, "SELECT provider_id, external_series_id FROM provider_series_relations WHERE series_id = ? LIMIT 1", [numericSeriesId]);
            if (!relation) {
                return res.status(404).json({ error: 'Could not find provider information for this series.' });
            }

            const settings = getSettings();
            const providerConfig = settings.m3uSources.find(s => s.id === relation.provider_id);
            if (!providerConfig || providerConfig.type !== 'xc' || !providerConfig.xc_data) {
                return res.status(500).json({ error: 'Could not find or parse XC provider configuration for this series.' });
            }

            let xcInfo;
            try {
                xcInfo = JSON.parse(providerConfig.xc_data);
            } catch (e) {
                return res.status(500).json({ error: 'Failed to parse XC provider credentials.' });
            }

            const activeUserAgent = settings.userAgents.find(ua => ua.id === settings.activeUserAgentId)?.value || 'VLC/3.0.20 (Linux; x86_64)';
            const client = new XtreamClient(xcInfo.server, xcInfo.username, xcInfo.password, activeUserAgent);
            let seriesDetails;
            try {
                seriesDetails = await client.getSeriesInfo(relation.external_series_id);
            } catch (xcError) {
                console.error(`[API_VOD_SERIES] XC Client error for series ${numericSeriesId}: ${xcError.message}`);
                return res.status(504).json({ error: `Provider timeout: Could not fetch series details from the provider. Please try again later.` });
            }

            if (!seriesDetails || !seriesDetails.episodes) {
                console.warn(`[API_VOD_SERIES] Provider returned no episode data for external ID ${relation.external_series_id}.`);
                episodesToReturn = [];
            } else {
                console.log(`[API_VOD_SERIES] Fetched ${Object.values(seriesDetails.episodes).flat().length} episodes from provider. Saving to DB...`);
                const episodeInsertStmt = db.prepare(`INSERT OR IGNORE INTO episodes (series_id, season_num, episode_num, name, description, air_date, tmdb_id, imdb_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
                const episodeRelationInsertStmt = db.prepare(`INSERT OR IGNORE INTO provider_episode_relations (provider_id, episode_id, provider_stream_id, container_extension, last_seen) VALUES (?, ?, ?, ?, ?)`);
                const lastSeen = new Date().toISOString();

                await dbRun(db, "BEGIN TRANSACTION");
                try {
                    for (const seasonNum in seriesDetails.episodes) {
                        for (const epData of seriesDetails.episodes[seasonNum]) {
                            let episodeId;
                            const existingEp = await dbGet(db, `SELECT id FROM episodes WHERE series_id = ? AND season_num = ? AND episode_num = ?`, [numericSeriesId, epData.season || seasonNum, epData.episode_num]);

                            if (existingEp) {
                                episodeId = existingEp.id;
                            } else {
                                const epResult = await new Promise((resolve, reject) => {
                                    episodeInsertStmt.run(numericSeriesId, epData.season || seasonNum, epData.episode_num, epData.title, epData.info?.plot, epData.info?.releasedate, null, null, function (err) {
                                        if (err) reject(err);
                                        else resolve(this);
                                    });
                                });
                                episodeId = epResult.lastID;
                            }

                            await new Promise((resolve, reject) => {
                                episodeRelationInsertStmt.run(relation.provider_id, episodeId, epData.id, epData.container_extension || 'mp4', lastSeen, function (err) {
                                    if (err) reject(err);
                                    else resolve(this);
                                });
                            });
                        }
                    }
                    await dbRun(db, "COMMIT");
                    console.log(`[API_VOD_SERIES] Successfully saved episodes for Series ID ${numericSeriesId} to DB.`);
                } catch (dbError) {
                    await dbRun(db, "ROLLBACK");
                    console.error(`[API_VOD_SERIES] DB Error saving episodes for Series ID ${numericSeriesId}: ${dbError.message}`);
                    return res.status(500).json({ error: 'Failed to save fetched episodes to database.' });
                } finally {
                    episodeInsertStmt.finalize();
                    episodeRelationInsertStmt.finalize();
                }
                episodesToReturn = await dbAll(db, `
                    SELECT e.*, r.provider_id, r.provider_stream_id, r.container_extension
                    FROM episodes e
                    JOIN provider_episode_relations r ON e.id = r.episode_id
                    WHERE e.series_id = ?
                    ORDER BY e.season_num, e.episode_num
                `, [numericSeriesId]);
            }
        } else {
            console.log(`[API_VOD_SERIES] Found ${existingEpisodes.length} episodes in DB for Series ID ${numericSeriesId}.`);
        }

        // 4. Build the response structure
        const seasons = new Map();
        const settings = getSettings();
        const activeXcProviders = settings.m3uSources.filter(s => s.isActive && s.type === 'xc');
        const providerMap = new Map();
        activeXcProviders.forEach(p => {
            try {
                const xcInfo = JSON.parse(p.xc_data);
                const url = new URL(xcInfo.server);
                providerMap.set(p.id, {
                    baseUrl: `${url.protocol}//${url.host}`,
                    username: xcInfo.username,
                    password: xcInfo.password
                });
            } catch (e) { /* ignore */ }
        });


        episodesToReturn.forEach(ep => {
            const provider = providerMap.get(ep.provider_id);
            if (!provider) return;

            const ext = ep.container_extension || 'mp4';
            const epUrl = `${provider.baseUrl}/series/${provider.username}/${provider.password}/${ep.provider_stream_id}.${ext}`;
            const seasonNum = ep.season_num;

            if (!seasons.has(seasonNum)) {
                seasons.set(seasonNum, []);
            }
            seasons.get(seasonNum).push({
                id: String(ep.id),
                name: ep.name,
                description: ep.description,
                air_date: ep.air_date,
                tmdb_id: ep.tmdb_id,
                season: ep.season_num,
                episode: ep.episode_num,
                url: epUrl
            });
        });

        const finalSeriesData = {
            ...seriesInfo,
            id: seriesInfo.provider_unique_id, // Use the stable provider_unique_id
            type: 'series',
            group: seriesInfo.category_name,
            seasons: Object.fromEntries(seasons)
        };

        res.json(finalSeriesData);

    } catch (error) {
        console.error(`[API_VOD_SERIES] Error fetching details for Series ID ${seriesIdParam}: ${error.message}`, error);
        res.status(500).json({ error: "Could not retrieve series details." });
    }
});
// --- END NEW ENDPOINT ---

// --- NEW: VOD Categories Endpoint ---
app.get('/api/vod/categories', requireAuth, async (req, res) => {
    console.log('[API_VOD] Request received for /api/vod/categories');
    try {
        const categories = await dbAll(db, "SELECT category_name FROM vod_categories ORDER BY category_name");
        const categoryNames = categories.map(cat => cat.category_name);
        res.json({ success: true, categories: categoryNames });
    } catch (error) {
        console.error(`[API_VOD] Error fetching VOD categories: ${error.message}`, error);
        res.status(500).json({ error: "Could not retrieve VOD categories." });
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
            } catch (e) {
                sourceToUpdate.path = 'Xtream Codes Source';
            }
        } else if (sourceToUpdate.type === 'file' && !req.file && (!sourceToUpdate.path || !fs.existsSync(sourceToUpdate.path))) {
            console.warn(`[SOURCES_API] Existing file source ${id} has no file and no new file/URL provided.`);
            return res.status(400).json({ error: 'Existing file source requires a new file if original is missing.' });
        }

        // --- NEW: XC EPG Sync Logic on Update ---
        const wasXc = sourceToUpdate.type === 'xc';
        const isNowXc = (xc !== undefined && xc !== null);

        // Case 1: Type changed FROM XC to something else (URL or File)
        if (wasXc && !isNowXc) {
            const epgIdToDelete = `epg_for_${id}`;
            const initialEpgCount = settings.epgSources.length;
            settings.epgSources = settings.epgSources.filter(epg => epg.id !== epgIdToDelete);
            if (settings.epgSources.length < initialEpgCount) {
                console.log(`[SOURCES_API] Deleted managed EPG source ${epgIdToDelete} because parent source type changed from XC.`);
            }
        }

        // Case 2: Type changed TO XC from something else, or it IS XC and is being updated
        if (isNowXc) {
            const epgId = `epg_for_${id}`;
            let epgSource = settings.epgSources.find(epg => epg.id === epgId);

            try {
                const xcData = JSON.parse(xc);
                const newEpgUrl = `${xcData.server}/xmltv.php?username=${xcData.username}&password=${xcData.password}`;

                if (epgSource) { // EPG already exists, update it
                    console.log(`[SOURCES_API] Found and updating managed EPG source ${epgId}.`);
                    epgSource.name = `${name} (EPG)`;
                    epgSource.path = newEpgUrl;
                    epgSource.refreshHours = parseInt(refreshHours, 10) || 0;
                } else { // EPG does not exist, create it
                    console.log(`[SOURCES_API] Creating new managed EPG source ${epgId} because parent source type changed to XC.`);
                    epgSource = {
                        id: epgId,
                        name: `${name} (EPG)`,
                        type: 'url',
                        path: newEpgUrl,
                        isActive: true,
                        isXcEpg: true,
                        refreshHours: parseInt(refreshHours, 10) || 0,
                        lastUpdated: new Date().toISOString(),
                        status: 'Pending',
                        statusMessage: 'Managed by XC source. Process to load data.'
                    };
                    settings.epgSources.push(epgSource);
                }
            } catch (e) {
                console.error(`[SOURCES_API] Error processing XC data for EPG sync on update:`, e.message);
            }
        }
        // --- END NEW ---

        // Cache cleanup on source type/path/details change during update ---
        let shouldDeleteCache = false;
        const existingCachePath = sourceToUpdate.cachedRawPath; // Store existing path before potential changes

        // Determine the NEW source type based on the logic that just ran above this block
        let newSourceType = 'unknown';
        if (req.file) {
            newSourceType = 'file';
        } else if (url !== undefined && url !== null) {
            newSourceType = 'url';
        } else if (xc) {
            newSourceType = 'xc';
        } else {
            newSourceType = sourceToUpdate.type; // Keep original if no new info provided
        }


        // Condition 1: If it HAD a cache file, but the NEW type is 'file'
        if (existingCachePath && newSourceType === 'file') {
            console.log(`[SOURCES_API_CACHE_CLEANUP] Source ${id} changed to 'file' type. Flagging cache for deletion.`);
            shouldDeleteCache = true;
        }
        // Condition 2: If it HAD a cache file, the NEW type is 'url', AND the URL changed
        else if (existingCachePath && newSourceType === 'url' && sourceToUpdate.path !== url) {
            console.log(`[SOURCES_API_CACHE_CLEANUP] Source ${id} URL changed. Flagging cache for deletion.`);
            shouldDeleteCache = true;
        }
        // Condition 3: If it HAD a cache file, the NEW type is 'xc', AND the XC details changed
        else if (existingCachePath && newSourceType === 'xc' && sourceToUpdate.xc_data !== xc) {
            console.log(`[SOURCES_API_CACHE_CLEANUP] Source ${id} XC details changed. Flagging cache for deletion.`);
            shouldDeleteCache = true;
        }

        // Perform deletion if flagged
        if (shouldDeleteCache && fs.existsSync(existingCachePath)) {
            try {
                fs.unlinkSync(existingCachePath);
                console.log(`[SOURCES_API_CACHE_CLEANUP] Deleted stale cached raw file during update: ${existingCachePath}`);
            } catch (e) { console.error("[SOURCES_API_CACHE_CLEANUP] Could not delete stale cached raw file during update:", e); }
            // Remove the path property from the source object being saved
            delete sourceToUpdate.cachedRawPath;
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

        // --- NEW: Automatically add an EPG source for new XC sources ---
        if (newSource.type === 'xc') {
            try {
                const xcData = JSON.parse(newSource.xc_data);
                const epgUrl = `${xcData.server}/xmltv.php?username=${xcData.username}&password=${xcData.password}`;
                const newEpgSource = {
                    id: `epg_for_${newSource.id}`,
                    name: `${newSource.name} (EPG)`,
                    type: 'url',
                    path: epgUrl,
                    isActive: true, // Default to active
                    isXcEpg: true, // Mark as a managed XC EPG
                    refreshHours: newSource.refreshHours, // Sync refresh interval
                    lastUpdated: new Date().toISOString(),
                    status: 'Pending',
                    statusMessage: 'Managed by XC source. Process to load data.'
                };
                settings.epgSources.push(newEpgSource);
                console.log(`[SOURCES_API] Automatically added managed EPG source for XC source "${newSource.name}".`);
            } catch (e) {
                console.error(`[SOURCES_API] Failed to create automatic EPG for new XC source ${newSource.id}:`, e.message);
            }
        }
        // --- END NEW ---

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

app.delete('/api/sources/:sourceType/:id', requireAuth, async (req, res) => {
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

    if (source && source.cachedRawPath && fs.existsSync(source.cachedRawPath)) {
        try {
            fs.unlinkSync(source.cachedRawPath);
            console.log(`[SOURCES_API] Deleted cached raw file: ${source.cachedRawPath}`);
        } catch (e) {
            console.error(`[SOURCES_API] Could not delete cached raw file: ${source.cachedRawPath}`, e);
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

    // --- NEW: Automatically delete the managed EPG when an XC source is deleted ---
    if (sourceType === 'm3u' && source && source.type === 'xc') {
        const epgIdToDelete = `epg_for_${id}`;
        const initialEpgCount = settings.epgSources.length;
        settings.epgSources = settings.epgSources.filter(epg => epg.id !== epgIdToDelete);
        if (settings.epgSources.length < initialEpgCount) {
            console.log(`[SOURCES_API] Automatically deleted managed EPG source ${epgIdToDelete} as its parent XC source was deleted.`);
        }
    }
    // --- END NEW ---

    saveSettings(settings);
    console.log(`[SOURCES_API] Source ${id} deleted successfully from settings.`);

    // --- NEW: VOD Database Cleanup ---
    if (sourceType === 'm3u' && source.type === 'xc') {
        try {
            console.log(`[SOURCES_API] Deleting VOD relations for provider: ${id}`);
            await dbRun(db, "BEGIN TRANSACTION");
            await dbRun(db, `DELETE FROM provider_movie_relations WHERE provider_id = ?`, [id]);
            await dbRun(db, `DELETE FROM provider_series_relations WHERE provider_id = ?`, [id]);
            await dbRun(db, `DELETE FROM provider_episode_relations WHERE provider_id = ?`, [id]);

            // Cleanup orphans
            await dbRun(db, `DELETE FROM movies WHERE id NOT IN (SELECT DISTINCT movie_id FROM provider_movie_relations)`);
            await dbRun(db, `DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series_id FROM provider_series_relations)`);
            await dbRun(db, `DELETE FROM episodes WHERE id NOT IN (SELECT DISTINCT episode_id FROM provider_episode_relations)`);

            await dbRun(db, "COMMIT");
            console.log(`[SOURCES_API] Successfully cleaned up VOD data for provider: ${id}`);
        } catch (dbErr) {
            await dbRun(db, "ROLLBACK");
            console.error(`[SOURCES_API] Error cleaning up VOD data for provider ${id}:`, dbErr.message);
        }
    }
    // --- END NEW ---

    res.json({ success: true, message: 'Source deleted.', settings: getSettings() });
});

app.post('/api/process-sources', requireAuth, async (req, res) => {
    console.log('[API] Received request to /api/process-sources (manual trigger).');
    try {
        const result = await processAndMergeSources(req); // <-- MODIFIED: Pass req

        if (result.success) {
            fs.writeFileSync(SETTINGS_PATH, JSON.stringify(result.updatedSettings, null, 2));
            console.log('[API] Source processing completed and settings saved (manual trigger).');
            res.json({ success: true, message: 'Sources merged successfully.' });
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
        function (err) {
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

    db.run("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?", [endpoint, req.session.userId], function (err) {
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
        function (err) {
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
            try { ffmpegProcess.kill('SIGKILL'); } catch (e) { }
        }
        activeStreamProcesses.clear();
        for (const pid of runningFFmpegProcesses.values()) {
            try { process.kill(pid, 'SIGKILL'); } catch (e) { }
        }
        runningFFmpegProcesses.clear();

        console.log('[API_RESET] Wiping all data files...');
        const filesToDelete = [LIVE_CHANNELS_M3U_PATH, LIVE_EPG_JSON_PATH, VOD_MOVIES_JSON_PATH, VOD_SERIES_JSON_PATH, SETTINGS_PATH, VAPID_KEYS_PATH];
        filesToDelete.forEach(file => {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        });

        [SOURCES_DIR, DVR_DIR].forEach(dir => {
            if (fs.existsSync(dir)) {
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

// Middleware to allow local network access OR authenticated access OR cast token
// This enables Chromecast devices to access streams using temporary tokens
function allowLocalOrAuth(req, res, next) {
    // Check if authenticated via session
    if (req.session && req.session.userId) {
        return next();
    }

    // Check for Cast token (priority for Chromecast)
    const { castToken } = req.query;
    if (castToken) {
        const tokenData = activeCastTokens.get(castToken);

        if (!tokenData) {
            console.warn(`[STREAM_AUTH] Invalid cast token: ${castToken.substring(0, 8)}...`);
            return res.status(401).send('Invalid cast token');
        }

        if (tokenData.expiresAt < Date.now()) {
            console.warn(`[STREAM_AUTH] Expired cast token: ${castToken.substring(0, 8)}...`);
            activeCastTokens.delete(castToken);
            return res.status(401).send('Expired cast token');
        }

        console.log(`[STREAM_AUTH] ✓ Valid cast token for user ${tokenData.userId}`);

        // Set session from token
        req.session = req.session || {};
        req.session.userId = tokenData.userId;
        req.session.username = 'Cast User';

        // One-time use: delete token after successful auth
        activeCastTokens.delete(castToken);

        return next();
    }

    // Get the real client IP (first IP in X-Forwarded-For chain, before Cloudflare)
    let clientIp = req.clientIp || req.ip;

    // X-Forwarded-For can be a comma-separated list: "client, proxy1, proxy2"
    // We want the FIRST IP (the real client)
    if (clientIp && clientIp.includes(',')) {
        clientIp = clientIp.split(',')[0].trim();
    }

    console.log(`[STREAM_AUTH] Checking IP: ${clientIp} (original: ${req.clientIp || req.ip})`);

    // Check if request is from local network (fallback for direct local access)
    const isLocal = clientIp.startsWith('192.168.') ||
        clientIp.startsWith('10.') ||
        clientIp.startsWith('172.16.') ||
        clientIp === '127.0.0.1' ||
        clientIp === '::1' ||
        clientIp === '::ffff:127.0.0.1';

    if (isLocal) {
        console.log(`[STREAM_AUTH] ✓ Allowing unauthenticated access from local network: ${clientIp}`);
        // Set a dummy session for logging purposes
        req.session = req.session || {};
        req.session.userId = 1; // Default to admin user for local access
        req.session.username = 'Local Network';
        return next();
    }

    console.warn(`[STREAM_AUTH] ✗ Unauthorized access attempt from: ${clientIp}`);
    res.status(401).send('Authentication required');
}

// MODIFIED: Stream endpoint now allows local network access for Chromecast
app.get('/stream', allowLocalOrAuth, async (req, res) => {
    const { url: streamUrl, profileId, userAgentId, vodName, vodLogo } = req.query;
    const userId = req.session.userId;
    const username = req.session.username;
    const clientIp = req.clientIp;

    // Include profileId in stream key so Cast (MP4) and browser (MPEG-TS) don't share the same process
    const streamKey = `${userId}::${streamUrl}::${profileId}`;

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
    // Check both streamProfiles and castProfiles arrays
    let profile = (settings.streamProfiles || []).find(p => p.id === profileId);
    if (!profile) {
        profile = (settings.castProfiles || []).find(p => p.id === profileId);
    }

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

    // --- NEW: VOD-aware Activity Logging ---
    let channelName, channelId, channelLogo;
    if (vodName) {
        // It's a VOD stream
        channelName = vodName;
        channelLogo = vodLogo || null;
        channelId = null; // VODs don't have a channel ID in the same way live channels do
        console.log(`[STREAM] VOD stream detected for logging: Name='${channelName}'`);
    } else {
        // It's a live channel stream, use existing M3U parsing logic
        const allChannels = parseM3U(fs.existsSync(LIVE_CHANNELS_M3U_PATH) ? fs.readFileSync(LIVE_CHANNELS_M3U_PATH, 'utf-8') : '');
        const channel = allChannels.find(c => c.url === streamUrl);
        channelName = channel ? channel.displayName || channel.name : 'Direct Stream';
        channelId = channel ? channel.id : null;
        channelLogo = channel ? channel.logo : null;
    }
    const streamProfileName = profile ? profile.name : 'Unknown Profile';
    // --- END NEW ---

    console.log(`[STREAM] Using Profile='${profile.name}' (ID=${profile.id}), UserAgent='${userAgent.name}'`);

    // Prefix ffmpeg command with "-v level+{playerLoglevel}" here to control log spamming.
    // Using warning loglevel limits messages to actual warnings and errors.
    // playerLogLevel is configured via settings page pulldown.
    const commandTemplate = `-v level+${settings.playerLogLevel} ` + profile.command
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
        function (err) {
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

    // Set appropriate Content-Type based on output format
    if (profile.command.includes('-f mp4')) {
        res.setHeader('Content-Type', 'video/mp4');
        console.log(`[STREAM] Setting Content-Type: video/mp4`);
    } else {
        res.setHeader('Content-Type', 'video/mp2t');
    }
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

// ============================================================
// CAST: Generate authentication token for Chromecast
// ============================================================
app.post('/api/cast/generate-token', requireAuth, (req, res) => {
    try {
        const { streamUrl } = req.body;
        const userId = req.session.userId;

        if (!streamUrl) {
            return res.status(400).json({ error: 'streamUrl is required' });
        }

        // Generate secure random token
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + (5 * 60 * 1000); // 5 minutes

        // Store token
        activeCastTokens.set(token, {
            userId,
            streamUrl,
            expiresAt,
            createdAt: Date.now()
        });

        // Auto-cleanup after expiry
        setTimeout(() => {
            activeCastTokens.delete(token);
            console.log(`[CAST_TOKEN] Token expired and removed: ${token.substring(0, 8)}...`);
        }, 5 * 60 * 1000);

        console.log(`[CAST_TOKEN] Generated token for user ${userId}, expires in 5 minutes`);

        res.json({ token });
    } catch (error) {
        console.error('[CAST_TOKEN] Error generating token:', error);
        res.status(500).json({ error: 'Failed to generate cast token' });
    }
});

// ============================================================
// STREAM STOP: Manually stop a stream
// ============================================================
app.post('/api/stream/stop', requireAuth, (req, res) => {
    const { url: streamUrl, profileId } = req.body;
    let streamKey;

    if (!streamUrl) {
        return res.status(400).json({ error: "Stream URL is required to stop the stream." });
    }

    // If profileId is provided, construct the specific key
    if (profileId) {
        streamKey = `${req.session.userId}::${streamUrl}::${profileId}`;
    } else {
        // If no profileId, try to find a matching key for this user and URL
        // The key format is either "userId::url" (old) or "userId::url::profileId" (new)
        const partialKey = `${req.session.userId}::${streamUrl}`;

        // Check for exact match first (legacy format or redirect)
        if (activeStreamProcesses.has(partialKey)) {
            streamKey = partialKey;
        } else {
            // Search for keys starting with the partial key
            for (const key of activeStreamProcesses.keys()) {
                if (key.startsWith(partialKey + '::')) {
                    streamKey = key;
                    break; // Stop at the first match
                }
            }
        }

        // If still not found, default to the partial key so the error message is consistent
        if (!streamKey) {
            streamKey = partialKey;
        }
    }

    const activeStreamInfo = activeStreamProcesses.get(streamKey);

    if (activeStreamInfo) {
        console.log(`[STREAM_STOP_API] Received request to stop stream for user ${req.session.userId}. Key: ${streamKey}`);

        // --- NEW: Smart Termination Logic ---
        // If there are other active references (e.g., another device), DO NOT kill the process.
        if (activeStreamInfo.references > 1) {
            console.log(`[STREAM_STOP_API] Stream ${streamKey} has ${activeStreamInfo.references} active references. NOT terminating process.`);
            // We still return success because from the client's perspective, *their* session is done.
            // The server just keeps the underlying process alive for the other client(s).
            return res.json({ success: true, message: 'Stream kept alive for other active clients.' });
        }
        // --- END NEW ---

        console.log(`[STREAM_STOP_API] No other references. Terminating process for key: ${streamKey}`);
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
        console.log(`[STREAM_STOP_API] Received stop request for user ${req.session.userId}, but no active stream was found for key (or partial match): ${streamKey}`);
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
        function (err) {
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

// --- NEW: App Version Endpoint ---
app.get('/api/version', requireAuth, (req, res) => {
    try {
        const packageJsonPath = path.join(__dirname, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            res.json({ version: packageJson.version || 'Unknown' });
        } else {
            res.json({ version: 'Unknown' });
        }
    } catch (error) {
        console.error('[API] Error reading package.json:', error);
        res.status(500).json({ error: 'Could not determine app version.' });
    }
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
                used: mem.active,
                percent: ((mem.active / mem.total) * 100).toFixed(2)
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
    db.run("DELETE FROM multiview_layouts WHERE id = ? AND user_id = ?", [id, req.session.userId], function (err) {
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
        `, [nowIso, timeoutCutoff], function (err) {
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
            try { process.kill(pid, 'SIGKILL'); } catch (e2) { }
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

    // Prefix ffmpeg command with "-v level+{dvrLoglevel}" here to control log spamming.
    // dvrLogLevel is configured via a settings page pulldown.
    const commandTemplate = `-v level+${settings.dvrLogLevel} ` + recProfile.command
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
        // MODIFIED: Accept exit code 255 as a graceful exit (standard for SIGINT in ffmpeg)
        const wasStoppedIntentionally = ffmpegErrorOutput.includes('Exiting normally, received signal 2') || code === 255;
        const logMessage = (code === 0 || wasStoppedIntentionally) ? 'finished gracefully' : `exited with error code ${code}`;
        console.log(`[DVR] Recording process for job ${job.id} ("${job.programTitle}") ${logMessage}.`);

        // MODIFIED: Explicitly set file permissions to 0o666 (rw-rw-rw-) so the user can manage the file.
        try {
            if (fs.existsSync(fullFilePath)) {
                fs.chmodSync(fullFilePath, 0o666);
                console.log(`[DVR] Set permissions to 0o666 for: ${fullFilePath}`);
            }
        } catch (chmodErr) {
            console.error(`[DVR] Failed to set permissions for ${fullFilePath}:`, chmodErr.message);
        }

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
        if (err) return console.error('[DVR_STORAGE] Could not fetch users for auto-delete check:', err);

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
                    if (err) return console.error(`[DVR_STORAGE] Error fetching old recordings for user ${user.id}:`, err);
                    if (recordingsToDelete.length > 0) {
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
        function (err) {
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
        function (err) {
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
            const jobsWithUser = rows.map(r => ({ ...r, username: req.session.username }));
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
        const recordingsWithFilename = rows.map(r => ({ ...r, filename: path.basename(r.filePath) }));
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

        db.run("DELETE FROM dvr_jobs WHERE user_id = ?", [userId], function (err) {
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

        db.run("DELETE FROM dvr_recordings WHERE user_id = ?", [userId], function (err) {
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

    db.run(query, params, function (err) {
        if (err) return res.status(500).json({ error: 'Could not cancel job.' });
        if (this.changes === 0) return res.status(404).json({ error: 'Job not found or not authorized to cancel.' });
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

    db.run(query, params, function (err) {
        if (err) return res.status(500).json({ error: 'Could not update job status after stop.' });
        if (this.changes === 0) return res.status(404).json({ error: 'Job not found or not authorized to stop.' });
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
        if (err) return res.status(500).json({ error: 'DB error fetching job.' });
        if (!job) return res.status(404).json({ error: 'Job not found or unauthorized.' });
        if (job.status !== 'scheduled') return res.status(400).json({ error: 'Only scheduled jobs can be modified.' });

        db.run("UPDATE dvr_jobs SET startTime = ?, endTime = ? WHERE id = ?", [startTime, endTime, id], function (err) {
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
            db.run("DELETE FROM dvr_jobs WHERE id = ?", [id], function (err) {
                if (err) return res.status(500).json({ error: 'Could not delete job history.' });
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
// --- LOG MANAGEMENT API ENDPOINTS ---

/**
 * GET /api/logs/info
 * Returns statistics about current log files.
 */
app.get('/api/logs/info', requireAuth, requireAdmin, (req, res) => {
    try {
        const logFiles = fs.readdirSync(LOGS_DIR)
            .filter(file => file.startsWith('viniplay-') && file.endsWith('.log'))
            .map(file => {
                const filePath = path.join(LOGS_DIR, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    size: stats.size,
                    mtime: stats.mtime
                };
            })
            .sort((a, b) => b.mtime - a.mtime);

        const totalSize = logFiles.reduce((sum, file) => sum + file.size, 0);
        const oldestFile = logFiles.length > 0 ? logFiles[logFiles.length - 1] : null;

        res.json({
            fileCount: logFiles.length,
            totalSize: totalSize,
            oldestDate: oldestFile ? oldestFile.mtime : null,
            files: logFiles
        });
    } catch (error) {
        console.error('[API] Error getting log info:', error);
        res.status(500).json({ error: 'Failed to get log information.' });
    }
});

/**
 * GET /api/logs/download
 * Downloads all log files combined into a single text file.
 */
app.get('/api/logs/download', requireAuth, requireAdmin, (req, res) => {
    try {
        const logFiles = fs.readdirSync(LOGS_DIR)
            .filter(file => file.startsWith('viniplay-') && file.endsWith('.log'))
            .map(file => ({
                name: file,
                path: path.join(LOGS_DIR, file),
                mtime: fs.statSync(path.join(LOGS_DIR, file)).mtime
            }))
            .sort((a, b) => a.mtime - b.mtime); // Sort by oldest first

        if (logFiles.length === 0) {
            return res.status(404).json({ error: 'No log files found.' });
        }

        // Combine all log files
        let combinedLogs = `ViniPlay Application Logs\n`;
        combinedLogs += `Generated: ${new Date().toISOString()}\n`;
        combinedLogs += `Total Files: ${logFiles.length}\n`;
        combinedLogs += `${'='.repeat(80)}\n\n`;

        logFiles.forEach(file => {
            combinedLogs += `\n${'='.repeat(80)}\n`;
            combinedLogs += `File: ${file.name}\n`;
            combinedLogs += `Modified: ${file.mtime.toISOString()}\n`;
            combinedLogs += `${'='.repeat(80)}\n\n`;

            try {
                const content = fs.readFileSync(file.path, 'utf-8');
                combinedLogs += content;
                combinedLogs += '\n\n';
            } catch (err) {
                combinedLogs += `[ERROR] Could not read file: ${err.message}\n\n`;
            }
        });

        const filename = `viniplay-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(combinedLogs);

        console.log(`[API] User ${req.session.userId} downloaded logs.`);
    } catch (error) {
        console.error('[API] Error downloading logs:', error);
        res.status(500).json({ error: 'Failed to download logs.' });
    }
});

/**
 * POST /api/logs/cleanup
 * Deletes all log files.
 */
app.post('/api/logs/cleanup', requireAuth, requireAdmin, (req, res) => {
    try {
        const logFiles = fs.readdirSync(LOGS_DIR)
            .filter(file => file.startsWith('viniplay-') && file.endsWith('.log'));

        let deletedCount = 0;
        logFiles.forEach(file => {
            try {
                fs.unlinkSync(path.join(LOGS_DIR, file));
                deletedCount++;
            } catch (err) {
                console.error(`[API] Error deleting log file ${file}:`, err);
            }
        });

        // Close current log stream and reset
        if (currentLogStream) {
            currentLogStream.end();
            currentLogStream = null;
        }
        currentLogFilePath = null;
        currentLogSize = 0;

        console.log(`[API] User ${req.session.userId} cleared ${deletedCount} log files.`);
        res.json({ success: true, deletedCount });
    } catch (error) {
        console.error('[API] Error cleaning up logs:', error);
        res.status(500).json({ error: 'Failed to cleanup logs.' });
    }
});

// --- Main Route Handling ---
app.get('*', (req, res) => {
    const filePath = path.join(PUBLIC_DIR, req.path);
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
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
            if (result.success) fs.writeFileSync(SETTINGS_PATH, JSON.stringify(result.updatedSettings, null, 2));
            updateAndScheduleSourceRefreshes();
        }).catch(error => console.error('[INIT] Initial source processing failed:', error.message));

        if (notificationCheckInterval) clearInterval(notificationCheckInterval);
        notificationCheckInterval = setInterval(checkAndSendNotifications, 60000);
        console.log('[Push] Notification checker started.');

        setInterval(cleanupInactiveStreams, 60000);
        console.log('[JANITOR] Inactive stream cleanup process started.');

        schedule.scheduleJob('0 2 * * *', autoDeleteOldRecordings);
        console.log('[DVR_STORAGE] Scheduled daily cleanup of old recordings.');


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
