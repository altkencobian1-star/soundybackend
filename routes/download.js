/**
 * Download Progress API Routes
 * Real-time download progress tracking and status
 */

const express = require('express');
const downloadProgress = require('../services/downloadProgress');
const downloadService = require('../services/downloadService');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/download/progress/:trackId
 * Get download progress for a specific track
 */
router.get('/progress/:trackId', authMiddleware, (req, res) => {
  const { trackId } = req.params;
  const userId = req.userId;
  
  const progress = downloadProgress.getProgress(trackId);
  
  if (!progress) {
    return res.status(404).json({ 
      error: 'Download not found',
      trackId 
    });
  }
  
  // Only return progress for the requesting user
  if (progress.userId !== userId) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  res.json({
    trackId,
    status: progress.status,
    progress: progress.progress,
    downloadedBytes: progress.downloadedBytes,
    totalBytes: progress.totalBytes,
    speed: progress.speed,
    message: progress.message,
    error: progress.error,
    fallback: progress.fallback,
    startedAt: progress.startedAt,
    updatedAt: progress.updatedAt,
    completedAt: progress.completedAt
  });
});

/**
 * GET /api/download/progress
 * Get all active downloads for current user
 */
router.get('/progress', authMiddleware, (req, res) => {
  const userId = req.userId;
  const downloads = downloadProgress.getUserDownloads(userId);
  
  res.json({
    downloads: downloads.map(d => ({
      trackId: d.trackId,
      track: {
        title: d.track?.title,
        artist: d.track?.artist,
        cover_url: d.track?.cover_url
      },
      status: d.status,
      progress: d.progress,
      downloadedBytes: d.downloadedBytes,
      totalBytes: d.totalBytes,
      speed: d.speed,
      message: d.message,
      error: d.error,
      startedAt: d.startedAt,
      updatedAt: d.updatedAt
    }))
  });
});

/**
 * GET /api/download/active
 * Get all currently active downloads (for admin/debug)
 */
router.get('/active', authMiddleware, (req, res) => {
  // Could add admin check here
  const active = downloadProgress.getActiveDownloads();
  
  res.json({
    count: active.length,
    downloads: active.map(d => ({
      trackId: d.trackId,
      userId: d.userId,
      status: d.status,
      progress: d.progress,
      speed: d.speed,
      startedAt: d.startedAt
    }))
  });
});

/**
 * DELETE /api/download/cancel/:trackId
 * Cancel an active download
 */
router.delete('/cancel/:trackId', authMiddleware, (req, res) => {
  const { trackId } = req.params;
  const userId = req.userId;
  
  const progress = downloadProgress.getProgress(trackId);
  
  if (!progress) {
    return res.status(404).json({ error: 'Download not found' });
  }
  
  if (progress.userId !== userId) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  const cancelled = downloadService.cancelDownload(trackId);
  
  if (cancelled) {
    downloadProgress.removeDownload(trackId);
    res.json({ 
      success: true, 
      message: 'Download cancelled',
      trackId 
    });
  } else {
    res.status(400).json({ 
      error: 'Could not cancel download',
      trackId 
    });
  }
});

module.exports = router;
