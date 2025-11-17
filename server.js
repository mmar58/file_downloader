// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const downloadManager = require('./downloadManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Initialize the download manager
downloadManager.init(io);

// Handle Socket.io connections
io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);
    
    // Let the manager handle this new connection
    downloadManager.handleNewConnection(socket);

    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});