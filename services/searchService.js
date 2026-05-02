/**
 * Search Aggregation Service
 * Aggregates music metadata from multiple sources (Spotify, iTunes, Jamendo)
 */

const https = require('https');

// API Keys (should be in env vars)
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const JAMENDO_CLIENT_ID = process.env.JAMENDO_CLIENT_ID || '';

// Helper for HTTPS requests
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = new URL(url);
    const requestOptions = {
      hostname: options.hostname,
      path: options.pathname + options.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Soundy-Music-App/1.0',
        ...headers
      }
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

class SearchService {
  constructor() {
    this.spotifyToken = null;
    this.spotifyTokenExpiry = null;
  }

  /**
   * Main search method - aggregates results from multiple sources
   */
  async search(query, options = {}) {
    const sources = options.sources || ['spotify', 'itunes', 'jamendo'];
    const limit = options.limit || 20;

    console.log(`[SearchService] Searching for: "${query}"`);
    console.log(`[SearchService] Sources: ${sources.join(', ')}`);

    const searchPromises = sources.map(source => 
      this.searchSource(source, query, limit).catch(err => {
        console.error(`[SearchService] ${source} search failed:`, err.message);
        return [];
      })
    );

    const results = await Promise.all(searchPromises);
    const merged = this.mergeAndDeduplicate(results.flat());
    
    console.log(`[SearchService] Found ${merged.length} unique tracks`);
    return merged.slice(0, limit);
  }

  /**
   * Search a specific source
   */
  async searchSource(source, query, limit) {
    switch(source) {
      case 'spotify':
        return this.searchSpotify(query, limit);
      case 'itunes':
        return this.searchItunes(query, limit);
      case 'jamendo':
        return this.searchJamendo(query, limit);
      default:
        return [];
    }
  }

  /**
   * Search Spotify API
   */
  async searchSpotify(query, limit = 20) {
    // If no Spotify credentials, skip
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
      console.log('[SearchService] Skipping Spotify (no API credentials)');
      return [];
    }

    try {
      const token = await this.getSpotifyToken();
      const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`;
      
      const data = await httpsGet(url, {
        'Authorization': `Bearer ${token}`
      });

      return (data.tracks?.items || []).map(track => ({
        id: `spotify-${track.id}`,
        title: track.name,
        artist: track.artists.map(a => a.name).join(', '),
        album: track.album.name,
        duration: Math.floor(track.duration_ms / 1000),
        cover_url: track.album.images[0]?.url || '',
        popularity: track.popularity,
        preview_url: track.preview_url, // 30-sec preview
        external_ids: {
          spotify: track.id,
          isrc: track.external_ids?.isrc
        },
        source_type: 'spotify',
        streamable: false, // Spotify doesn't allow direct streaming
        metadata: {
          explicit: track.explicit,
          track_number: track.track_number,
          album_type: track.album.album_type
        }
      }));
    } catch (err) {
      console.error('[SearchService] Spotify error:', err.message);
      return [];
    }
  }

  /**
   * Get Spotify access token
   */
  async getSpotifyToken() {
    // Return cached token if valid
    if (this.spotifyToken && this.spotifyTokenExpiry > Date.now()) {
      return this.spotifyToken;
    }

    try {
      const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
      const url = 'https://accounts.spotify.com/api/token?grant_type=client_credentials';
      
      const data = await httpsGet(url, {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      });

      this.spotifyToken = data.access_token;
      this.spotifyTokenExpiry = Date.now() + (data.expires_in * 1000);
      
      return this.spotifyToken;
    } catch (err) {
      throw new Error('Failed to get Spotify token: ' + err.message);
    }
  }

  /**
   * Search iTunes API (free, no API key needed)
   */
  async searchItunes(query, limit = 20) {
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=${limit}`;
      const data = await httpsGet(url);

      return (data.results || []).map(track => ({
        id: `itunes-${track.trackId}`,
        title: track.trackName,
        artist: track.artistName,
        album: track.collectionName,
        duration: Math.floor(track.trackTimeMillis / 1000),
        cover_url: track.artworkUrl100?.replace('100x100', '600x600') || '',
        preview_url: track.previewUrl, // 30-sec preview
        external_ids: {
          itunes: track.trackId.toString()
        },
        source_type: 'itunes',
        streamable: false, // Only preview available
        metadata: {
          track_number: track.trackNumber,
          disc_number: track.discNumber,
          genre: track.primaryGenreName,
          release_date: track.releaseDate
        }
      }));
    } catch (err) {
      console.error('[SearchService] iTunes error:', err.message);
      return [];
    }
  }

  /**
   * Search Jamendo API (free Creative Commons music)
   */
  async searchJamendo(query, limit = 20) {
    try {
      const clientId = JAMENDO_CLIENT_ID || 'soundy_dev'; // Use default for dev
      const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${clientId}&search=${encodeURIComponent(query)}&limit=${limit}&include=musicinfo&audioformat=mp32`;
      
      const data = await httpsGet(url);

      return (data.results || []).map(track => ({
        id: `jamendo-${track.id}`,
        title: track.name,
        artist: track.artist_name,
        album: track.album_name || '',
        duration: track.duration,
        cover_url: track.album_image || track.image,
        preview_url: track.audio, // Full MP3 stream URL!
        external_ids: {
          jamendo: track.id
        },
        source_type: 'jamendo',
        streamable: true, // Direct MP3 URL available
        stream_url: track.audio,
        metadata: {
          license: track.license_ccurl,
          lyrics: track.lyrics,
          musicinfo: track.musicinfo
        }
      }));
    } catch (err) {
      console.error('[SearchService] Jamendo error:', err.message);
      return [];
    }
  }

  /**
   * Merge and deduplicate results from multiple sources
   */
  mergeAndDeduplicate(tracks) {
    const seen = new Map();
    
    // Sort by quality: Jamendo (full) > Spotify > iTunes (preview only)
    const sorted = tracks.sort((a, b) => {
      if (a.streamable && !b.streamable) return -1;
      if (!a.streamable && b.streamable) return 1;
      return (b.popularity || 0) - (a.popularity || 0);
    });

    return sorted.filter(track => {
      // Create a unique key based on title + artist (fuzzy matching)
      const key = `${track.title.toLowerCase().trim()}|${track.artist.toLowerCase().trim()}`;
      
      if (seen.has(key)) {
        // Merge additional info into existing track
        const existing = seen.get(key);
        this.mergeTrackInfo(existing, track);
        return false;
      }
      
      seen.set(key, track);
      return true;
    });
  }

  /**
   * Merge track info from multiple sources
   */
  mergeTrackInfo(existing, newTrack) {
    // Keep the best quality cover
    if (newTrack.cover_url && (!existing.cover_url || newTrack.cover_url.includes('600x600'))) {
      existing.cover_url = newTrack.cover_url;
    }

    // Add external IDs
    if (newTrack.external_ids) {
      existing.external_ids = { ...existing.external_ids, ...newTrack.external_ids };
    }

    // Prefer streamable sources
    if (newTrack.streamable && !existing.streamable) {
      existing.streamable = true;
      existing.stream_url = newTrack.stream_url;
      existing.preview_url = newTrack.preview_url;
      existing.source_type = newTrack.source_type;
    }

    // Merge metadata
    if (newTrack.metadata) {
      existing.metadata = { ...existing.metadata, ...newTrack.metadata };
    }

    // Keep the highest popularity score
    if (newTrack.popularity && (!existing.popularity || newTrack.popularity > existing.popularity)) {
      existing.popularity = newTrack.popularity;
    }
  }

  /**
   * Get track details by ID
   */
  async getTrackDetails(trackId) {
    const [source, id] = trackId.split('-');
    
    // Try to find in database first
    // If not found, fetch from source API
    
    switch(source) {
      case 'spotify':
        return this.getSpotifyTrackDetails(id);
      case 'itunes':
        return this.getItunesTrackDetails(id);
      case 'jamendo':
        return this.getJamendoTrackDetails(id);
      default:
        return null;
    }
  }

  async getSpotifyTrackDetails(id) {
    if (!SPOTIFY_CLIENT_ID) return null;
    
    try {
      const token = await this.getSpotifyToken();
      const url = `https://api.spotify.com/v1/tracks/${id}`;
      const data = await httpsGet(url, { 'Authorization': `Bearer ${token}` });
      
      return {
        id: `spotify-${data.id}`,
        title: data.name,
        artist: data.artists.map(a => a.name).join(', '),
        album: data.album.name,
        duration: Math.floor(data.duration_ms / 1000),
        cover_url: data.album.images[0]?.url || '',
        preview_url: data.preview_url,
        external_ids: { spotify: data.id, isrc: data.external_ids?.isrc },
        source_type: 'spotify'
      };
    } catch (err) {
      console.error('[SearchService] Spotify track details error:', err.message);
      return null;
    }
  }

  async getItunesTrackDetails(id) {
    try {
      const url = `https://itunes.apple.com/lookup?id=${id}`;
      const data = await httpsGet(url);
      
      if (!data.results?.[0]) return null;
      
      const track = data.results[0];
      return {
        id: `itunes-${track.trackId}`,
        title: track.trackName,
        artist: track.artistName,
        album: track.collectionName,
        duration: Math.floor(track.trackTimeMillis / 1000),
        cover_url: track.artworkUrl100?.replace('100x100', '600x600') || '',
        preview_url: track.previewUrl,
        external_ids: { itunes: track.trackId.toString() },
        source_type: 'itunes'
      };
    } catch (err) {
      console.error('[SearchService] iTunes track details error:', err.message);
      return null;
    }
  }

  async getJamendoTrackDetails(id) {
    try {
      const clientId = JAMENDO_CLIENT_ID || 'soundy_dev';
      const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${clientId}&id=${id}`;
      const data = await httpsGet(url);
      
      if (!data.results?.[0]) return null;
      
      const track = data.results[0];
      return {
        id: `jamendo-${track.id}`,
        title: track.name,
        artist: track.artist_name,
        album: track.album_name || '',
        duration: track.duration,
        cover_url: track.album_image || track.image,
        preview_url: track.audio,
        stream_url: track.audio,
        external_ids: { jamendo: track.id },
        source_type: 'jamendo',
        streamable: true
      };
    } catch (err) {
      console.error('[SearchService] Jamendo track details error:', err.message);
      return null;
    }
  }
}

module.exports = new SearchService();
