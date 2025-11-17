# Node.js Multi-Part Downloader

A powerful, IDM-like download manager built with Node.js, Express, and [Socket.io](http://Socket.io). It features multi-part (segmented) downloading for high speeds, persistent resumable downloads, and a real-time web UI to manage your download queue.


## 🚀 Key Features

* **⚡ Multi-Part Downloading**: Splits files into 8 chunks for simultaneous download, dramatically increasing speed.
* **💾 Persistent Resumable Downloads**: Stop the server and restart it—your downloads will be waiting in the same state (paused, queued, etc.).
* **🚦 Download Queue**: Set how many files to download at once (e.g., 3). New downloads are automatically queued and will start when a slot is free.
* **💻 Real-Time Web UI**: A clean web interface built with [Socket.io](http://Socket.io) to add, pause, resume, and monitor all downloads.
* **🔧 Configurable Queue**: Change the number of concurrent downloads directly from the UI.
* **🌍 Global Controls**: "Pause All" and "Resume All" buttons for easy management.
* **📊 Detailed Progress**: See individual download speed, total speed, and estimated time remaining (ETA).
* **📁 Configurable Folders**: Use a `.env` file to set your final `DOWNLOAD_FOLDER` and a separate `TEMP_FOLDER` for parts.

## 🛠️ Technology Stack

* **Backend**: Node.js, Express
* **Real-time**: [Socket.io](http://Socket.io)
* **Downloading**: `axios`
* **Configuration**: `dotenv`
* **Frontend**: Vanilla HTML, CSS, JavaScript

## ⚙️ Installation & Setup


1. **Clone/Download:**
   Download the project files (`server.js`, `downloadManager.js`, `public/index.html`, `package.json`).
2. **Install Dependencies:**
   Open a terminal in the project directory and run:

   ```bash
   npm install
   ```

   This will install `express`, `socket.io`, `axios`, and `dotenv`.
3. **Configure Environment:**
   Create a file named `.env` in the root of the project. See the **Configuration** section below for details.
4. **Run the Server:**

   ```bash
   node server.js
   ```

   The server will start, by default, on `http://localhost:3000`.

## 🔩 Configuration

Create a `.env` file in the root directory to specify your download and temporary folders.

```ini
# .env

# The folder where your final, completed files will be saved.
DOWNLOAD_FOLDER=C:\MyDownloads

# The folder to store temporary download parts (chunks).
# If omitted, it defaults to your OS's temp directory (e.g., C:\Users\...\AppData\Local\Temp).
TEMP_FOLDER=C:\MyDownloads\Temp
```

* The `downloads.json` (persistence file) will be stored in your `DOWNLOAD_FOLDER`.

## 💡 How to Use


1. Make sure the server is running (`node server.js`).
2. Open your web browser and go to `http://localhost:3000`.
3. Paste a download URL into the field and click **Download**.
   * **Note:** The URL must be from a server that supports `Accept-Ranges: bytes` for multi-part downloading to work. Most modern file hosts do.
4. Manage your downloads from the UI! You can change the concurrent download limit, pause all, or resume all.

## 🏗️ File Architecture

* `server.js`: The main Express server. It sets up [Socket.io](http://Socket.io) and hands off all connection logic to the `downloadManager`.
* `downloadManager.js`: The "brain" of the project. It manages the download queue, state persistence (`downloads.json`), and all multi-part chunk logic.
* `public/index.html`: The client-side web UI that communicates with the server via [Socket.io](http://Socket.io).
* `.env`: Your (self-created) configuration file for paths.
* `downloads.json`: (Auto-generated) The database file that stores the state of all downloads, allowing for persistence.

## 📜 License

Distributed under the MIT License. See `LICENSE` for more information.