// downloader.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const caffeine = require('caffeine');

// Create a 'downloads' directory if it doesn't exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Use a Map to track all active downloads
const activeDownloads = new Map();

async function startDownload(url, socket) {
    const downloadId = Date.now().toString(); // Simple unique ID
    let downloadedSize = 0;

    console.log(`[${downloadId}] Starting download...`);

    try {
        // 1. Get file info (size) with a HEAD request
        const headResponse = await axios.head(url);
        const totalSize = parseInt(headResponse.headers['content-length'], 10);
        if (isNaN(totalSize)) {
            throw new Error('Could not determine file size.');
        }

        // Determine filename
        const pathname = new URL(url).pathname;
        const filename = path.basename(pathname) || `download-${downloadId}`;
        const filePath = path.join(downloadsDir, filename);

        // 2. Get the file stream
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream',
        });

        const fileStream = fs.createWriteStream(filePath);
        
        // Add to active downloads map
        activeDownloads.set(downloadId, { url, filePath, totalSize });
        
        // Notify client that download is starting
        socket.emit('download-started', { id: downloadId, filename, totalSize });

        // 3. Listen for data chunks to track progress
        response.data.on('data', (chunk) => {
            downloadedSize += chunk.length;
            const progress = (downloadedSize / totalSize) * 100;
            
            // Emit progress update to the client
            socket.emit('download-progress', {
                id: downloadId,
                progress: progress,
                downloaded: downloadedSize,
                totalSize: totalSize,
            });
        });

        // 4. Pipe the stream to the file
        response.data.pipe(fileStream);

        // 5. Handle download completion
        fileStream.on('finish', () => {
            console.log(`[${downloadId}] Download finished.`);
            socket.emit('download-complete', { id: downloadId, filePath });
            
            // Clean up
            activeDownloads.delete(downloadId);
            if (activeDownloads.size === 0) {
                caffeine.allowSleep();
                console.log('Caffeine: Last download finished. Allowing system sleep.');
            }
        });

        // 6. Handle errors
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
        caffeine.allowSleep();
        console.log('Caffeine: Error in last download. Allowing system sleep.');
    }
}

module.exports = { startDownload, activeDownloads };