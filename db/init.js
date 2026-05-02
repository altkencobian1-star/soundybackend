const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', '..', 'database');
const DB_PATH = path.join(DB_DIR, 'soundy.db');

let db;
let saveTimeout;

async function getDB() {
  if (!db) {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    const SQL = await initSqlJs();
    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }
  }
  return db;
}

function saveDB() {
  if (!db) return;
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    } catch (err) {
      console.error('Failed to save DB:', err);
    }
  }, 300);
}

function runQuery(sql, params = []) {
  if (!db) {
    console.error('[DB] Database not initialized');
    throw new Error('DB not initialized');
  }
  try {
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    saveDB();
    return { results, changes: db.getRowsModified() };
  } catch (err) {
    console.error('[DB] Query error:', err.message);
    throw err;
  }
}

function runRun(sql, params = []) {
  if (!db) {
    console.error('[DB] Database not initialized');
    throw new Error('DB not initialized');
  }
  try {
    db.run(sql, params);
    saveDB();
    return { changes: db.getRowsModified() };
  } catch (err) {
    console.error('[DB] Run error:', err.message);
    throw err;
  }
}

function getLastInsertId() {
  const res = runQuery('SELECT last_insert_rowid() as id');
  return res.results[0]?.id;
}

async function initDB() {
  try {
    const database = await getDB();

  const createTables = `
    -- Users table (existing)
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Master track catalog (from aggregated sources)
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT DEFAULT '',
      duration INTEGER DEFAULT 0,
      cover_url TEXT DEFAULT '',
      spotify_id TEXT,
      youtube_id TEXT,
      jamendo_id TEXT,
      source_type TEXT DEFAULT 'unknown', -- 'youtube' | 'jamendo' | 'upload' | 'preview' | 'spotify' | 'itunes'
      stream_url TEXT, -- resolved playable URL
      stream_type TEXT, -- 'embed' | 'direct' | 'preview'
      preview_url TEXT, -- 30-sec preview if available
      file_path TEXT, -- for user uploads
      external_ids TEXT, -- JSON: {spotify: '...', youtube: '...', isrc: '...'}
      metadata TEXT, -- JSON: flexible metadata storage
      popularity INTEGER DEFAULT 0, -- 0-100 ranking
      is_streamable BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- User's library (saved tracks)
    CREATE TABLE IF NOT EXISTS user_library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      source_type TEXT DEFAULT 'library', -- 'library' | 'favorite' | 'downloaded' | 'uploaded'
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
      UNIQUE(user_id, track_id)
    );

    -- User's favorites (liked tracks)
    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
      UNIQUE(user_id, track_id)
    );

    -- Playlists
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      cover_url TEXT DEFAULT '',
      is_public BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Playlist tracks
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      position INTEGER DEFAULT 0,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
      UNIQUE(playlist_id, track_id)
    );

    -- Play history
    CREATE TABLE IF NOT EXISTS play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed BOOLEAN DEFAULT 0,
      progress_seconds INTEGER DEFAULT 0,
      source_used TEXT, -- which source was actually played
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    -- User uploads (local files) - extends tracks
    CREATE TABLE IF NOT EXISTS user_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      format TEXT DEFAULT 'mp3', -- 'mp3' | 'flac' | 'wav' | 'm4a'
      bitrate INTEGER,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    -- Legacy table for backwards compatibility (to be migrated)
    CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT DEFAULT '',
      duration INTEGER DEFAULT 0,
      file_path TEXT NOT NULL,
      cover_url TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Legacy downloads table
    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      song_id INTEGER NOT NULL,
      downloaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
      UNIQUE(user_id, song_id)
    );

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_spotify_id ON tracks(spotify_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_youtube_id ON tracks(youtube_id);
    CREATE INDEX IF NOT EXISTS idx_user_library_user ON user_library(user_id);
    CREATE INDEX IF NOT EXISTS idx_play_history_user ON play_history(user_id);
    CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at);
  `;

  db.run(createTables);
  saveDB();
  console.log('✅ Database initialized with new schema');
  return db;
  } catch (err) {
    console.error('❌ Database init error:', err.message);
    throw err;
  }
}

module.exports = { getDB, initDB, runQuery, runRun, getLastInsertId, saveDB };
