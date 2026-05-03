const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { v4: uuidv4 } = require('uuid');
const { getDB, runQuery, runRun, getLastInsertId } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const YOUTUBE_API_KEY = 'AIzaSyBBzUjXuhgFyiSYs7te9umSKbpdTNolxjU';

const router = express.Router();

// Helper to make HTTPS requests (Node.js native)
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Multer config for audio uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', '..', 'audio-storage'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Unsupported audio format'), false);
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Upload a song
router.post('/upload', authMiddleware, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { title, artist, album } = req.body;
  await getDB();
  const filePath = `/audio/${req.file.filename}`;
  runRun('INSERT INTO songs (title, artist, album, file_path) VALUES (?, ?, ?, ?)',
    [title || req.file.originalname, artist || 'Unknown', album || '', filePath]);
  const id = getLastInsertId();
  const { results } = runQuery('SELECT * FROM songs WHERE id = ?', [id]);
  res.status(201).json({ song: results[0] });
});

// Get all songs
router.get('/', async (req, res) => {
  await getDB();
  const { results } = runQuery('SELECT * FROM songs ORDER BY created_at DESC');
  res.json({ songs: results });
});

// Stream audio by file path (for offline downloaded songs)
// No auth required - files are already downloaded locally
router.get('/stream-by-path', async (req, res) => {
  const filePath = req.query.path;
  console.log('Stream-by-path request:', filePath);

  if (!filePath) return res.status(400).json({ error: 'Path required' });

  // Security check: ensure path is within audio-storage
  const audioStoragePath = path.resolve(path.join(__dirname, '..', '..', 'audio-storage'));
  const resolvedPath = path.resolve(filePath);

  console.log('Audio storage path:', audioStoragePath);
  console.log('Resolved path:', resolvedPath);
  console.log('Path valid:', resolvedPath.startsWith(audioStoragePath));

  if (!resolvedPath.startsWith(audioStoragePath)) {
    return res.status(403).json({ error: 'Invalid path' });
  }

  if (!fs.existsSync(resolvedPath)) {
    console.log('File not found:', resolvedPath);
    return res.status(404).json({ error: 'File not found' });
  }

  console.log('Streaming file:', resolvedPath);

  // Get file stats
  const stat = fs.statSync(resolvedPath);
  const fileSize = stat.size;
  const ext = path.extname(resolvedPath).toLowerCase();

  // MIME type mapping
  const mimeTypes = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
  };
  const contentType = mimeTypes[ext] || 'audio/mpeg';

  // Handle range requests for seeking
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
    });
    fs.createReadStream(resolvedPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
    });
    fs.createReadStream(resolvedPath).pipe(res);
  }
});

// Stream a song's audio file
router.get('/:id/stream', async (req, res) => {
  await getDB();
  const { results } = runQuery('SELECT * FROM songs WHERE id = ?', [req.params.id]);
  if (!results[0]) return res.status(404).json({ error: 'Song not found' });

  const song = results[0];
  // For local songs, file_path is /audio/filename.ext
  if (song.file_path && song.file_path.startsWith('/audio/')) {
    const filename = song.file_path.replace('/audio/', '');
    const filePath = path.join(__dirname, '..', '..', 'audio-storage', filename);
    const fs = require('fs');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Audio file not found' });
    const stat = fs.statSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    };
    res.setHeader('Content-Type', mimeTypes[ext] || 'audio/mpeg');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');

    // Support range requests for seeking
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', chunkSize);
      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      fs.createReadStream(filePath).pipe(res);
    }
  } else {
    return res.status(400).json({ error: 'No streamable file for this song' });
  }
});

// Get single song
router.get('/:id', async (req, res) => {
  await getDB();
  const { results } = runQuery('SELECT * FROM songs WHERE id = ?', [req.params.id]);
  if (!results[0]) return res.status(404).json({ error: 'Song not found' });
  res.json({ song: results[0] });
});

// Search local songs
router.get('/search/:query', async (req, res) => {
  const { query } = req.params;
  await getDB();
  const pattern = `%${query}%`;
  const { results } = runQuery(
    'SELECT * FROM songs WHERE title LIKE ? OR artist LIKE ? OR album LIKE ? ORDER BY created_at DESC',
    [pattern, pattern, pattern]
  );
  res.json({ songs: results });
});

// Search iTunes (online music search)
router.get('/search-online/:query', async (req, res) => {
  const { query } = req.params;
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=25`;
    const data = await httpsGet(url);
    const songs = (data.results || []).map(track => ({
      id: `itunes-${track.trackId}`,
      title: track.trackName || 'Unknown',
      artist: track.artistName || 'Unknown',
      album: track.collectionName || '',
      duration: track.trackTimeMillis ? Math.floor(track.trackTimeMillis / 1000) : 0,
      file_path: track.previewUrl || '',
      cover_url: track.artworkUrl100 || '',
      source: 'itunes',
      previewUrl: track.previewUrl || '',
      trackViewUrl: track.trackViewUrl || '',
    }));
    res.json({ songs });
  } catch (err) {
    console.error('iTunes search error:', err);
    res.status(500).json({ error: 'Online search failed' });
  }
});

// Get featured/top songs from iTunes
router.get('/featured', async (req, res) => {
  try {
    const url = 'https://itunes.apple.com/search?term=top+hits&media=music&limit=20';
    const data = await httpsGet(url);
    const songs = (data.results || []).map(track => ({
      id: `itunes-${track.trackId}`,
      title: track.trackName || 'Unknown',
      artist: track.artistName || 'Unknown',
      album: track.collectionName || '',
      duration: track.trackTimeMillis ? Math.floor(track.trackTimeMillis / 1000) : 0,
      file_path: track.previewUrl || '',
      cover_url: track.artworkUrl100 || '',
      source: 'itunes',
      previewUrl: track.previewUrl || '',
      trackViewUrl: track.trackViewUrl || '',
    }));
    res.json({ songs });
  } catch (err) {
    console.error('Featured songs error:', err);
    res.status(500).json({ error: 'Failed to fetch featured songs' });
  }
});

// Hybrid search: Spotify metadata + YouTube full songs
router.get('/hybrid-search/:query', async (req, res) => {
  const { query } = req.params;
  const https = require('https');
  
  try {
    console.log('Hybrid search for:', query);

    // Step 1: Get Spotify metadata
    const spotifyResults = await getSpotifyResults(query);
    
    // Step 2: For each Spotify result, find YouTube video for full song
    const hybridResults = [];
    
    for (const spotifyTrack of spotifyResults.slice(0, 10)) { // Limit to 10 for performance
      try {
        // Search YouTube for this specific song
        const searchQuery = `${spotifyTrack.title} ${spotifyTrack.artist} official`;
        console.log(`Searching YouTube for: ${searchQuery}`);
        const youtubeVideo = await findYouTubeVideo(searchQuery);
        
        if (youtubeVideo) {
          console.log(`✅ Found YouTube for ${spotifyTrack.title}: ${youtubeVideo.videoId}`);
          hybridResults.push({
            // Spotify metadata (legal discovery)
            id: spotifyTrack.id,
            title: spotifyTrack.title,
            artist: spotifyTrack.artist,
            album: spotifyTrack.album,
            duration: spotifyTrack.duration,
            cover_url: spotifyTrack.cover_url,
            spotify_id: spotifyTrack.spotify_id,
            external_urls: spotifyTrack.external_urls,
            previewUrl: spotifyTrack.previewUrl,
            
            // YouTube for full song playback
            youtube_id: youtubeVideo.videoId,
            youtube_title: youtubeVideo.title,
            youtube_url: `https://www.youtube.com/watch?v=${youtubeVideo.videoId}`,
            youtube_thumbnail: youtubeVideo.thumbnail,
            
            // Combined info
            source: 'hybrid',
            file_path: `https://www.youtube.com/watch?v=${youtubeVideo.videoId}`,
            full_song_available: true
          });
        } else {
          console.log(`❌ No YouTube found for ${spotifyTrack.title}, using Spotify only`);
          // Fallback to Spotify preview only
          hybridResults.push({
            ...spotifyTrack,
            source: 'spotify',
            full_song_available: false
          });
        }
      } catch (err) {
        console.log(`❌ Failed to find YouTube for ${spotifyTrack.title}:`, err.message);
        // Add Spotify result anyway
        hybridResults.push({
          ...spotifyTrack,
          source: 'spotify',
          full_song_available: false
        });
      }
    }

    console.log(`Hybrid search complete: ${hybridResults.length} results for: ${query}`);
    res.json({ songs: hybridResults });

  } catch (err) {
    console.error('Hybrid search error:', err.message);
    res.json({ songs: [] });
  }
});

// Helper function to get Spotify results
async function getSpotifyResults(query) {
  const https = require('https');
  
  try {
    // Get Spotify access token
    const tokenUrl = 'https://accounts.spotify.com/api/token';
    const tokenData = await new Promise((resolve, reject) => {
      const postData = 'grant_type=client_credentials';
      const tokenReq = https.request(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from('4a8a5c9b8d8e4f3a2b1c9d8e7f6a5b4c:3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a').toString('base64')
        }
      }, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try {
            if (response.statusCode === 200) {
              resolve(JSON.parse(data));
            } else {
              reject(new Error(`Token error: ${response.statusCode}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
      
      tokenReq.write(postData);
      tokenReq.end();
    });

    if (!tokenData.access_token) {
      throw new Error('Failed to get Spotify access token');
    }

    // Search Spotify tracks
    const searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=20&market=US`;
    
    const searchData = await new Promise((resolve, reject) => {
      const searchReq = https.get(searchUrl, {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`
        }
      }, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try {
            if (response.statusCode === 200) {
              resolve(JSON.parse(data));
            } else {
              reject(new Error(`Search error: ${response.statusCode}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
      
      searchReq.setTimeout(10000, () => {
        searchReq.destroy();
        reject(new Error('Search timeout'));
      });
    });

    if (!searchData.tracks || !searchData.tracks.items || searchData.tracks.items.length === 0) {
      return [];
    }

    // Process Spotify results
    return searchData.tracks.items.map(track => ({
      id: track.id,
      title: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      album: track.album.name,
      duration: Math.floor(track.duration_ms / 1000),
      cover_url: track.album.images[0]?.url || '',
      source: 'spotify',
      previewUrl: track.preview_url,
      spotify_id: track.id,
      external_urls: track.external_urls
    }));

  } catch (err) {
    console.error('Spotify search error:', err.message);
    return [];
  }
}

// Helper function to find YouTube video for a song
async function findYouTubeVideo(songQuery) {
  const https = require('https');
  
  try {
    console.log('Searching YouTube for:', songQuery);
    
    // Try multiple Invidious instances for better reliability
    const instances = [
      'https://yewtu.be',
      'https://invidious.snopyta.org',
      'https://vid.puffyan.us'
    ];
    
    for (const instance of instances) {
      try {
        const invidiousUrl = `${instance}/api/v1/search?q=${encodeURIComponent(songQuery)}&type=video`;
        
        const data = await new Promise((resolve, reject) => {
          const req = https.get(invidiousUrl, { timeout: 5000 }, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
              try {
                if (response.statusCode === 200) {
                  resolve(JSON.parse(data));
                } else {
                  reject(new Error(`HTTP ${response.statusCode}`));
                }
              } catch (e) {
                reject(e);
              }
            });
          }).on('error', reject);
          
          req.setTimeout(5000, () => {
            req.destroy();
            reject(new Error('Timeout'));
          });
        });

        if (data && data.length > 0) {
          // Find the best match (prefer official music videos)
          const video = data.find(v => 
            v.title.toLowerCase().includes('official') ||
            v.title.toLowerCase().includes('music video') ||
            v.title.toLowerCase().includes('audio')
          ) || data[0];
          
          console.log(`Found YouTube video via ${instance}:`, video.title);
          return {
            videoId: video.videoId,
            title: video.title,
            thumbnail: video.videoThumbnails?.[0]?.url || ''
          };
        }
      } catch (err) {
        console.log(`Instance ${instance} failed:`, err.message);
        continue;
      }
    }
    
    console.log('No YouTube video found for:', songQuery);
    return null;
  } catch (err) {
    console.log('YouTube search failed:', err.message);
    return null;
  }
}

// Keep original Spotify search for compatibility
router.get('/spotify-search/:query', async (req, res) => {
  const { query } = req.params;
  
  try {
    const results = await getSpotifyResults(query);
    console.log(`Found ${results.length} Spotify results for: ${query}`);
    res.json({ songs: results });
  } catch (err) {
    console.error('Spotify search error:', err.message);
    res.json({ songs: [] });
  }
});

// Simple YouTube search for full songs
router.get('/youtube-search/:query', async (req, res) => {
  const { query } = req.params;
  const https = require('https');
  
  try {
    console.log('Direct YouTube search for:', query);
    
    // Use multiple Invidious instances for reliability
    const instances = [
      'https://yewtu.be',
      'https://invidious.snopyta.org',
      'https://vid.puffyan.us'
    ];
    
    let results = [];
    
    for (const instance of instances) {
      try {
        const invidiousUrl = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video`;
        
        const data = await new Promise((resolve, reject) => {
          const req = https.get(invidiousUrl, { timeout: 5000 }, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
              try {
                if (response.statusCode === 200) {
                  resolve(JSON.parse(data));
                } else {
                  reject(new Error(`HTTP ${response.statusCode}`));
                }
              } catch (e) {
                reject(e);
              }
            });
          }).on('error', reject);
          
          req.setTimeout(5000, () => {
            req.destroy();
            reject(new Error('Timeout'));
          });
        });

        if (data && data.length > 0) {
          console.log(`✅ Found ${data.length} YouTube videos via ${instance}`);
          
          // Process YouTube results
          results = data.slice(0, 10).map(v => ({
            id: v.videoId,
            title: v.title,
            artist: v.author || v.channelTitle || 'Unknown',
            album: 'YouTube',
            duration: Math.floor(v.lengthSeconds || 0),
            file_path: `https://www.youtube.com/watch?v=${v.videoId}`,
            cover_url: v.videoThumbnails?.[0]?.url || '',
            source: 'youtube',
            previewUrl: null,
            youtube_id: v.videoId,
            full_song_available: true
          }));
          
          break; // Found results, stop trying other instances
        }
      } catch (err) {
        console.log(`Instance ${instance} failed:`, err.message);
        continue;
      }
    }
    
    if (results.length === 0) {
      console.log('No YouTube results found, returning empty');
      return res.json({ songs: [] });
    }
    
    console.log(`Returning ${results.length} YouTube results`);
    res.json({ songs: results });
    
  } catch (err) {
    console.error('YouTube search error:', err.message);
    res.json({ songs: [] });
  }
});

// Stream YouTube audio - simplified approach
router.get('/:id/stream', async (req, res) => {
  const { id } = req.params;
  try {
    console.log('Streaming YouTube audio for:', id);
    
    // Check if this is a YouTube video ID (11 characters)
    if (id.length === 11) {
      console.log('Detected YouTube video, redirecting to embed');
      
      // Create an HTML page that will play the YouTube video
      const html = `
<!DOCTYPE html>
<html>
<head>
    <title>YouTube Player</title>
    <style>
        body { margin: 0; padding: 0; background: #000; }
        iframe { 
            position: absolute; 
            top: 0; left: 0; 
            width: 100%; height: 100%; 
            border: none; 
        }
    </style>
</head>
<body>
    <iframe 
        src="https://www.youtube.com/embed/${id}?autoplay=1&controls=1&modestbranding=1" 
        allow="autoplay; encrypted-media" 
        allowfullscreen>
    </iframe>
</body>
</html>`;
      
      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    }
    
    // For other cases, return error
    res.status(404).json({ error: 'Song not found' });
    
  } catch (err) {
    console.error('Stream error:', err.message);
    res.status(500).json({ error: 'Stream failed' });
  }
});

// Upload MP3 file to personal library
router.post('/upload', authMiddleware, upload.single('mp3'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { title, artist, album } = req.body;
    const userId = req.user.id;
    
    console.log('Uploading MP3:', req.file.originalname, 'User:', userId);
    
    // Generate unique filename
    const filename = `user-${userId}-${Date.now()}.mp3`;
    const filePath = path.join(__dirname, '..', 'audio-storage', filename);
    
    // Move file to storage
    fs.renameSync(req.file.path, filePath);
    
    // Extract metadata from file (basic implementation)
    let songTitle = title || req.file.originalname.replace('.mp3', '');
    let songArtist = artist || 'Unknown Artist';
    let songAlbum = album || 'Personal Library';
    
    // Save to database
    await getDB();
    runRun(
      'INSERT INTO songs (title, artist, album, duration, file_path, cover_url, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [songTitle, songArtist, songAlbum, 0, filename, '', userId]
    );
    
    const songId = getLastInsertId();
    
    res.json({
      success: true,
      song: {
        id: songId,
        title: songTitle,
        artist: songArtist,
        album: songAlbum,
        duration: 0,
        file_path: `/api/songs/${songId}/stream`,
        cover_url: '',
        source: 'personal',
        previewUrl: null
      }
    });
    
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Stream personal library files directly from server
router.get('/:id/stream', async (req, res) => {
  const { id } = req.params;
  try {
    console.log('Streaming personal library file for song ID:', id);
    
    await getDB();
    const { results } = runQuery('SELECT * FROM songs WHERE id = ?', [id]);
    
    if (!results[0]) {
      console.log('Song not found in database');
      return res.status(404).json({ error: 'Song not found' });
    }
    
    const song = results[0];
    
    // Check if it's a personal library file
    if (song.user_id && song.file_path) {
      const filePath = path.join(__dirname, '..', 'audio-storage', song.file_path);
      
      if (fs.existsSync(filePath)) {
        console.log('Streaming personal file:', filePath);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', `inline; filename="${song.title}.mp3"`);
        return res.sendFile(filePath);
      } else {
        console.log('Personal file not found:', filePath);
        return res.status(404).json({ error: 'File not found' });
      }
    }
    
    // Check if this is a YouTube video ID (11 characters)
    if (song.file_path && song.file_path.includes('youtube.com/watch?v=')) {
      const videoId = song.file_path.split('v=')[1]?.split('&')[0];
      if (videoId && videoId.length === 11) {
        console.log('Detected YouTube video, creating embed page');
        
        // Create an HTML page that will play the YouTube video
        const html = `
<!DOCTYPE html>
<html>
<head>
    <title>YouTube Player</title>
    <style>
        body { margin: 0; padding: 0; background: #000; }
        iframe { 
            position: absolute; 
            top: 0; left: 0; 
            width: 100%; height: 100%; 
            border: none; 
        }
    </style>
</head>
<body>
    <iframe 
        src="https://www.youtube.com/embed/${videoId}?autoplay=1&controls=1&modestbranding=1" 
        allow="autoplay; encrypted-media" 
        allowfullscreen>
    </iframe>
</body>
</html>`;
        
        res.setHeader('Content-Type', 'text/html');
        return res.send(html);
      }
    }
    
    // Default fallback
    res.status(404).json({ error: 'Song not found' });
    
  } catch (err) {
    console.error('Stream error:', err.message);
    res.status(500).json({ error: 'Stream failed' });
  }
});

// Get user's personal library
router.get('/personal', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    await getDB();
    const { results } = runQuery('SELECT * FROM songs WHERE user_id = ? ORDER BY created_at DESC', [userId]);
    
    const songs = results.map(song => ({
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      duration: song.duration,
      file_path: `/api/songs/${song.id}/stream`,
      cover_url: song.cover_url,
      source: 'personal',
      previewUrl: null
    }));
    
    res.json({ songs });
  } catch (err) {
    console.error('Personal library error:', err);
    res.status(500).json({ error: 'Failed to fetch personal library' });
  }
});

// Ensure a song exists in DB (for online songs, save them first)
async function ensureSongInDB(songData) {
  const { id, title, artist, album, duration, file_path, cover_url, source, previewUrl } = songData;
  // Check if already exists (by itunes-xxx id stored in a reference field)
  const { results } = runQuery('SELECT * FROM songs WHERE file_path = ?', [id]);
  if (results[0]) return results[0].id;
  // Insert the online song into the songs table
  runRun(
    'INSERT INTO songs (title, artist, album, duration, file_path, cover_url) VALUES (?, ?, ?, ?, ?, ?)',
    [title || 'Unknown', artist || 'Unknown', album || '', duration || 0, id, cover_url || '']
  );
  return getLastInsertId();
}

// Toggle favorite
router.post('/favorite', authMiddleware, async (req, res) => {
  try {
    await getDB();
    const { song } = req.body;
    if (!song) return res.status(400).json({ error: 'Song data required' });

    // Ensure song is in DB
    let songId;
    if (song.source === 'itunes' || String(song.id).startsWith('itunes-')) {
      songId = await ensureSongInDB(song);
    } else {
      songId = song.id || song.songId;
    }

    const { results } = runQuery('SELECT * FROM favorites WHERE user_id = ? AND track_id = ?', [req.userId, songId]);
    if (results[0]) {
      runRun('DELETE FROM favorites WHERE id = ?', [results[0].id]);
      res.json({ favorited: false, songId });
    } else {
      runRun('INSERT INTO favorites (user_id, track_id) VALUES (?, ?)', [req.userId, songId]);
      res.json({ favorited: true, songId });
    }
  } catch (err) {
    console.error('[Songs] Favorite error:', err.message);
    res.status(500).json({ error: 'Favorite failed', details: err.message });
  }
});

// Get favorites
router.get('/favorites/list', authMiddleware, async (req, res) => {
  try {
    await getDB();
    const { results } = runQuery(
      'SELECT s.* FROM songs s JOIN favorites f ON s.id = f.track_id WHERE f.user_id = ? ORDER BY f.created_at DESC',
      [req.userId]
    );
    // Add source field for online songs (id stored as itunes-xxx in file_path)
    const songs = results.map(s => ({
      ...s,
      source: s.file_path?.startsWith('itunes-') ? 'itunes' : 'local',
      previewUrl: s.file_path?.startsWith('itunes-') ? '' : s.file_path,
      cover_url: s.cover_url || '',
    }));
    res.json({ songs });
  } catch (err) {
    console.error('[Songs] Favorites list error:', err.message);
    res.status(500).json({ error: 'Failed to load favorites', songs: [] });
  }
});

// Helper to download file from URL
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(dest);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// Helper to search YouTube using https module (Node.js native)
function searchYouTube(query) {
  return new Promise((resolve, reject) => {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=1&key=${YOUTUBE_API_KEY}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Helper to download full audio from YouTube using yt-dlp
async function downloadYouTubeAudio(query, outputPath) {
  console.log('Searching YouTube for:', query);

  // First search for the video
  const searchData = await searchYouTube(query);

  if (!searchData.items || searchData.items.length === 0) {
    throw new Error('No YouTube video found');
  }

  const videoId = searchData.items[0].id.videoId;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log('Found YouTube video:', videoUrl);

  // Import findYtDlp from streamService
  const { findYtDlp } = require('../services/streamService');
  const ytDlpPath = await findYtDlp();
  
  if (!ytDlpPath) {
    throw new Error('yt-dlp not found');
  }

  // Use yt-dlp to download audio (best quality)
  // Use m4a format directly - no ffmpeg needed for conversion
  const outputTemplate = outputPath.replace('.mp3', '');
  const cmd = `"${ytDlpPath}" -f "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio" --no-playlist -o "${outputTemplate}.%(ext)s" "${videoUrl}"`;

  console.log('Running download command...');
  try {
    await execAsync(cmd, { timeout: 300000 }); // 5 minute timeout
    
    // Find the downloaded file (yt-dlp saves with extension based on format)
    const possibleExtensions = ['.m4a', '.webm', '.mp4', '.mp3'];
    let downloadedPath = null;
    
    for (const ext of possibleExtensions) {
      const testPath = outputTemplate + ext;
      if (fs.existsSync(testPath)) {
        downloadedPath = testPath;
        break;
      }
    }
    
    if (!downloadedPath) {
      throw new Error('Download completed but file not found');
    }
    
    console.log('Download complete:', downloadedPath);
    return downloadedPath;
  } catch (err) {
    console.error('yt-dlp failed:', err.message);
    throw err;
  }
}

// Alternative: Use yt-dlp without post-processing
async function downloadYouTubeAudioFallback(query, outputPath) {
  console.log('Using fallback download for:', query);

  const searchData = await searchYouTube(query);

  if (!searchData.items || searchData.items.length === 0) {
    throw new Error('No YouTube video found');
  }

  const videoId = searchData.items[0].id.videoId;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Import findYtDlp from streamService
  const { findYtDlp } = require('../services/streamService');
  const ytDlpPath = await findYtDlp();
  
  if (!ytDlpPath) {
    throw new Error('yt-dlp not found');
  }

  const outputTemplate = outputPath.replace('.mp3', '');
  const cmd = `"${ytDlpPath}" -f "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio" --no-playlist -o "${outputTemplate}.%(ext)s" "${videoUrl}"`;

  await execAsync(cmd, { timeout: 300000 });
  
  // Find the downloaded file
  const possibleExtensions = ['.m4a', '.webm', '.mp4', '.mp3'];
  for (const ext of possibleExtensions) {
    const testPath = outputTemplate + ext;
    if (fs.existsSync(testPath)) {
      return testPath;
    }
  }
  
  throw new Error('Download completed but file not found');
}

// Download (track for offline)
router.post('/download', authMiddleware, async (req, res) => {
  await getDB();
  const { song } = req.body;
  if (!song) return res.status(400).json({ error: 'Song data required' });

  try {
    // Ensure song is in DB
    let songId;
    let localFilePath = null;
    let isFullSong = false;

    if (song.source === 'itunes' || String(song.id).startsWith('itunes-')) {
      songId = await ensureSongInDB(song);

      const audioStoragePath = path.join(__dirname, '..', '..', 'audio-storage');
      // Ensure directory exists
      if (!fs.existsSync(audioStoragePath)) {
        fs.mkdirSync(audioStoragePath, { recursive: true });
      }

      // Generate local filename for FULL song from YouTube (without extension - yt-dlp adds it)
      const localFileName = `full-${uuidv4()}`;
      localFilePath = path.join(audioStoragePath, localFileName);

      // Try to download FULL audio from YouTube
      const searchQuery = `${song.title} ${song.artist} audio`;
      
      try {
        localFilePath = await downloadYouTubeAudio(searchQuery, localFilePath);
        isFullSong = true;
        console.log('Downloaded FULL song from YouTube:', localFilePath);
      } catch (ytError) {
        console.error('YouTube download failed, trying fallback:', ytError.message);

        // Try fallback
        try {
          localFilePath = await downloadYouTubeAudioFallback(searchQuery, localFilePath);
          isFullSong = true;
          console.log('Downloaded FULL song using fallback:', localFilePath);
        } catch (fallbackError) {
          console.error('Fallback failed too, using preview:', fallbackError.message);

          // Fallback to 30-second preview
          if (song.previewUrl) {
            const previewPath = localFilePath + '.m4a';
            await downloadFile(song.previewUrl, previewPath);
            localFilePath = previewPath;
            isFullSong = false;
            console.log('Downloaded 30-second preview instead:', localFilePath);
          } else {
            throw new Error('Could not download audio and no preview available');
          }
        }
      }

      // Update the song record with the local file path
      runRun(
        'UPDATE songs SET file_path = ? WHERE id = ?',
        [localFilePath, songId]
      );
    } else {
      songId = song.id || song.songId;
      // Local songs are already stored, just track the download
      localFilePath = song.file_path || song.previewUrl;
    }

    // Add to downloads table
    runRun('INSERT OR IGNORE INTO downloads (user_id, song_id) VALUES (?, ?)', [req.userId, songId]);

    const { results } = runQuery('SELECT * FROM songs WHERE id = ?', [songId]);
    res.json({
      downloaded: true,
      song: results[0],
      songId,
      localPath: localFilePath,
      offlineReady: !!localFilePath,
      isFullSong: isFullSong
    });
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Failed to download song', details: err.message });
  }
});

// Get downloads
router.get('/downloads/list', authMiddleware, async (req, res) => {
  await getDB();
  const { results } = runQuery(
    'SELECT s.* FROM songs s JOIN downloads d ON s.id = d.song_id WHERE d.user_id = ? ORDER BY d.downloaded_at DESC',
    [req.userId]
  );
  const songs = results.map(s => ({
    ...s,
    source: s.file_path?.startsWith('itunes-') ? 'itunes' : 'local',
    previewUrl: s.file_path?.startsWith('itunes-') ? '' : s.file_path,
    cover_url: s.cover_url || '',
  }));
  res.json({ songs });
});

// Get lyrics for a song (using lyrics.ovh API - free, no key needed)
router.get('/lyrics/:title/:artist', async (req, res) => {
  try {
    const { title, artist } = req.params;
    // Clean up the title and artist for the API
    const cleanTitle = decodeURIComponent(title).replace(/\([^)]*\)/g, '').trim();
    const cleanArtist = decodeURIComponent(artist).split(',')[0].trim(); // Take first artist if multiple
    
    // Try lyrics.ovh API
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(cleanArtist)}/${encodeURIComponent(cleanTitle)}`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.lyrics) {
      res.json({ lyrics: data.lyrics });
    } else {
      // Fallback: Try with just the title
      const url2 = `https://api.lyrics.ovh/v1/${encodeURIComponent(cleanArtist)}/${encodeURIComponent(cleanTitle.split(' ')[0])}`;
      const response2 = await fetch(url2);
      const data2 = await response2.json();
      
      if (data2.lyrics) {
        res.json({ lyrics: data2.lyrics });
      } else {
        res.status(404).json({ 
          error: 'Lyrics not found',
          lyrics: `🎵 ${title} by ${artist}\n\n[Verse 1]\nWe couldn't find the lyrics for this song...\n\n[Chorus]\nTry searching on Genius.com or Musixmatch.com\nfor the real lyrics to this track!\n\n🎶` 
        });
      }
    }
  } catch (err) {
    console.error('Lyrics fetch error:', err);
    res.status(500).json({ 
      error: 'Failed to fetch lyrics',
      lyrics: `🎵 ${req.params.title} by ${req.params.artist}\n\nLyrics temporarily unavailable.\n\nPlease try again later.` 
    });
  }
});

// Delete song
router.delete('/:id', authMiddleware, async (req, res) => {
  await getDB();
  const { changes } = runRun('DELETE FROM songs WHERE id = ?', [req.params.id]);
  if (changes === 0) return res.status(404).json({ error: 'Song not found' });
  res.json({ deleted: true });
});

module.exports = router;
