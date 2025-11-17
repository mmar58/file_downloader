// downloadManager.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const caffeine = require('caffeine');
const util = require('util');
const stream = require('stream');
const pipeline = util.promisify(stream.pipeline);

// --- Configuration ---
const NUM_CHUNKS = 8; // Number of parallel connections
const downloadsDir = path.join(__dirname, 'downloads');
const DB_PATH = path.join(__dirname, 'downloads.json');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// --- In-memory State ---
const downloadsDb = new Map(); // The persistent state
const activeChunkStreams = new Map(); // Map<downloadId, Map<chunkId, { responseStream, fileStream }>>
let io;

// --- Helper Functions ---
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
                if (download.status === 'downloading') {
                    download.status = 'paused';
                }
                // Recalculate downloaded size from temp files on load
                if (download.chunks && download.tempDir) {
                    let totalDownloaded = 0;
                    download.chunks.forEach(chunk => {
                        const tempFilePath = path.join(download.tempDir, `part_${chunk.id}`);
                        chunk.downloaded = getFilesize(tempFilePath);
                        totalDownloaded += chunk.downloaded;
                        if (chunk.status === 'downloading') chunk.status = 'paused';
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
    // Check if *any* chunk streams are active
    let hasActiveStreams = false;
    for (const chunkMap of activeChunkStreams.values()) {
        if (chunkMap.size > 0) {
            hasActiveStreams = true;
            break;
        }
    }
    
    if (hasActiveStreams) {
        // caffeine.preventSleep();
        console.log('Caffeine: Preventing system sleep.');
    } else {
        // caffeine.allowSleep();
        console.log('Caffeine: Allowing system sleep.');
    }
}

// --- NEW: Core Download Logic (Multi-Part) ---

async function createDownload(url, socket) {
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
        const filePath = path.join(downloadsDir, filename);
        const tempDir = path.join(downloadsDir, `temp_${downloadId}`);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }

        // Calculate chunk ranges
        const chunks = [];
        const chunkSize = Math.ceil(totalSize / NUM_CHUNKS);
        for (let i = 0; i < NUM_CHUNKS; i++) {
            const start = i * chunkSize;
            const end = (i === NUM_CHUNKS - 1) ? totalSize - 1 : (i + 1) * chunkSize - 1;
            chunks.push({
                id: i,
                start,
                end,
                status: 'pending', // 'pending', 'downloading', 'complete', 'error'
                downloaded: 0,
                currentSpeed: 0,
                lastTimestamp: 0,
                lastDownloadedSize: 0,
            });
        }

        const downloadEntry = {
            id: downloadId,
            url,
            filename,
            filePath,
            tempDir,
            totalSize,
            downloadedSize: 0,
            status: 'new',
            currentSpeed: 0,
            error: null,
            chunks,
        };

        downloadsDb.set(downloadId, downloadEntry);
        saveDb();
        
        console.log(`[${downloadId}] New multi-part download created. Starting...`);
        startOrResumeDownload(downloadId, socket);

    } catch (error) {
        console.error('Error creating download:', error.message);
        socket.emit('download-error', { id: url, error: `Failed to start download: ${error.message}` });
    }
}

function startOrResumeDownload(downloadId, socket) {
    const entry = downloadsDb.get(downloadId);
    if (!entry) return;

    entry.status = 'downloading';
    activeChunkStreams.set(downloadId, new Map()); // Init the map for this download
    checkSleep();

    socket.emit('download-started', entry);
    
    // Start all chunks that aren't complete
    entry.chunks.forEach(chunk => {
        if (chunk.status !== 'complete') {
            downloadChunk(downloadId, chunk.id, socket);
        }
    });
}

async function downloadChunk(downloadId, chunkId, socket) {
    const entry = downloadsDb.get(downloadId);
    if (!entry || entry.status !== 'downloading') return;

    const chunk = entry.chunks.find(c => c.id === chunkId);
    if (!chunk) return;

    const tempFilePath = path.join(entry.tempDir, `part_${chunkId}`);
    const chunkDownloadedSize = getFilesize(tempFilePath);
    chunk.downloaded = chunkDownloadedSize;
    chunk.status = 'downloading';
    chunk.lastTimestamp = Date.now();
    chunk.lastDownloadedSize = chunkDownloadedSize;

    const rangeStart = chunk.start + chunkDownloadedSize;
    if (rangeStart >= chunk.end) {
        // This chunk is already done
        chunk.status = 'complete';
        chunk.currentSpeed = 0;
        checkIfComplete(downloadId, socket);
        return;
    }

    try {
        const response = await axios({
            method: 'get',
            url: entry.url,
            responseType: 'stream',
            headers: {
                'Range': `bytes=${rangeStart}-${chunk.end}`
            }
        });

        const fileStream = fs.createWriteStream(tempFilePath, { flags: 'a' });
        
        // Store active streams
        activeChunkStreams.get(downloadId).set(chunkId, { 
            responseStream: response.data, 
            fileStream 
        });

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
            if (entry.status !== 'downloading') return; // Paused
            chunk.status = 'complete';
            chunk.currentSpeed = 0;
            activeChunkStreams.get(downloadId).delete(chunkId);
            saveDb();
            checkIfComplete(downloadId, socket);
        });

        response.data.on('error', (err) => {
            chunk.status = 'error';
            chunk.currentSpeed = 0;
            activeChunkStreams.get(downloadId).delete(chunkId);
            saveDb();
            // We'll let the main error handler on the 'catch' block emit
        });

        response.data.pipe(fileStream);

    } catch (error) {
        console.error(`[${downloadId}] Chunk ${chunkId} error:`, error.message);
        chunk.status = 'error';
        chunk.currentSpeed = 0;
        entry.status = 'error';
        entry.error = `Chunk ${chunkId} failed: ${error.message}`;
        saveDb();
        socket.emit('download-error', { id: entry.id, error: entry.error });
        checkSleep();
    }
}

async function checkIfComplete(downloadId, socket) {
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
            socket.emit('download-complete', { id: entry.id, filePath: entry.filePath });
            
        } catch (err) {
            console.error(`[${downloadId}] Assembly failed:`, err);
            entry.status = 'error';
            entry.error = 'Failed to assemble file.';
            saveDb();
            socket.emit('download-error', { id: entry.id, error: entry.error });
        }
        checkSleep();
    }
}

async function assembleFile(downloadId) {
    const entry = downloadsDb.get(downloadId);
    const finalStream = fs.createWriteStream(entry.filePath);

    for (const chunk of entry.chunks) {
        const tempFilePath = path.join(entry.tempDir, `part_${chunk.id}`);
        const readStream = fs.createReadStream(tempFilePath);
        // We use pipeline to wait for one stream to finish before starting the next
        await pipeline(readStream, finalStream, { end: false });
    }
    finalStream.end();
}

function pauseDownload(downloadId, socket) {
    const entry = downloadsDb.get(downloadId);
    if (!entry) return;

    console.log(`[${downloadId}] Pausing all chunks...`);
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
    socket.emit('download-paused', { id: downloadId });
    checkSleep();
}

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
            
            activeProgress.push({
                id: entry.id,
                progress: (entry.downloadedSize / entry.totalSize) * 100,
                downloaded: entry.downloadedSize,
                totalSize: entry.totalSize,
                speed: entry.currentSpeed
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

// --- Public API ---
module.exports = {
    init: (socketIoInstance) => {
        io = socketIoInstance;
        loadDb();
        
        // Broadcast total speed
        setInterval(() => {
            io.emit('total-speed-update', { totalSpeed: getTotalSpeed() });
        }, 1000);

        // Broadcast individual progress for all active downloads
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
            createDownload(url, socket);
        });
        
        socket.on('pause-download', ({ id }) => {
            pauseDownload(id, socket);
        });
        
        socket.on('resume-download', ({ id }) => {
            startOrResumeDownload(id, socket);
        });
    }
};