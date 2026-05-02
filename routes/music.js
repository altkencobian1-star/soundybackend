/**
 * Music API Routes
 * Full-featured music streaming endpoints using Search and Stream services
 */

const express = require('express');
const searchService = require('../services/searchService');
const streamService = require('../services/streamService');
const { authMiddleware } = require('../middleware/auth');
const { getDB, runQuery, runRun, getLastInsertId } = require('../db/init');

const router = express.Router();

/**
 * POST /api/music/search
 * Search across all sources (Spotify, iTunes, Jamendo)
 */
router.post('/search', async (req, res) => {
  const { query, sources = ['spotify', 'itunes', 'jamendo'], limit = 20 } = req.body;
  
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }

  try {
    const results = await searchService.search(query, { sources, limit });
    res.json({ 
      query, 
      results,
      count: results.length,
      sources
    });
  } catch (err) {
    console.error('[MusicAPI] Search error:', err);
    res.status(500).json({ error: 'Search failed', details: err.message });
  }
});

/**
 * GET /api/music/search/:query
 * Quick search endpoint (GET method for simple queries)
 */
router.get('/search/:query', async (req, res) => {
  const { query } = req.params;
  const sources = req.query.sources ? req.query.sources.split(',') : ['spotify', 'itunes', 'jamendo'];
  const limit = parseInt(req.query.limit) || 20;

  try {
    const results = await searchService.search(query, { sources, limit });
    res.json({ query, results, count: results.length });
  } catch (err) {
    console.error('[MusicAPI] Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * POST /api/music/resolve
 * Resolve a track to a playable stream source
 */
router.post('/resolve', async (req, res) => {
  const { track } = req.body;
  
  if (!track) {
    return res.status(400).json({ error: 'Track data required' });
  }

  try {
    const stream = await streamService.resolveStream(track);
    
    if (!stream) {
      return res.status(404).json({ 
        error: 'No playable source found',
        fallback: track.preview_url ? {
          type: 'preview',
          url: track.preview_url,
          duration: 30
        } : null
      });
    }

    res.json({
      track: {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        cover_url: track.cover_url
      },
      stream: {
        type: stream.type,
        url: stream.url,
        embed_url: stream.embedUrl,
        duration: stream.duration,
        quality: stream.quality,
        is_preview: stream.isPreview || false
      },
      sources_checked: ['jamendo', 'youtube', 'user_upload', 'preview']
    });
  } catch (err) {
    console.error('[MusicAPI] Resolve error:', err);
    res.status(500).json({ error: 'Stream resolution failed', details: err.message });
  }
});

/**
 * GET /api/music/resolve/:trackId
 * Resolve by track ID
 */
router.get('/resolve/:trackId', async (req, res) => {
  const { trackId } = req.params;
  
  try {
    // Get track details from search service
    const track = await searchService.getTrackDetails(trackId);
    
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const stream = await streamService.resolveStream(track);
    
    res.json({
      track,
      stream: stream || null,
      available: !!stream
    });
  } catch (err) {
    console.error('[MusicAPI] Resolve error:', err);
    res.status(500).json({ error: 'Resolution failed' });
  }
});

/**
 * POST /api/music/save
 * Save track to user's library
 */
router.post('/save', authMiddleware, async (req, res) => {
  await getDB();
  const { track } = req.body;
  const userId = req.userId;

  if (!track) {
    return res.status(400).json({ error: 'Track data required' });
  }

  try {
    // Check if track exists in catalog
    let trackId;
    const { results: existingTracks } = runQuery(
      'SELECT * FROM tracks WHERE external_ids LIKE ?',
      [`%${track.id}%`]
    );

    if (existingTracks[0]) {
      trackId = existingTracks[0].id;
    } else {
      // Insert new track into catalog
      runRun(
        `INSERT INTO tracks (title, artist, album, duration, cover_url, 
         spotify_id, youtube_id, jamendo_id, source_type, stream_url, 
         preview_url, external_ids, is_streamable, metadata, popularity) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          track.title,
          track.artist,
          track.album || '',
          track.duration || 0,
          track.cover_url || '',
          track.external_ids?.spotify || null,
          track.external_ids?.youtube || null,
          track.external_ids?.jamendo || null,
          track.source_type || 'unknown',
          track.stream_url || null,
          track.preview_url || null,
          JSON.stringify(track.external_ids || {}),
          track.streamable ? 1 : 0,
          JSON.stringify(track.metadata || {}),
          track.popularity || 0
        ]
      );
      trackId = getLastInsertId();
    }

    // Add to user's library
    try {
      runRun(
        'INSERT INTO user_library (user_id, track_id, source_type) VALUES (?, ?, ?)',
        [userId, trackId, 'library']
      );
    } catch (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.json({ saved: true, track_id: trackId, already_saved: true });
      }
      throw err;
    }

    res.json({ saved: true, track_id: trackId });
  } catch (err) {
    console.error('[MusicAPI] Save error:', err);
    res.status(500).json({ error: 'Failed to save track' });
  }
});

/**
 * GET /api/music/library
 * Get user's library
 */
router.get('/library', authMiddleware, async (req, res) => {
  await getDB();
  const userId = req.userId;

  try {
    const { results } = runQuery(
      `SELECT t.*, ul.added_at, ul.source_type as library_type
       FROM tracks t
       JOIN user_library ul ON t.id = ul.track_id
       WHERE ul.user_id = ?
       ORDER BY ul.added_at DESC`,
      [userId]
    );

    const tracks = results.map(t => ({
      ...t,
      external_ids: JSON.parse(t.external_ids || '{}'),
      metadata: JSON.parse(t.metadata || '{}'),
      is_streamable: !!t.is_streamable
    }));

    res.json({ tracks, count: tracks.length });
  } catch (err) {
    console.error('[MusicAPI] Library error:', err);
    res.status(500).json({ error: 'Failed to fetch library' });
  }
});

/**
 * GET /api/music/favorites
 * Get user's favorites
 */
router.get('/favorites', authMiddleware, async (req, res) => {
  await getDB();
  const userId = req.userId;

  try {
    const { results } = runQuery(
      `SELECT t.*, f.created_at as favorited_at
       FROM tracks t
       JOIN favorites f ON t.id = f.track_id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC`,
      [userId]
    );

    const tracks = results.map(t => ({
      ...t,
      external_ids: JSON.parse(t.external_ids || '{}'),
      metadata: JSON.parse(t.metadata || '{}')
    }));

    res.json({ tracks, count: tracks.length });
  } catch (err) {
    console.error('[MusicAPI] Favorites error:', err);
    res.status(500).json({ error: 'Failed to fetch favorites' });
  }
});

/**
 * POST /api/music/favorite
 * Toggle favorite status
 */
router.post('/favorite', authMiddleware, async (req, res) => {
  await getDB();
  const { track_id } = req.body;
  const userId = req.userId;

  try {
    const { results: existing } = runQuery(
      'SELECT * FROM favorites WHERE user_id = ? AND track_id = ?',
      [userId, track_id]
    );

    if (existing[0]) {
      runRun('DELETE FROM favorites WHERE id = ?', [existing[0].id]);
      res.json({ favorited: false, track_id });
    } else {
      runRun('INSERT INTO favorites (user_id, track_id) VALUES (?, ?)', [userId, track_id]);
      res.json({ favorited: true, track_id });
    }
  } catch (err) {
    console.error('[MusicAPI] Favorite toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle favorite' });
  }
});

/**
 * POST /api/music/history
 * Log play history
 */
router.post('/history', authMiddleware, async (req, res) => {
  await getDB();
  const { track_id, completed = false, progress_seconds = 0, source_used } = req.body;
  const userId = req.userId;

  try {
    runRun(
      'INSERT INTO play_history (user_id, track_id, completed, progress_seconds, source_used) VALUES (?, ?, ?, ?, ?)',
      [userId, track_id, completed ? 1 : 0, progress_seconds, source_used || '']
    );

    res.json({ logged: true });
  } catch (err) {
    console.error('[MusicAPI] History log error:', err);
    res.status(500).json({ error: 'Failed to log history' });
  }
});

/**
 * GET /api/music/history
 * Get play history
 */
router.get('/history', authMiddleware, async (req, res) => {
  await getDB();
  const userId = req.userId;
  const limit = parseInt(req.query.limit) || 50;

  try {
    const { results } = runQuery(
      `SELECT t.*, ph.played_at, ph.completed, ph.progress_seconds, ph.source_used
       FROM tracks t
       JOIN play_history ph ON t.id = ph.track_id
       WHERE ph.user_id = ?
       ORDER BY ph.played_at DESC
       LIMIT ?`,
      [userId, limit]
    );

    res.json({ history: results, count: results.length });
  } catch (err) {
    console.error('[MusicAPI] History fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

/**
 * GET /api/music/trending
 * Get trending/featured tracks
 */
router.get('/trending', async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;

  try {
    // Search for popular tracks from iTunes
    const results = await searchService.search('top hits 2024', { 
      sources: ['itunes'], 
      limit 
    });

    res.json({ tracks: results, count: results.length });
  } catch (err) {
    console.error('[MusicAPI] Trending error:', err);
    res.status(500).json({ error: 'Failed to fetch trending' });
  }
});

/**
 * GET /api/music/info/:trackId
 * Get detailed track info
 */
router.get('/info/:trackId', async (req, res) => {
  const { trackId } = req.params;

  try {
    const track = await searchService.getTrackDetails(trackId);
    
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    // Also check for available stream sources
    const stream = await streamService.resolveStream(track);

    res.json({
      track,
      stream_available: !!stream,
      stream: stream ? {
        type: stream.type,
        quality: stream.quality,
        duration: stream.duration
      } : null
    });
  } catch (err) {
    console.error('[MusicAPI] Info error:', err);
    res.status(500).json({ error: 'Failed to fetch track info' });
  }
});

module.exports = router;
