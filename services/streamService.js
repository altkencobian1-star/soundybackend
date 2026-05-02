/**
 * Stream Resolution Service
 * Resolves metadata to playable full-track streaming sources
 * Sources: YouTube (iframe), Jamendo (direct MP3), User uploads
 */

const https = require('https');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// API Keys
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyBBzUjXuhgFyiSYs7te9umSKbpdTNolxjU';

// Cache for yt-dlp path
let cachedYtDlpPath = null;

/**
 * Find yt-dlp executable across multiple locations
 */
async function findYtDlp() {
  if (cachedYtDlpPath) return cachedYtDlpPath;
  
  // Possible paths to check
  const possiblePaths = [
    process.env.YTDLP_PATH, // Custom env path
    path.join(process.env.USERPROFILE || process.env.HOME, 'yt-dlp.exe'),
    path.join(process.env.USERPROFILE || process.env.HOME, 'yt-dlp'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'yt-dlp.exe'),
    path.join(process.env.HOME || '', '.local', 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp.exe', // In PATH
    'yt-dlp'      // In PATH (Unix)
  ].filter(Boolean);
  
  for (const ytdlpPath of possiblePaths) {
    try {
      // Check if file exists for absolute paths
      if (ytdlpPath.includes('/') || ytdlpPath.includes('\\')) {
        if (!fs.existsSync(ytdlpPath)) continue;
      }
      
      // Test if it works
      await execAsync(`"${ytdlpPath}" --version`, { timeout: 5000 });
      cachedYtDlpPath = ytdlpPath;
      console.log('[StreamService] Found yt-dlp at:', ytdlpPath);
      return ytdlpPath;
    } catch (err) {
      // Continue to next path
    }
  }
  
  return null;
}

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
          resolve(data); // Return raw data for non-JSON
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

class StreamService {
  constructor() {
    // Priority order for stream sources
    this.resolvers = [
      { name: 'jamendo', resolver: this.resolveJamendo.bind(this) },
      { name: 'youtube', resolver: this.resolveYouTube.bind(this) },
      { name: 'user_upload', resolver: this.resolveUserUpload.bind(this) },
      { name: 'preview', resolver: this.resolvePreview.bind(this) }
    ];
  }

  /**
   * Main resolve method - attempts multiple sources in priority order
   */
  async resolveStream(track) {
    console.log(`[StreamService] Resolving stream for: "${track.title}" by ${track.artist}`);

    // If track already has a streamable source, use it
    if (track.streamable && track.stream_url) {
      console.log(`[StreamService] Using existing ${track.source_type} stream`);
      return {
        type: track.source_type,
        url: track.stream_url,
        embedUrl: this.buildEmbedUrl(track.source_type, track.stream_url),
        duration: track.duration,
        quality: this.getSourceQuality(track.source_type)
      };
    }

    // Try each resolver in order
    for (const { name, resolver } of this.resolvers) {
      try {
        console.log(`[StreamService] Trying ${name}...`);
        const result = await resolver(track);
        
        if (result) {
          console.log(`[StreamService] ✓ Found stream via ${name}`);
          return result;
        }
      } catch (err) {
        console.log(`[StreamService] ✗ ${name} failed:`, err.message);
      }
    }

    console.log('[StreamService] ✗ No playable source found');
    return null;
  }

  /**
   * Resolve via Jamendo (Direct MP3, full track)
   */
  async resolveJamendo(track) {
    // If track already has Jamendo ID
    if (track.external_ids?.jamendo) {
      return {
        type: 'jamendo',
        url: track.preview_url || track.stream_url,
        embedUrl: null, // Direct audio URL, no embed needed
        duration: track.duration,
        quality: 'high'
      };
    }

    // Search Jamendo
    try {
      const clientId = process.env.JAMENDO_CLIENT_ID || 'soundy_dev';
      const query = `${track.title} ${track.artist}`;
      const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${clientId}&search=${encodeURIComponent(query)}&limit=1&audioformat=mp32`;
      
      const data = await httpsGet(url);
      
      if (data.results?.[0]) {
        const jamendoTrack = data.results[0];
        return {
          type: 'jamendo',
          url: jamendoTrack.audio,
          embedUrl: null,
          duration: jamendoTrack.duration,
          quality: 'high',
          metadata: {
            jamendo_id: jamendoTrack.id,
            license: jamendoTrack.license_ccurl
          }
        };
      }
    } catch (err) {
      console.error('[StreamService] Jamendo search error:', err.message);
    }

    return null;
  }

  /**
   * Resolve via YouTube (iframe embed, full track)
   */
  async resolveYouTube(track) {
    // If track already has YouTube ID
    if (track.external_ids?.youtube) {
      const videoId = track.external_ids.youtube;
      return {
        type: 'youtube',
        url: `https://www.youtube.com/watch?v=${videoId}`,
        embedUrl: `https://www.youtube.com/embed/${videoId}?enablejsapi=1`,
        videoId: videoId,
        duration: track.duration,
        quality: 'high'
      };
    }

    // Search YouTube via yt-dlp (no API quota issues)
    const ytDlpPath = await findYtDlp();
    
    if (!ytDlpPath) {
      console.error('[StreamService] yt-dlp not found in any location');
      throw new Error(`yt-dlp not found - please install it`);
    }

    // Try multiple search queries
    const searchQueries = [
      `${track.title} ${track.artist} audio`,
      `${track.title} ${track.artist} official`,
      `${track.title} ${track.artist}`,
      `${track.title} audio`
    ];

    for (const searchQuery of searchQueries) {
      try {
        console.log('[StreamService] Trying YouTube search:', searchQuery);
        
        // Use yt-dlp to search and get video info (ytsearch3 = top 3 results)
        const searchCmd = `"${ytDlpPath}" "ytsearch3:${searchQuery}" --dump-json --no-download --quiet --skip-download --ignore-errors`;
        
        const { stdout, stderr } = await execAsync(searchCmd, { timeout: 30000 });
        
        if (stderr) {
          console.log('[StreamService] yt-dlp stderr:', stderr.substring(0, 200));
        }
        
        if (!stdout) {
          console.log('[StreamService] No results for:', searchQuery);
          continue;
        }

        // Parse all results (yt-dlp outputs one JSON object per line for multiple results)
        const lines = stdout.trim().split('\n').filter(line => line.trim());
        console.log(`[StreamService] Got ${lines.length} results`);
        
        for (const line of lines) {
          try {
            const videoInfo = JSON.parse(line);
            console.log('[StreamService] Checking video:', videoInfo.title, 'Duration:', videoInfo.duration);
            
            // Relaxed validation - just check reasonable duration (30s to 15min)
            const isValid = videoInfo.duration >= 30 && videoInfo.duration <= 900;
            
            if (isValid) {
              console.log('[StreamService] ✓ Using video:', videoInfo.id);
              return {
                type: 'youtube',
                url: `https://www.youtube.com/watch?v=${videoInfo.id}`,
                embedUrl: `https://www.youtube.com/embed/${videoInfo.id}?enablejsapi=1`,
                videoId: videoInfo.id,
                duration: videoInfo.duration,
                quality: 'high',
                metadata: {
                  title: videoInfo.title,
                  channel: videoInfo.channel || videoInfo.uploader,
                  thumbnail: videoInfo.thumbnail
                }
              };
            }
          } catch (parseErr) {
            // Skip invalid JSON lines
            continue;
          }
        }
      } catch (err) {
        console.log(`[StreamService] Search failed for "${searchQuery}":`, err.message);
        // Continue to next search query
      }
    }
    
    console.log('[StreamService] All YouTube searches failed');

    // Fallback to YouTube Data API if yt-dlp fails
    try {
      const searchQuery = `${track.title} ${track.artist}`;
      const apiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=1&q=${encodeURIComponent(searchQuery)}&key=${YOUTUBE_API_KEY}`;
      
      const data = await httpsGet(apiUrl);
      
      if (data.items?.[0]) {
        const videoId = data.items[0].id.videoId;
        return {
          type: 'youtube',
          url: `https://www.youtube.com/watch?v=${videoId}`,
          embedUrl: `https://www.youtube.com/embed/${videoId}?enablejsapi=1`,
          videoId: videoId,
          duration: null, // Would need additional API call
          quality: 'high'
        };
      }
    } catch (err) {
      console.error('[StreamService] YouTube API error:', err.message);
    }

    return null;
  }

  /**
   * Check if a YouTube video is likely the correct music track
   */
  isLikelyMusicVideo(videoInfo, track) {
    const videoTitle = (videoInfo.title || '').toLowerCase();
    const trackTitle = (track.title || '').toLowerCase();
    const trackArtist = (track.artist || '').toLowerCase();
    
    // Check title contains song name
    const titleMatch = videoTitle.includes(trackTitle) || 
                       trackTitle.includes(videoTitle.replace(/\(.*\)/g, '').trim());
    
    // Check title contains artist name
    const artistMatch = videoTitle.includes(trackArtist);
    
    // Check duration is reasonable (30s to 15min for music)
    const reasonableDuration = videoInfo.duration >= 30 && videoInfo.duration <= 900;
    
    // Must have reasonable duration and at least partial title match
    return reasonableDuration && (titleMatch || artistMatch);
  }

  /**
   * Resolve via user upload (direct file)
   */
  async resolveUserUpload(track, userId = null) {
    // Check if this track has a user upload
    if (track.source_type === 'upload' && track.file_path) {
      const fileExists = fs.existsSync(track.file_path);
      
      if (fileExists) {
        return {
          type: 'upload',
          url: `/audio/${path.basename(track.file_path)}`,
          embedUrl: null,
          duration: track.duration,
          quality: 'high',
          localPath: track.file_path
        };
      }
    }

    // If userId provided, check user's library for this track
    if (userId) {
      // Query database for user upload of this track
      // This would need DB access - implement when needed
    }

    return null;
  }

  /**
   * Fallback to 30-second preview
   */
  async resolvePreview(track) {
    if (track.preview_url) {
      return {
        type: 'preview',
        url: track.preview_url,
        embedUrl: null,
        duration: 30,
        quality: 'low',
        isPreview: true
      };
    }

    // Try to get preview from iTunes
    try {
      const query = `${track.title} ${track.artist}`;
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=1`;
      
      const data = await httpsGet(url);
      
      if (data.results?.[0]?.previewUrl) {
        return {
          type: 'preview',
          url: data.results[0].previewUrl,
          embedUrl: null,
          duration: 30,
          quality: 'low',
          isPreview: true
        };
      }
    } catch (err) {
      console.error('[StreamService] Preview fetch error:', err.message);
    }

    return null;
  }

  /**
   * Build embed URL based on source type
   */
  buildEmbedUrl(sourceType, streamUrl) {
    switch(sourceType) {
      case 'youtube':
        const videoId = this.extractYouTubeId(streamUrl);
        return videoId ? `https://www.youtube.com/embed/${videoId}?enablejsapi=1` : null;
      
      case 'jamendo':
        return null; // Direct MP3, no embed
      
      case 'upload':
        return null; // Direct file, no embed
      
      default:
        return null;
    }
  }

  /**
   * Extract YouTube video ID from URL
   */
  extractYouTubeId(url) {
    if (!url) return null;
    
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    
    return null;
  }

  /**
   * Get quality rating for source type
   */
  getSourceQuality(sourceType) {
    const qualityMap = {
      'jamendo': 'high',      // 320kbps MP3
      'youtube': 'high',      // AAC 128-256kbps
      'upload': 'high',     // Original quality
      'preview': 'low',     // 30-sec AAC
      'soundcloud': 'medium' // Varies
    };
    
    return qualityMap[sourceType] || 'unknown';
  }

  /**
   * Get stream info for a track (includes all available sources)
   */
  async getStreamInfo(trackId) {
    // Fetch track from DB
    // Resolve all available sources
    // Return ranked list of options
    
    // This is useful for showing user available sources
    // and letting them choose (e.g., "Play from YouTube" or "Play from Jamendo")
  }

  /**
   * Validate a stream URL (check if still accessible)
   */
  async validateStream(streamUrl, sourceType) {
    try {
      switch(sourceType) {
        case 'jamendo':
          // HEAD request to check if MP3 exists
          return await this.checkUrlExists(streamUrl);
        
        case 'youtube':
          // Check via yt-dlp or YouTube API
          const videoId = this.extractYouTubeId(streamUrl);
          if (!videoId) return false;
          
          const ytDlpPath = await findYtDlp();
          if (!ytDlpPath) return false;
          
          const checkCmd = `"${ytDlpPath}" -j "https://youtube.com/watch?v=${videoId}" --skip-download`;
          
          await execAsync(checkCmd, { timeout: 10000 });
          return true;
        
        case 'upload':
          return fs.existsSync(streamUrl);
        
        default:
          return await this.checkUrlExists(streamUrl);
      }
    } catch (err) {
      console.log(`[StreamService] Stream validation failed:`, err.message);
      return false;
    }
  }

  /**
   * Check if URL exists (returns 200)
   */
  async checkUrlExists(url) {
    return new Promise((resolve) => {
      const options = new URL(url);
      const req = https.request(options, { method: 'HEAD' }, (res) => {
        resolve(res.statusCode === 200);
      });
      
      req.on('error', () => resolve(false));
      req.setTimeout(5000, () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }
}

const streamService = new StreamService();
streamService.findYtDlp = findYtDlp;
module.exports = streamService;
