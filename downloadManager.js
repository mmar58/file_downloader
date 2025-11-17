// downloadManager.js
require('dotenv').config(); // Load .env variables
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const util = require('util');
const stream = require('stream');
const pipeline = util.promisify(stream.pipeline);
const os = require('os'); // <-- NEW: To get system temp folder

// --- Configuration ---
const NUM_CHUNKS = 8; 
const MAX_CONCURRENT_DOWNLOADS = 3; 

// --- UPDATED: .env integration ---
const DOWNLOAD_FOLDER = process.env.DOWNLOAD_FOLDER || path.join(__dirname, 'downloads');
// --- NEW: Use TEMP_FOLDER or OS default temp dir ---
const TEMP_FOLDER = process.env.TEMP_FOLDER || path.join(os.tmpdir(), 'node-downloader-temp');
// --- DB lives in the main download folder ---
const DB_PATH = path.join(DOWNLOAD_FOLDER, 'downloads.json');

// Ensure both folders exist
if (!fs.existsSync(DOWNLOAD_FOLDER)) {
    fs.mkdirSync(DOWNLOAD_FOLDER, { recursive: true });
}
if (!fs.existsSync(TEMP_FOLDER)) {
    fs.mkdirSync(TEMP_FOLDER, { recursive: true }); // <-- NEW
}
// ---------------------------------

// --- In-memory State ---
const downloadsDb = new Map(); 
const activeChunkStreams = new Map(); 
let io;

// --- Helper Functions (No changes) ---
function getFilesize(filePath) {
    if (fs.existsSync(filePath)) {
        return fs.statSync(filePath).size;
    }
    return 0;
}

function loadDb() {
    if (fs.existsSync(DB_PATH)) {
        try {
            const data = fs.readFileSync(DB_PATH);
            const entries = JSON.parse(data);
            entries.forEach(([id, download]) => {
                if (download.status === 'downloading' || download.status === 'queued') {
                    download.status = 'queued';
                }
                if (download.chunks && download.tempDir) {
                    let totalDownloaded = 0;
                    download.chunks.forEach(chunk => {
                        // Check if tempDir exists. If not, paths are stale.
                        if (!fs.existsSync(download.tempDir)) {
                            // Mark as paused/error? For now, just reset downloaded.
                            chunk.downloaded = 0;
                        } else {
                            const tempFilePath = path.join(download.tempDir, `part_${chunk.id}`);
                            chunk.downloaded = getFilesize(tempFilePath);
                        }
                        totalDownloaded += chunk.downloaded;
                        if (chunk.status === 'downloading') chunk.status = 'queued';
                    });
                    download.downloadedSize = totalDownloaded;
                }
                downloadsDb.set(id, download);
            });
            console.log(`Loaded ${downloadsDb.size} downloads from database.`);
        } catch (err) {
            console.error('Error loading database:', err);
        }
    }
}

function saveDb() {
    const entries = Array.from(downloadsDb.entries());
    fs.writeFileSync(DB_PATH, JSON.stringify(entries, null, 2));
}

function checkSleep() {
    let hasActiveStreams = false;
    for (const chunkMap of activeChunkStreams.values()) {
        if (chunkMap.size > 0) {
            hasActiveStreams = true;
            break;
        }
    }
    // (Sleep code commented out)
}

// --- Queue Manager (No changes) ---
function tryToStartQueuedDownloads() {
    if (!io) return; 
    const activeDownloads = Array.from(downloadsDb.values()).filter(d => d.status === 'downloading').length;
    let slotsAvailable = MAX_CONCURRENT_DOWNLOADS - activeDownloads;
    if (slotsAvailable <= 0) return;
    for (const entry of downloadsDb.values()) {
        if (entry.status === 'queued') {
            entry.status = 'downloading';
            activeChunkStreams.set(entry.id, new Map());
            checkSleep();
            io.emit('download-started', entry); 
            entry.chunks.forEach(chunk => {
                if (chunk.status !== 'complete') {
                    downloadChunk(entry.id, chunk.id); 
                }
            });
            slotsAvailable--;
            if (slotsAvailable <= 0) break;
        }
    }
    saveDb(); 
}


// --- Core Download Logic (Multi-Part) ---

async function createDownload(url) {
    try {
        const downloadId = Date.now().toString();
        
        console.log(`[${downloadId}] Fetching metadata for ${url}`);
        const headResponse = await axios.head(url);
        const totalSize = parseInt(headResponse.headers['content-length'], 10);
        
        if (headResponse.headers['accept-ranges'] !== 'bytes') {
            throw new Error('Server does not support resumable (multi-part) downloads.');
        }

        const pathname = new URL(url).pathname;
        const filename = path.basename(pathname) || `download-${downloadId}`;
        
        // --- UPDATED: Use both folders ---
        const filePath = path.join(DOWNLOAD_FOLDER, filename);
        const tempDir = path.join(TEMP_FOLDER, `temp_${downloadId}`);
        // ---------------------------------
        
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }

        // Calculate chunk ranges (No change)
        const chunks = [];
        const chunkSize = Math.ceil(totalSize / NUM_CHUNKS);
        for (let i = 0; i < NUM_CHUNKS; i++) {
            const start = i * chunkSize;
            const end = (i === NUM_CHUNKS - 1) ? totalSize - 1 : (i + 1) * chunkSize - 1;
            chunks.push({
                id: i, start, end, status: 'pending', downloaded: 0,
                currentSpeed: 0, lastTimestamp: 0, lastDownloadedSize: 0,
            });
        }

        const downloadEntry = {
            id: downloadId,
            url,
            filename,
            filePath, // <-- Final file path
            tempDir,  // <-- Temp chunks path
            totalSize,
            downloadedSize: 0,
            status: 'queued',
            currentSpeed: 0,
            eta: null,
            error: null,
            chunks,
        };

        downloadsDb.set(downloadId, downloadEntry);
        saveDb();
        
        console.log(`[${downloadId}] New multi-part download created. Queuing...`);
        io.emit('download-list', Array.from(downloadsDb.values())); 
        tryToStartQueuedDownloads();

    } catch (error) {
        console.error('Error creating download:', error.message);
        io.emit('download-error', { id: url, error: `Failed to start download: ${error.message}` }); 
    }
}

// --- (Functions from startOrResumeDownload to pauseDownload) ---
// --- (NO CHANGES NEEDED in these functions) ---
// All these functions work by reading the `entry.filePath` and `entry.tempDir`
// which are now set correctly in `createDownload`.
// ...
function startOrResumeDownload(downloadId) {
    const entry = downloadsDb.get(downloadId);
    if (!entry) return;
    entry.status = 'queued';
    entry.error = null;
    saveDb();
    io.emit('download-list', Array.from(downloadsDb.values()));
    tryToStartQueuedDownloads();
}

async function downloadChunk(downloadId, chunkId) {
    const entry = downloadsDb.get(downloadId);
    if (!entry || entry.status !== 'downloading') return;
    const chunk = entry.chunks.find(c => c.id === chunkId);
    if (!chunk) return;
    const tempFilePath = path.join(entry.tempDir, `part_${chunkId}`); // This path is correct
    const chunkDownloadedSize = getFilesize(tempFilePath);
    chunk.downloaded = chunkDownloadedSize;
    chunk.status = 'downloading';
    chunk.lastTimestamp = Date.now();
    chunk.lastDownloadedSize = chunkDownloadedSize;
    const rangeStart = chunk.start + chunkDownloadedSize;
    if (rangeStart >= chunk.end) {
        chunk.status = 'complete';
        chunk.currentSpeed = 0;
        checkIfComplete(downloadId);
        return;
    }
    try {
        const response = await axios({
            method: 'get',
            url: entry.url,
            responseType: 'stream',
            headers: { 'Range': `bytes=${rangeStart}-${chunk.end}` }
        });
        const fileStream = fs.createWriteStream(tempFilePath, { flags: 'a' });
        activeChunkStreams.get(downloadId).set(chunkId, { responseStream: response.data, fileStream });
        response.data.on('data', (data) => {
            chunk.downloaded += data.length;
            const now = Date.now();
            const deltaTime = (now - chunk.lastTimestamp) / 1000;
            if (deltaTime > 0.5) {
                const deltaSize = chunk.downloaded - chunk.lastDownloadedSize;
                chunk.currentSpeed = deltaSize / deltaTime;
                chunk.lastTimestamp = now;
                chunk.lastDownloadedSize = chunk.downloaded;
            }
        });
        response.data.on('end', () => {
            if (entry.status !== 'downloading') return;
            chunk.status = 'complete';
            chunk.currentSpeed = 0;
            activeChunkStreams.get(downloadId).delete(chunkId);
            saveDb();
            checkIfComplete(downloadId);
        });
        response.data.on('error', (err) => {
            chunk.status = 'error';
            chunk.currentSpeed = 0;
            activeChunkStreams.get(downloadId).delete(chunkId);
            saveDb();
        });
        response.data.pipe(fileStream);
    } catch (error) {
        console.error(`[${downloadId}] Chunk ${chunkId} error:`, error.message);
        chunk.status = 'error';
        chunk.currentSpeed = 0;
        entry.status = 'error';
        entry.error = `Chunk ${chunkId} failed: ${error.message}`;
        saveDb();
        io.emit('download-error', { id: entry.id, error: entry.error });
        checkSleep();
        tryToStartQueuedDownloads();
    }
}

async function checkIfComplete(downloadId) {
    const entry = downloadsDb.get(downloadId);
    if (!entry) return;
    const allComplete = entry.chunks.every(c => c.status === 'complete');
    if (allComplete) {
        console.log(`[${downloadId}] All chunks downloaded. Assembling file...`);
        entry.status = 'assembling';
        try {
            await assembleFile(downloadId);
            console.log(`[${downloadId}] Assembly complete. Cleaning up...`);
            fs.rmSync(entry.tempDir, { recursive: true, force: true });
            entry.tempDir = null;
            entry.status = 'complete';
            entry.currentSpeed = 0;
            saveDb();
            io.emit('download-complete', { id: entry.id, filePath: entry.filePath });
        } catch (err) {
            console.error(`[${downloadId}] Assembly failed:`, err);
            entry.status = 'error';
            entry.error = 'Failed to assemble file.';
            saveDb();
            io.emit('download-error', { id: entry.id, error: entry.error });
        }
        checkSleep();
        tryToStartQueuedDownloads();
    }
}

async function assembleFile(downloadId) {
    const entry = downloadsDb.get(downloadId);
    const finalStream = fs.createWriteStream(entry.filePath); // Writes to DOWNLOAD_FOLDER
    for (const chunk of entry.chunks) {
        const tempFilePath = path.join(entry.tempDir, `part_${chunk.id}`); // Reads from TEMP_FOLDER
        const readStream = fs.createReadStream(tempFilePath);
        await pipeline(readStream, finalStream, { end: false });
    }
    finalStream.end();
}

function pauseDownload(downloadId) {
    const entry = downloadsDb.get(downloadId);
    if (!entry) return;
    if (entry.status !== 'downloading' && entry.status !== 'queued') return;
    console.log(`[${downloadId}] Pausing...`);
    entry.status = 'paused';
    const chunkStreams = activeChunkStreams.get(downloadId);
    if (chunkStreams) {
        for (const [chunkId, streams] of chunkStreams.entries()) {
            streams.responseStream.destroy();
            streams.fileStream.close();
        }
        activeChunkStreams.delete(downloadId);
    }
    entry.chunks.forEach(c => {
        if (c.status === 'downloading') c.status = 'paused';
        c.currentSpeed = 0;
    });
    saveDb();
    io.emit('download-list', Array.from(downloadsDb.values()));
    checkSleep();
    tryToStartQueuedDownloads();
}
// --- (End of unchanged functions) ---


// --- Aggregation & Public API (No changes) ---
function getAggregatedProgress() {
    const activeProgress = [];
    for (const entry of downloadsDb.values()) {
        if (entry.status === 'downloading') {
            let totalDownloaded = 0;
            let totalSpeed = 0;
            entry.chunks.forEach(c => {
                totalDownloaded += c.downloaded;
                totalSpeed += c.currentSpeed || 0;
            });
            entry.downloadedSize = totalDownloaded;
            entry.currentSpeed = totalSpeed;
            
            const remainingBytes = entry.totalSize - entry.downloadedSize;
            const eta = (entry.currentSpeed > 0) ? remainingBytes / entry.currentSpeed : null;
            entry.eta = eta;
            
            activeProgress.push({
                id: entry.id,
                progress: (entry.downloadedSize / entry.totalSize) * 100,
                downloaded: entry.downloadedSize,
                totalSize: entry.totalSize,
                speed: entry.currentSpeed,
                eta: entry.eta,
                filename: entry.filename,
                status: entry.status,
                error: entry.error
            });
        }
    }
    return activeProgress;
}

function getTotalSpeed() {
    let totalSpeed = 0;
    for (const entry of downloadsDb.values()) {
        if (entry.status === 'downloading') {
            totalSpeed += entry.currentSpeed || 0;
        }
    }
    return totalSpeed;
}

module.exports = {
    init: (socketIoInstance) => {
        io = socketIoInstance;
        loadDb();
        tryToStartQueuedDownloads(); 
        
        setInterval(() => {
            io.emit('total-speed-update', { totalSpeed: getTotalSpeed() });
        }, 1000);

        setInterval(() => {
            const activeProgress = getAggregatedProgress();
            activeProgress.forEach(progress => {
                io.emit('download-progress', progress);
            });
        }, 1000);
    },

    getDownloadList: () => {
        return Array.from(downloadsDb.values());
    },

    handleNewConnection: (socket) => {
        socket.emit('download-list', Array.from(downloadsDb.values()));

        socket.on('start-download', ({ url }) => {
            createDownload(url);
        });
        
        socket.on('pause-download', ({ id }) => {
            pauseDownload(id);
        });
        
        socket.on('resume-download', ({ id }) => {
            startOrResumeDownload(id);
        });

        socket.on('pause-all-downloads', () => {
            for (const entry of downloadsDb.values()) {
                if (entry.status === 'downloading' || entry.status === 'queued') {
                    pauseDownload(entry.id);
                }
            }
        });

        socket.on('resume-all-downloads', () => {
            for (const entry of downloadsDb.values()) {
                if (entry.status === 'paused') {
                    entry.status = 'queued';
                    entry.error = null;
                }
            }
            saveDb();
            io.emit('download-list', Array.from(downloadsDb.values()));
            tryToStartQueuedDownloads();
        });
    }
};