/**
 * Download Progress Tracker
 * Manages real-time download progress using EventEmitter
 */

const EventEmitter = require('events');

class DownloadProgressTracker extends EventEmitter {
  constructor() {
    super();
    this.downloads = new Map(); // trackId -> progress info
    this.MAX_AGE = 1000 * 60 * 60; // 1 hour - clean up old entries
    
    // Clean up old entries periodically
    setInterval(() => this.cleanup(), 1000 * 60 * 5); // Every 5 minutes
  }

  /**
   * Start tracking a new download
   */
  startDownload(trackId, trackInfo, userId) {
    const download = {
      trackId,
      userId,
      track: trackInfo,
      status: 'starting',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speed: 0,
      error: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null
    };
    
    this.downloads.set(trackId, download);
    this.emit('downloadStarted', download);
    return download;
  }

  /**
   * Update download progress
   */
  updateProgress(trackId, progress, downloadedBytes, totalBytes, speed = 0) {
    const download = this.downloads.get(trackId);
    if (!download) return;

    download.status = 'downloading';
    download.progress = Math.min(100, Math.max(0, progress));
    download.downloadedBytes = downloadedBytes;
    download.totalBytes = totalBytes;
    download.speed = speed;
    download.updatedAt = Date.now();

    this.emit('progress', { ...download });
  }

  /**
   * Update status message (for debugging/info)
   */
  updateStatus(trackId, status, message = '') {
    const download = this.downloads.get(trackId);
    if (!download) return;

    download.status = status;
    download.message = message;
    download.updatedAt = Date.now();

    this.emit('status', { ...download });
  }

  /**
   * Mark download as completed
   */
  completeDownload(trackId, result) {
    const download = this.downloads.get(trackId);
    if (!download) return;

    download.status = 'completed';
    download.progress = 100;
    download.completedAt = Date.now();
    download.result = result;
    download.updatedAt = Date.now();

    this.emit('completed', { ...download });
  }

  /**
   * Mark download as failed
   */
  failDownload(trackId, error, fallback = null) {
    const download = this.downloads.get(trackId);
    if (!download) return;

    download.status = 'failed';
    download.error = error;
    download.fallback = fallback; // Preview fallback info
    download.updatedAt = Date.now();

    this.emit('failed', { ...download });
  }

  /**
   * Get download progress
   */
  getProgress(trackId) {
    return this.downloads.get(trackId) || null;
  }

  /**
   * Get all active downloads for a user
   */
  getUserDownloads(userId) {
    const userDownloads = [];
    for (const download of this.downloads.values()) {
      if (download.userId === userId) {
        userDownloads.push({ ...download });
      }
    }
    return userDownloads;
  }

  /**
   * Check if download exists
   */
  hasDownload(trackId) {
    return this.downloads.has(trackId);
  }

  /**
   * Remove a download entry
   */
  removeDownload(trackId) {
    this.downloads.delete(trackId);
  }

  /**
   * Clean up old entries
   */
  cleanup() {
    const now = Date.now();
    let removed = 0;
    
    for (const [trackId, download] of this.downloads.entries()) {
      // Remove completed/failed downloads older than MAX_AGE
      if ((download.status === 'completed' || download.status === 'failed') && 
          (now - download.updatedAt > this.MAX_AGE)) {
        this.downloads.delete(trackId);
        removed++;
      }
    }
    
    if (removed > 0) {
      console.log(`[DownloadProgress] Cleaned up ${removed} old downloads`);
    }
  }

  /**
   * Get all active downloads
   */
  getActiveDownloads() {
    const active = [];
    for (const download of this.downloads.values()) {
      if (download.status === 'downloading' || download.status === 'starting') {
        active.push({ ...download });
      }
    }
    return active;
  }
}

// Export singleton instance
module.exports = new DownloadProgressTracker();
