const express = require('express');
const { getDB, runQuery, runRun, getLastInsertId } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Create playlist
router.post('/', authMiddleware, async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Playlist name required' });
  await getDB();
  runRun('INSERT INTO playlists (name, user_id, description) VALUES (?, ?, ?)', [name, req.userId, description || '']);
  const id = getLastInsertId();
  const { results } = runQuery('SELECT * FROM playlists WHERE id = ?', [id]);
  res.status(201).json({ playlist: results[0] });
});

// Get user's playlists
router.get('/', authMiddleware, async (req, res) => {
  await getDB();
  const { results } = runQuery(
    `SELECT p.*, (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = p.id) as song_count FROM playlists p 
     WHERE p.user_id = ? 
     ORDER BY p.created_at DESC`,
    [req.userId]
  );
  res.json({ playlists: results });
});

// Get single playlist with songs
router.get('/:id', authMiddleware, async (req, res) => {
  await getDB();
  const { results: plResults } = runQuery('SELECT * FROM playlists WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (!plResults[0]) return res.status(404).json({ error: 'Playlist not found' });
  const { results: songs } = runQuery(
    `SELECT s.*, ps.position, ps.added_at FROM songs s 
     JOIN playlist_songs ps ON s.id = ps.song_id 
     WHERE ps.playlist_id = ? 
     ORDER BY ps.position`,
    [req.params.id]
  );
  res.json({ playlist: plResults[0], songs });
});

// Add song to playlist
router.post('/:id/songs', authMiddleware, async (req, res) => {
  const { songId } = req.body;
  if (!songId) return res.status(400).json({ error: 'Song ID required' });
  await getDB();
  const { results: plResults } = runQuery('SELECT * FROM playlists WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (!plResults[0]) return res.status(404).json({ error: 'Playlist not found' });
  const { results: maxResults } = runQuery('SELECT MAX(position) as max FROM playlist_songs WHERE playlist_id = ?', [req.params.id]);
  const position = (maxResults[0]?.max ?? -1) + 1;
  try {
    runRun('INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)', [req.params.id, songId, position]);
    res.status(201).json({ added: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Song already in playlist' });
    throw err;
  }
});

// Remove song from playlist
router.delete('/:id/songs/:songId', authMiddleware, async (req, res) => {
  await getDB();
  const { changes } = runRun('DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?', [req.params.id, req.params.songId]);
  if (changes === 0) return res.status(404).json({ error: 'Song not in playlist' });
  res.json({ removed: true });
});

// Update playlist
router.put('/:id', authMiddleware, async (req, res) => {
  const { name, description } = req.body;
  await getDB();
  const { changes } = runRun('UPDATE playlists SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ? AND user_id = ?',
    [name, description, req.params.id, req.userId]);
  if (changes === 0) return res.status(404).json({ error: 'Playlist not found' });
  const { results } = runQuery('SELECT * FROM playlists WHERE id = ?', [req.params.id]);
  res.json({ playlist: results[0] });
});

// Delete playlist
router.delete('/:id', authMiddleware, async (req, res) => {
  await getDB();
  const { changes } = runRun('DELETE FROM playlists WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (changes === 0) return res.status(404).json({ error: 'Playlist not found' });
  res.json({ deleted: true });
});

module.exports = router;
