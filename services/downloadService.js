/**
 * Download Service
 * Downloads audio from stream sources, encrypts, and stores for offline use
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const downloadProgress = require('./downloadProgress');

// Cache for yt-dlp path
let cachedYtDlpPath = null;

/**
 * Find yt-dlp executable across multiple locations
 */
async function findYtDlp() {
  if (cachedYtDlpPath) return cachedYtDlpPath;
  
  const possiblePaths = [
    process.env.YTDLP_PATH,
    path.join(process.env.USERPROFILE || process.env.HOME, 'yt-dlp.exe'),
    path.join(process.env.USERPROFILE || process.env.HOME, 'yt-dlp'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'yt-dlp.exe'),
    path.join(process.env.HOME || '', '.local', 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp.exe',
    'yt-dlp'
  ].filter(Boolean);
  
  for (const ytdlpPath of possiblePaths) {
    try {
      if (ytdlpPath.includes('/') || ytdlpPath.includes('\\')) {
        if (!fs.existsSync(ytdlpPath)) continue;
      }
      await execAsync(`"${ytdlpPath}" --version`, { timeout: 5000 });
      cachedYtDlpPath = ytdlpPath;
      console.log('[DownloadService] Found yt-dlp at:', ytdlpPath);
      return ytdlpPath;
    } catch (err) {
      // Continue to next path
    }
  }
  
  return null;
}

// Encryption settings
const ALGORITHM = 'aes-256-gcm';
const KEY_DERIVATION = 'sha256';
const ITERATIONS = 100000;
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;

// Download storage path
const DOWNLOADS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, 'SoundyDownloads');

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

class DownloadService {
  constructor() {
    this.activeDownloads = new Map(); // trackId -> abort controller
  }

  /**
   * Derive encryption key from user password/device ID
   */
  deriveKey(password, salt) {
    return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, KEY_DERIVATION);
  }

  /**
   * Encrypt audio file
   */
  encryptFile(inputPath, outputPath, password) {
    return new Promise((resolve, reject) => {
      try {
        // Generate random salt and IV
        const salt = crypto.randomBytes(SALT_LENGTH);
        const iv = crypto.randomBytes(IV_LENGTH);
        const key = this.deriveKey(password, salt);

        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        const inputStream = fs.createReadStream(inputPath);
        const outputStream = fs.createWriteStream(outputPath);

        // Write salt and IV at the beginning
        outputStream.write(salt);
        outputStream.write(iv);

        inputStream.pipe(cipher).pipe(outputStream);

        outputStream.on('finish', () => {
          resolve({
            encryptedPath: outputPath,
            originalSize: fs.statSync(inputPath).size,
            encryptedSize: fs.statSync(outputPath).size
          });
        });

        outputStream.on('error', reject);
        inputStream.on('error', reject);
        cipher.on('error', reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Decrypt audio file for playback
   */
  decryptFile(encryptedPath, outputPath, password) {
    return new Promise((resolve, reject) => {
      try {
        // Read salt and IV from file
        const fd = fs.openSync(encryptedPath, 'r');
        const salt = Buffer.alloc(SALT_LENGTH);
        const iv = Buffer.alloc(IV_LENGTH);
        
        fs.readSync(fd, salt, 0, SALT_LENGTH, 0);
        fs.readSync(fd, iv, 0, IV_LENGTH, SALT_LENGTH);
        fs.closeSync(fd);

        const key = this.deriveKey(password, salt);
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

        const inputStream = fs.createReadStream(encryptedPath, {
          start: SALT_LENGTH + IV_LENGTH // Skip salt and IV
        });
        const outputStream = fs.createWriteStream(outputPath);

        inputStream.pipe(decipher).pipe(outputStream);

        outputStream.on('finish', () => resolve(outputPath));
        outputStream.on('error', reject);
        inputStream.on('error', reject);
        decipher.on('error', reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Get encryption password (user-specific)
   */
  getEncryptionPassword(userId) {
    // Combine user ID with app secret for unique per-user encryption
    const appSecret = process.env.APP_SECRET || 'soundy-secret-key-2024';
    return crypto.createHash('sha256')
      .update(`${userId}:${appSecret}`)
      .digest('hex');
  }

  /**
   * Download audio from URL (Jamendo direct MP3)
   */
  async downloadFromUrl(url, outputPath, onProgress) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(outputPath);
      let downloaded = 0;
      let total = 0;

      protocol.get(url, { timeout: 60000 }, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        total = parseInt(response.headers['content-length'] || '0');
        
        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0 && onProgress) {
            const percent = Math.round((downloaded / total) * 100);
            onProgress(percent, downloaded, total);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve({
            path: outputPath,
            size: downloaded,
            total
          });
        });
      }).on('error', (err) => {
        fs.unlink(outputPath, () => {});
        reject(err);
      });
    });
  }

  /**
   * Download audio from YouTube using yt-dlp with real-time progress
   * Uses bestaudio format without ffmpeg requirement
   */
  async downloadFromYouTube(videoId, outputPath, trackId, onProgress) {
    const ytDlpPath = await findYtDlp();
    
    if (!ytDlpPath) {
      throw new Error('yt-dlp not found. Please install yt-dlp to download full songs.');
    }
    
    // Create temp directory if needed
    const tempDir = path.dirname(outputPath);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const outputTemplate = outputPath.replace('.encrypted', '');
    const videoUrl = `https://youtube.com/watch?v=${videoId}`;
    
    console.log('[DownloadService] Downloading from YouTube:', videoId);
    downloadProgress.updateStatus(trackId, 'downloading', 'Starting YouTube download...');
    
    return new Promise((resolve, reject) => {
      // Use spawn for real-time progress parsing
      // --newline ensures each progress update is on a new line
      // --progress-template gives us the data we need
      const args = [
        '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
        '--no-playlist',
        '--newline',
        '--progress-template', 'download:%(progress._percent_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._speed_str)s',
        '-o', `${outputTemplate}.%(ext)s`,
        videoUrl
      ];
      
      console.log('[DownloadService] Spawning yt-dlp:', ytDlpPath, args.join(' '));
      
      const process = spawn(`"${ytDlpPath}"`, args, { 
        shell: true,
        windowsHide: true
      });
      
      let lastPercent = 0;
      let downloadedBytes = 0;
      let totalBytes = 0;
      let speed = '0';
      let errorOutput = '';
      
      process.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        
        for (const line of lines) {
          // Parse progress line: "download: 45.3%|12.5MiB|27.6MiB|2.5MiB/s"
          if (line.includes('download:')) {
            const match = line.match(/download:\s*(\S+)%?\|(\S+)\|(\S+)\|(\S+)/);
            if (match) {
              const [, percentStr, downloadedStr, totalStr, speedStr] = match;
              lastPercent = parseFloat(percentStr) || 0;
              
              // Parse bytes
              const parseBytes = (str) => {
                if (!str) return 0;
                const num = parseFloat(str);
                if (str.includes('GiB')) return num * 1024 * 1024 * 1024;
                if (str.includes('MiB')) return num * 1024 * 1024;
                if (str.includes('KiB')) return num * 1024;
                return num;
              };
              
              downloadedBytes = parseBytes(downloadedStr);
              totalBytes = parseBytes(totalStr);
              speed = speedStr || '0';
              
              // Update progress tracker
              downloadProgress.updateProgress(trackId, lastPercent, downloadedBytes, totalBytes, speed);
              onProgress?.(lastPercent, downloadedBytes, totalBytes, speed);
              
              console.log(`[DownloadService] Progress: ${lastPercent.toFixed(1)}% (${downloadedStr} / ${totalStr}) @ ${speedStr}`);
            }
          }
        }
      });
      
      process.stderr.on('data', (data) => {
        errorOutput += data.toString();
        // Some yt-dlp versions output progress to stderr
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.includes('%') && line.includes('of')) {
            // Parse: "  5.0% of   27.6MiB at    2.5MiB/s ETA 00:10"
            const match = line.match(/(\d+\.?\d*)%\s+of\s+(\S+)\s+at\s+(\S+)/);
            if (match) {
              const [, percentStr, totalStr, speedStr] = match;
              lastPercent = parseFloat(percentStr);
              speed = speedStr;
              downloadProgress.updateProgress(trackId, lastPercent, downloadedBytes, totalBytes, speed);
            }
          }
        }
      });
      
      process.on('close', (code) => {
        if (code !== 0) {
          console.error('[DownloadService] yt-dlp exited with code:', code);
          console.error('[DownloadService] Error output:', errorOutput.slice(-1000));
          reject(new Error(`Download failed (code ${code}). ${errorOutput.slice(-500)}`));
          return;
        }
        
        // Find the downloaded file
        const possibleExtensions = ['.m4a', '.webm', '.mp4', '.mp3', '.ogg'];
        let downloadedPath = null;
        
        for (const ext of possibleExtensions) {
          const testPath = `${outputTemplate}${ext}`;
          if (fs.existsSync(testPath)) {
            downloadedPath = testPath;
            break;
          }
        }
        
        if (!downloadedPath) {
          reject(new Error('Download failed - output file not found'));
          return;
        }
        
        console.log('[DownloadService] ✓ Downloaded:', downloadedPath);
        const stats = fs.statSync(downloadedPath);
        
        downloadProgress.updateProgress(trackId, 100, stats.size, stats.size, '0');
        onProgress?.(100, stats.size, stats.size, '0');
        
        resolve({
          path: downloadedPath,
          size: stats.size,
          format: path.extname(downloadedPath).slice(1)
        });
      });
      
      process.on('error', (err) => {
        reject(new Error(`Failed to start yt-dlp: ${err.message}`));
      });
    });
  }

  /**
   * Main download function
   * Downloads full tracks only - rejects 30-second previews
   */
  async downloadTrack(track, userId, onProgress) {
    const trackId = track.id;
    const abortController = new AbortController();
    this.activeDownloads.set(trackId, abortController);

    // Initialize progress tracking
    downloadProgress.startDownload(trackId, track, userId);

    try {
      console.log(`[DownloadService] Starting download for: ${track.title}`);
      console.log(`[DownloadService] Source type: ${track.source_type}`);
      console.log(`[DownloadService] External IDs:`, track.external_ids);
      
      // Reject preview-only tracks
      if (track.source_type === 'preview' || track.isPreview) {
        throw new Error('Cannot download 30-second preview. Full track not available.');
      }
      
      // Don't use preview_url as a fallback
      if (!track.stream_url && !track.external_ids?.youtube && !track.external_ids?.jamendo) {
        throw new Error('No full-track source available for download');
      }
      
      // Determine source and download method
      const sourceType = track.source_type;
      const tempDir = path.join(DOWNLOADS_DIR, 'temp');
      
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const tempPath = path.join(tempDir, `${trackId}.temp`);
      let downloadResult;

      // Download based on source (in priority order)
      if (track.external_ids?.youtube) {
        // YouTube full video download (best quality)
        console.log('[DownloadService] Downloading from YouTube:', track.external_ids.youtube);
        onProgress?.(10, 0, 100);
        downloadResult = await this.downloadFromYouTube(
          track.external_ids.youtube,
          tempPath,
          trackId,
          onProgress
        );
        console.log('[DownloadService] YouTube download complete:', downloadResult.path, downloadResult.size);
      } else if (sourceType === 'jamendo' && track.stream_url) {
        // Direct MP3 download from Jamendo (Creative Commons)
        console.log('[DownloadService] Downloading from Jamendo:', track.stream_url);
        onProgress?.(10, 0, 100);
        downloadResult = await this.downloadFromUrl(
          track.stream_url, 
          tempPath,
          onProgress
        );
        console.log('[DownloadService] Jamendo download complete:', downloadResult.path, downloadResult.size);
      } else if (track.stream_url) {
        // Generic direct URL (should be full track)
        console.log('[DownloadService] Downloading from direct URL:', track.stream_url);
        onProgress?.(10, 0, 100);
        downloadResult = await this.downloadFromUrl(
          track.stream_url,
          tempPath,
          onProgress
        );
        console.log('[DownloadService] Direct download complete:', downloadResult.path, downloadResult.size);
      } else {
        throw new Error('No downloadable source available - only 30-second preview found');
      }

      if (abortController.signal.aborted) {
        throw new Error('Download cancelled');
      }

      // Encrypt the file
      const encryptedPath = path.join(DOWNLOADS_DIR, `${trackId}.encrypted`);
      const password = this.getEncryptionPassword(userId);
      
      console.log('[DownloadService] Encrypting file...');
      onProgress?.(95, downloadResult.size, downloadResult.size);
      
      const encryptResult = await this.encryptFile(
        downloadResult.path,
        encryptedPath,
        password
      );

      // Clean up temp file
      fs.unlink(downloadResult.path, (err) => {
        if (err) console.error('Failed to clean up temp file:', err);
      });

      console.log('[DownloadService] Download complete:', encryptedPath);
      
      const result = {
        success: true,
        trackId: track.id,
        encryptedPath,
        originalSize: encryptResult.originalSize,
        encryptedSize: encryptResult.encryptedSize,
        downloadPath: `/offline/${trackId}.encrypted`
      };
      
      // Mark as complete in progress tracker
      downloadProgress.completeDownload(trackId, result);
      
      return result;

    } catch (err) {
      console.error('[DownloadService] Download failed:', err);
      
      // Check if we should provide preview fallback
      const fallback = track.preview_url ? {
        type: 'preview',
        url: track.preview_url,
        note: '30-second preview - full download failed'
      } : null;
      
      // Mark as failed in progress tracker
      downloadProgress.failDownload(trackId, err.message, fallback);
      
      throw err;
    } finally {
      this.activeDownloads.delete(trackId);
    }
  }

  /**
   * Cancel an active download
   */
  cancelDownload(trackId) {
    const controller = this.activeDownloads.get(trackId);
    if (controller) {
      controller.abort();
      this.activeDownloads.delete(trackId);
      return true;
    }
    return false;
  }

  /**
   * Get download info for a track
   */
  getDownloadInfo(trackId, userId) {
    const encryptedPath = path.join(DOWNLOADS_DIR, `${trackId}.encrypted`);
    
    if (!fs.existsSync(encryptedPath)) {
      return null;
    }

    const stats = fs.statSync(encryptedPath);
    return {
      trackId,
      encryptedPath,
      size: stats.size,
      createdAt: stats.birthtime,
      isAvailable: true
    };
  }

  /**
   * Prepare track for offline playback (decrypt to temp)
   */
  async prepareForPlayback(trackId, userId) {
    const encryptedPath = path.join(DOWNLOADS_DIR, `${trackId}.encrypted`);
    
    if (!fs.existsSync(encryptedPath)) {
      throw new Error('Downloaded file not found');
    }

    // Decrypt to temp file for playback
    const tempPlaybackPath = path.join(
      DOWNLOADS_DIR, 
      'temp', 
      `${trackId}_playback.mp3`
    );
    
    const password = this.getEncryptionPassword(userId);
    
    console.log('[DownloadService] Decrypting for playback:', trackId);
    await this.decryptFile(encryptedPath, tempPlaybackPath, password);
    
    return tempPlaybackPath;
  }

  /**
   * Clean up temp playback file
   */
  cleanupPlaybackFile(trackId) {
    const tempPath = path.join(DOWNLOADS_DIR, 'temp', `${trackId}_playback.mp3`);
    if (fs.existsSync(tempPath)) {
      fs.unlink(tempPath, (err) => {
        if (err) console.error('Failed to cleanup playback file:', err);
      });
    }
  }

  /**
   * Delete downloaded track
   */
  async deleteDownload(trackId) {
    const encryptedPath = path.join(DOWNLOADS_DIR, `${trackId}.encrypted`);
    
    if (fs.existsSync(encryptedPath)) {
      fs.unlinkSync(encryptedPath);
    }

    // Clean up any temp files
    this.cleanupPlaybackFile(trackId);
    
    return true;
  }

  /**
   * Get all downloaded tracks for user
   */
  getUserDownloads(userId) {
    try {
      const files = fs.readdirSync(DOWNLOADS_DIR);
      const downloads = files
        .filter(f => f.endsWith('.encrypted'))
        .map(f => {
          const trackId = f.replace('.encrypted', '');
          const stats = fs.statSync(path.join(DOWNLOADS_DIR, f));
          return {
            trackId,
            size: stats.size,
            downloadedAt: stats.birthtime
          };
        });
      
      return downloads;
    } catch (err) {
      console.error('[DownloadService] Failed to list downloads:', err);
      return [];
    }
  }

  /**
   * Get total storage used
   */
  getStorageStats() {
    try {
      const files = fs.readdirSync(DOWNLOADS_DIR);
      let totalSize = 0;
      let fileCount = 0;

      files.filter(f => f.endsWith('.encrypted')).forEach(f => {
        const stats = fs.statSync(path.join(DOWNLOADS_DIR, f));
        totalSize += stats.size;
        fileCount++;
      });

      return {
        totalSize,
        fileCount,
        formattedSize: this.formatBytes(totalSize)
      };
    } catch (err) {
      return { totalSize: 0, fileCount: 0, formattedSize: '0 B' };
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

module.exports = new DownloadService();
