// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { startDownload, activeDownloads } = require('./downloader'); // Import activeDownloads
const caffeine = require('caffeine');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the public directory
app.use(express.static(path.join(__dirname, 'public')));

// --- NEW: Total Speed Calculation ---
// Set an interval to calculate and broadcast total speed every 1 second
setInterval(() => {
    let totalSpeed = 0;
    
    // Iterate over all active downloads and sum their speeds
    for (const download of activeDownloads.values()) {
        totalSpeed += download.currentSpeed || 0;
    }

    // Broadcast the total speed to all connected clients
    io.emit('total-speed-update', { totalSpeed });
}, 1000);
// -----------------------------------

// Handle Socket.io connections
io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Listen for a new download request
    socket.on('start-download', async ({ url }) => {
        console.log(`Received download request for: ${url}`);
        
        if (activeDownloads.size === 0) {
            // caffeine.preventSleep();
            console.log('Caffeine: Preventing system sleep.');
        }

        try {
            await startDownload(url, socket);
        } catch (error) {
            console.error(`Error initiating download for ${url}:`, error.message);
            socket.emit('download-error', { id: url, error: error.message });
            
            if (activeDownloads.size === 0) {
                // caffeine.allowSleep();
                console.log('Caffeine: Allowing system sleep.');
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});