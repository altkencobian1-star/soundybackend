const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const authRoutes = require('./routes/auth');
const songRoutes = require('./routes/songs');
const playlistRoutes = require('./routes/playlists');
const musicRoutes = require('./routes/music');
const offlineRoutes = require('./routes/offline');
const downloadRoutes = require('./routes/download');
const { initDB } = require('./db/init');

const app = express();
const PORT = process.env.PORT || 5000;

// Keep process alive - prevent crashes from killing server
process.on('uncaughtException', (err) => {
  console.error('[SERVER] Uncaught Exception:', err.message);
  // Don't exit - keep server running
});
process.on('unhandledRejection', (reason) => {
  console.error('[SERVER] Unhandled Rejection:', reason);
  // Don't exit - keep server running
});

// Ensure directories exist
const dirs = ['audio-storage', 'database'];
dirs.forEach(dir => {
  const dirPath = path.join(__dirname, '..', dir);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
});

// Middleware
app.use(cors({ 
  origin: true, 
  credentials: true 
}));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

// Serve audio files statically
app.use('/audio', express.static(path.join(__dirname, '..', 'audio-storage')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/songs', songRoutes);
app.use('/api/playlists', playlistRoutes);
app.use('/api/music', musicRoutes);
app.use('/api/offline', offlineRoutes);
app.use('/api/download', downloadRoutes);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Global error handler - catches all route errors, returns JSON
app.use((err, req, res, next) => {
  console.error('[SERVER] Route error:', err.message);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

// Initialize DB and start
initDB().then(() => {
  console.log('✅ Database initialized');
  app.listen(PORT, () => {
    console.log(`🎵 Soundy backend running on port ${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
  });
}).catch(err => {
  console.error('❌ Database init failed:', err.message);
  // Still start server so health check works
  app.listen(PORT, () => {
    console.log(`🎵 Soundy backend running on port ${PORT} (DB ERROR - try deleting database/soundy.db)`);
  });
});
