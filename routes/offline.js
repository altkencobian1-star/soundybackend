/**
 * Offline API Routes
 * Handles encrypted downloads, offline library, and offline playback
 */

const express = require('express');
const downloadService = require('../services/downloadService');
const streamService = require('../services/streamService');
const { authMiddleware } = require('../middleware/auth');
const { getDB, runQuery, runRun, getLastInsertId } = require('../db/init');
const path = require('path');
const fs = require('fs');

const router = express.Router();

/**
 * POST /api/offline/download
 * Start downloading a track for offline use
 */
router.post('/download', authMiddleware, async (req, res) => {
  await getDB();
  const { track } = req.body;
  const userId = req.userId;

  if (!track || !track.id) {
    return res.status(400).json({ error: 'Track data required' });
  }

  try {
    // Check if already downloaded
    const existing = downloadService.getDownloadInfo(track.id, userId);
    if (existing) {
      return res.json({ 
        alreadyDownloaded: true, 
        trackId: track.id,
        info: existing
      });
    }

    // First resolve stream to get best source
    console.log(`[OfflineAPI] Resolving stream for: "${track.title}" by ${track.artist}`);
    const stream = await streamService.resolveStream(track);
    
    if (!stream) {
      console.log('[OfflineAPI] No full-track source found');
      return res.status(404).json({ 
        error: 'No downloadable source available',
        fallback: track.preview_url ? {
          type: 'preview',
          url: track.preview_url,
          note: '30-second preview only - full track not found'
        } : null
      });
    }

    console.log(`[OfflineAPI] Stream resolved: ${stream.type} (${stream.quality} quality)`);

    // Handle preview-only sources - download them anyway as fallback
    if (stream.type === 'preview' || stream.isPreview) {
      console.log('[OfflineAPI] Preview-only source found - downloading as fallback');
      
      // Download the preview URL
      if (track.preview_url) {
        const trackWithPreview = {
          ...track,
          stream_url: track.preview_url,
          source_type: 'preview',
          isPreview: true
        };
        
        console.log(`[OfflineAPI] Starting PREVIEW download for user ${userId}: ${track.title}`);
        
        try {
          const result = await downloadService.downloadFromUrl(
            track.preview_url,
            path.join(DOWNLOADS_DIR, 'temp', `${track.id}.temp`),
            (percent) => {
              console.log(`[OfflineAPI] Preview download progress: ${percent}%`);
            }
          );
          
          // Encrypt the preview
          const password = downloadService.getEncryptionPassword(userId);
          const encryptedPath = path.join(DOWNLOADS_DIR, `${track.id}.encrypted`);
          const encryptResult = await downloadService.encryptFile(
            result.path,
            encryptedPath,
            password
          );
          
          // Clean up temp file
          fs.unlink(result.path, () => {});
          
          // Save to database
          let dbTrackId;
          const { results: existingTrack } = runQuery(
            'SELECT id FROM tracks WHERE external_ids LIKE ?',
            [`%${track.id}%`]
          );

          if (existingTrack[0]) {
            dbTrackId = existingTrack[0].id;
          } else {
            runRun(
              `INSERT INTO tracks (title, artist, album, duration, cover_url, 
               source_type, stream_url, external_ids, is_streamable) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                track.title,
                track.artist,
                track.album || '',
                track.duration || 0,
                track.cover_url || '',
                'preview',
                encryptedPath,
                JSON.stringify({ ...track.external_ids, original_id: track.id }),
                1
              ]
            );
            dbTrackId = getLastInsertId();
          }

          // Add to user library
          try {
            runRun(
              `INSERT INTO user_library (user_id, track_id, source_type) 
               VALUES (?, ?, 'downloaded')`,
              [userId, dbTrackId]
            );
          } catch (err) {
            if (!err.message.includes('UNIQUE')) throw err;
          }

          // Store offline track record
          runRun(
            `INSERT INTO user_uploads (user_id, track_id, file_path, file_size, format) 
             VALUES (?, ?, ?, ?, 'mp3')`,
            [userId, dbTrackId, encryptedPath, encryptResult.encryptedSize]
          );

          return res.json({
            success: true,
            trackId: track.id,
            dbTrackId,
            encryptedSize: encryptResult.encryptedSize,
            originalSize: encryptResult.originalSize,
            source: 'preview',
            isPreview: true,
            message: '30-second preview downloaded (full track not available)'
          });
          
        } catch (previewErr) {
          console.error('[OfflineAPI] Preview download failed:', previewErr);
          return res.status(500).json({
            error: 'Failed to download preview',
            details: previewErr.message
          });
        }
      }
      
      return res.status(404).json({ 
        error: 'No preview URL available'
      });
    }

    // Add stream info to track for downloading
    const trackWithStream = {
      ...track,
      stream_url: stream.url,
      source_type: stream.type
    };

    // For YouTube, add the video ID
    if (stream.type === 'youtube' && stream.videoId) {
      console.log(`[OfflineAPI] YouTube video ID: ${stream.videoId}`);
      trackWithStream.external_ids = {
        ...track.external_ids,
        youtube: stream.videoId
      };
    } else if (stream.type === 'youtube' && !stream.videoId) {
      // Extract videoId from URL if not directly provided
      const videoIdMatch = stream.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      if (videoIdMatch) {
        trackWithStream.external_ids = {
          ...track.external_ids,
          youtube: videoIdMatch[1]
        };
      }
    }

    // Start download
    console.log(`[OfflineAPI] Starting download for user ${userId}: ${track.title}`);
    
    const result = await downloadService.downloadTrack(
      trackWithStream, 
      userId,
      (percent, downloaded, total) => {
        // Progress updates could be sent via WebSocket
        console.log(`[OfflineAPI] Download progress: ${percent}%`);
      }
    );

    // Save to database
    let dbTrackId;
    const { results: existingTrack } = runQuery(
      'SELECT id FROM tracks WHERE external_ids LIKE ?',
      [`%${track.id}%`]
    );

    if (existingTrack[0]) {
      dbTrackId = existingTrack[0].id;
    } else {
      // Insert track
      runRun(
        `INSERT INTO tracks (title, artist, album, duration, cover_url, 
         source_type, stream_url, external_ids, is_streamable) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          track.title,
          track.artist,
          track.album || '',
          track.duration || 0,
          track.cover_url || '',
          trackWithStream.source_type,
          result.downloadPath,
          JSON.stringify({ ...track.external_ids, original_id: track.id }),
          1
        ]
      );
      dbTrackId = getLastInsertId();
    }

    // Add to user library as downloaded
    try {
      runRun(
        `INSERT INTO user_library (user_id, track_id, source_type) 
         VALUES (?, ?, 'downloaded')`,
        [userId, dbTrackId]
      );
    } catch (err) {
      if (!err.message.includes('UNIQUE')) throw err;
    }

    // Store offline track record
    runRun(
      `INSERT INTO user_uploads (user_id, track_id, file_path, file_size, format) 
       VALUES (?, ?, ?, ?, 'mp3')`,
      [userId, dbTrackId, result.encryptedPath, result.encryptedSize]
    );

    res.json({
      success: true,
      trackId: track.id,
      dbTrackId,
      encryptedSize: result.encryptedSize,
      originalSize: result.originalSize,
      source: trackWithStream.source_type,
      message: 'Downloaded and encrypted for offline playback'
    });

  } catch (err) {
    console.error('[OfflineAPI] Download error:', err);
    res.status(500).json({ 
      error: 'Download failed', 
      details: err.message 
    });
  }
});

/**
 * GET /api/offline/downloads
 * Get all downloaded tracks for user
 */
router.get('/downloads', authMiddleware, async (req, res) => {
  await getDB();
  const userId = req.userId;

  try {
    const { results } = runQuery(
      `SELECT t.*, ul.added_at as downloaded_at, uu.file_size, uu.file_path
       FROM tracks t
       JOIN user_library ul ON t.id = ul.track_id
       JOIN user_uploads uu ON t.id = uu.track_id AND uu.user_id = ?
       WHERE ul.user_id = ? AND ul.source_type = 'downloaded'
       ORDER BY ul.added_at DESC`,
      [userId, userId]
    );

    const downloads = results.map(t => {
      const isAvailable = fs.existsSync(t.file_path);
      return {
        ...t,
        external_ids: JSON.parse(t.external_ids || '{}'),
        isAvailable,
        sizeFormatted: formatBytes(t.file_size || 0)
      };
    });

    // Storage stats
    const stats = downloadService.getStorageStats();

    res.json({
      downloads,
      count: downloads.length,
      storage: stats
    });
  } catch (err) {
    console.error('[OfflineAPI] Get downloads error:', err);
    res.status(500).json({ error: 'Failed to get downloads' });
  }
});

/**
 * GET /api/offline/stream/:trackId
 * Stream a downloaded track (decrypts on-the-fly)
 */
router.get('/stream/:trackId', authMiddleware, async (req, res) => {
  await getDB();
  const { trackId } = req.params;
  const userId = req.userId;

  try {
    // Get track info
    const { results } = runQuery(
      `SELECT t.*, uu.file_path
       FROM tracks t
       JOIN user_uploads uu ON t.id = uu.track_id
       WHERE t.id = ? AND uu.user_id = ?`,
      [trackId, userId]
    );

    if (!results[0]) {
      return res.status(404).json({ error: 'Track not found in offline library' });
    }

    const track = results[0];
    
    if (!fs.existsSync(track.file_path)) {
      return res.status(404).json({ error: 'Downloaded file not found' });
    }

    // Decrypt to temp file for streaming
    const tempPath = await downloadService.prepareForPlayback(trackId, userId);

    // Stream the decrypted file
    const stat = fs.statSync(tempPath);
    const range = req.headers.range;

    if (range) {
      // Partial content (for seeking)
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'audio/mpeg',
        'X-Offline-Track': track.title
      });

      const stream = fs.createReadStream(tempPath, { start, end });
      stream.pipe(res);

      // Cleanup after streaming (but keep for a while in case of seeks)
      setTimeout(() => {
        downloadService.cleanupPlaybackFile(trackId);
      }, 60000);

    } else {
      // Full file
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': 'audio/mpeg',
        'X-Offline-Track': track.title
      });

      const stream = fs.createReadStream(tempPath);
      stream.pipe(res);

      // Cleanup after streaming
      stream.on('close', () => {
        setTimeout(() => {
          downloadService.cleanupPlaybackFile(trackId);
        }, 5000);
      });
    }

    // Log play
    runRun(
      'INSERT INTO play_history (user_id, track_id, source_used) VALUES (?, ?, ?)',
      [userId, trackId, 'offline']
    );

  } catch (err) {
    console.error('[OfflineAPI] Stream error:', err);
    res.status(500).json({ error: 'Streaming failed', details: err.message });
  }
});

/**
 * DELETE /api/offline/download/:trackId
 * Delete a downloaded track
 */
router.delete('/download/:trackId', authMiddleware, async (req, res) => {
  await getDB();
  const { trackId } = req.params;
  const userId = req.userId;

  try {
    // Get file path
    const { results } = runQuery(
      'SELECT file_path FROM user_uploads WHERE track_id = ? AND user_id = ?',
      [trackId, userId]
    );

    if (results[0]?.file_path) {
      downloadService.deleteDownload(trackId);
    }

    // Remove from user library
    runRun(
      `DELETE FROM user_library WHERE user_id = ? AND track_id = ? AND source_type = 'downloaded'`,
      [userId, trackId]
    );

    // Remove from uploads
    runRun(
      'DELETE FROM user_uploads WHERE track_id = ? AND user_id = ?',
      [trackId, userId]
    );

    res.json({ deleted: true, trackId });
  } catch (err) {
    console.error('[OfflineAPI] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete download' });
  }
});

/**
 * GET /api/offline/status/:trackId
 * Check if a track is available offline
 */
router.get('/status/:trackId', authMiddleware, async (req, res) => {
  await getDB();
  const { trackId } = req.params;
  const userId = req.userId;

  try {
    const { results } = runQuery(
      `SELECT t.*, uu.file_path, uu.file_size
       FROM tracks t
       JOIN user_uploads uu ON t.id = uu.track_id
       WHERE t.id = ? AND uu.user_id = ?`,
      [trackId, userId]
    );

    if (!results[0]) {
      return res.json({ downloaded: false });
    }

    const isAvailable = fs.existsSync(results[0].file_path);

    res.json({
      downloaded: true,
      available: isAvailable,
      size: results[0].file_size,
      sizeFormatted: formatBytes(results[0].file_size || 0)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check status' });
  }
});

/**
 * GET /api/offline/storage
 * Get storage statistics
 */
router.get('/storage', authMiddleware, async (req, res) => {
  const userId = req.userId;

  try {
    const stats = downloadService.getStorageStats();
    
    // Get user's specific downloads count
    await getDB();
    const { results } = runQuery(
      'SELECT COUNT(*) as count FROM user_uploads WHERE user_id = ?',
      [userId]
    );

    res.json({
      ...stats,
      yourDownloads: results[0]?.count || 0
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get storage stats' });
  }
});

/**
 * POST /api/offline/cleanup
 * Clean up temp files and orphaned downloads
 */
router.post('/cleanup', authMiddleware, async (req, res) => {
  const userId = req.userId;

  try {
    // Clean up all temp playback files for this user
    const tempDir = path.join(process.env.USERPROFILE || process.env.HOME, 'SoundyDownloads', 'temp');
    
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      let cleaned = 0;
      
      files.forEach(f => {
        if (f.endsWith('_playback.mp3')) {
          try {
            fs.unlinkSync(path.join(tempDir, f));
            cleaned++;
          } catch {}
        }
      });

      res.json({ cleaned, message: `${cleaned} temp files removed` });
    } else {
      res.json({ cleaned: 0 });
    }
  } catch (err) {
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

// Helper function
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = router;
