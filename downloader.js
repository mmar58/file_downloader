// downloader.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const caffeine = require('caffeine');

const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

const activeDownloads = new Map();

async function startDownload(url, socket) {
    const downloadId = Date.now().toString();
    let downloadedSize = 0;
    
    // --- NEW: Variables for speed calculation ---
    let lastDownloadedSize = 0;
    let lastTimestamp = Date.now();
    // ------------------------------------------

    console.log(`[${downloadId}] Starting download...`);

    try {
        const headResponse = await axios.head(url);
        const totalSize = parseInt(headResponse.headers['content-length'], 10);
        if (isNaN(totalSize)) {
            throw new Error('Could not determine file size.');
        }

        const pathname = new URL(url).pathname;
        const filename = path.basename(pathname) || `download-${downloadId}`;
        const filePath = path.join(downloadsDir, filename);

        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream',
        });

        const fileStream = fs.createWriteStream(filePath);
        
        // --- UPDATED: Add currentSpeed to the map ---
        activeDownloads.set(downloadId, {
            url,
            filePath,
            totalSize,
            currentSpeed: 0 // Initialize speed at 0
        });
        // ---------------------------------------------
        
        socket.emit('download-started', { id: downloadId, filename, totalSize });

        // --- UPDATED: 'data' listener with speed calculation and throttling ---
        response.data.on('data', (chunk) => {
            downloadedSize += chunk.length;
            
            const now = Date.now();
            const deltaTime = (now - lastTimestamp) / 1000; // Time in seconds

            // Only send update every ~500ms to avoid flooding the socket
            if (deltaTime > 0.5) {
                const deltaSize = downloadedSize - lastDownloadedSize;
                const currentSpeed = deltaSize / deltaTime; // Bytes per second

                // Update the map for total speed calculation
                if (activeDownloads.has(downloadId)) {
                    activeDownloads.get(downloadId).currentSpeed = currentSpeed;
                }

                // Emit progress and speed
                socket.emit('download-progress', {
                    id: downloadId,
                    progress: (downloadedSize / totalSize) * 100,
                    downloaded: downloadedSize,
                    totalSize: totalSize,
                    speed: currentSpeed // <-- NEW: Send speed
                });

                // Reset for next calculation
                lastTimestamp = now;
                lastDownloadedSize = downloadedSize;
            }
        });
        // -----------------------------------------------------------------

        response.data.pipe(fileStream);

        fileStream.on('finish', () => {
            console.log(`[${downloadId}] Download finished.`);

            // --- NEW: Send a final 100% update ---
            socket.emit('download-progress', {
                id: downloadId,
                progress: 100,
                downloaded: totalSize,
                totalSize: totalSize,
                speed: 0
            });
            // --------------------------------------

            socket.emit('download-complete', { id: downloadId, filePath });
            
            // Clean up
            activeDownloads.delete(downloadId);
            if (activeDownloads.size === 0) {
                // caffeine.allowSleep();
                console.log('Caffeine: Last download finished. Allowing system sleep.');
            }
        });

        fileStream.on('error', (err) => {
            handleDownloadError(err, downloadId, socket, 'File stream error');
        });
        response.data.on('error', (err) => {
            handleDownloadError(err, downloadId, socket, 'Response stream error');
        });

    } catch (error) {
        handleDownloadError(error, downloadId, socket, 'Download initiation error');
    }
}

function handleDownloadError(error, downloadId, socket, context) {
    console.error(`[${downloadId}] Error: ${context} -`, error.message);
    socket.emit('download-error', { id: downloadId, error: error.message });
    
    // Clean up
    activeDownloads.delete(downloadId);
    if (activeDownloads.size === 0) {
        // caffeine.allowSleep();
        console.log('Caffeine: Error in last download. Allowing system sleep.');
    }
}

module.exports = { startDownload, activeDownloads };