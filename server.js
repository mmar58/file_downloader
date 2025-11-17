// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { startDownload, activeDownloads } = require('./downloader');
const caffeine = require('caffeine');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Handle Socket.io connections
io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Listen for a new download request
    socket.on('start-download', async ({ url }) => {
        console.log(`Received download request for: ${url}`);
        
        // Prevent sleep if this is the first download
        if (activeDownloads.size === 0) {
            // caffeine.preventSleep();
            console.log('Caffeine: Preventing system sleep.');
        }

        try {
            // Start the download and pass the socket to send progress updates
            await startDownload(url, socket);

        } catch (error) {
            console.error(`Error initiating download for ${url}:`, error.message);
            socket.emit('download-error', { id: url, error: error.message });
            
            // Allow sleep if no downloads are left
            if (activeDownloads.size === 0) {
                caffeine.allowSleep();
                console.log('Caffeine: Allowing system sleep.');
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
        // Note: Ongoing downloads will continue, but this socket won't get updates.
        // A more robust solution might map socket.id to downloads to cancel them.
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});