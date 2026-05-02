#!/usr/bin/env node
/**
 * Download Diagnostic Tool
 * Tests the full download pipeline to identify issues
 */

const streamService = require('../services/streamService');
const downloadService = require('../services/downloadService');

const TEST_TRACK = {
  id: 'test-track-123',
  title: 'Never Gonna Give You Up',
  artist: 'Rick Astley',
  album: 'Whenever You Need Somebody',
  duration: 213,
  preview_url: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview71/v4/3e/2e/0e/3e2e0e53-77ef-27c9-83b1-9d8f9df1f5e9/mzaf_8632342034336184461.plus.aac.p.m4a',
  external_ids: {}
};

async function diagnose() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         SOUNDY Download Diagnostic Tool                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Step 1: Check yt-dlp
  console.log('📦 STEP 1: Checking yt-dlp installation...\n');
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    const ytDlpPath = await streamService.findYtDlp?.() || await findYtDlpFallback(execAsync);
    
    if (ytDlpPath) {
      console.log('✅ yt-dlp found at:', ytDlpPath);
      const { stdout } = await execAsync(`"${ytDlpPath}" --version`);
      console.log('   Version:', stdout.trim());
    } else {
      console.log('❌ yt-dlp NOT found');
      console.log('   Searched locations:');
      console.log('   - %USERPROFILE%\\yt-dlp.exe');
      console.log('   - %USERPROFILE%\\yt-dlp');
      console.log('   - %LOCALAPPDATA%\\Microsoft\\WindowsApps\\yt-dlp.exe');
      console.log('   - PATH environment variable');
      console.log('\n🔧 Fix: Download yt-dlp.exe and save to your user folder\n');
    }
  } catch (err) {
    console.log('❌ Error checking yt-dlp:', err.message);
  }

  // Step 2: Test stream resolution
  console.log('\n📡 STEP 2: Testing stream resolution...\n');
  console.log('   Test track:', TEST_TRACK.title, 'by', TEST_TRACK.artist);
  
  try {
    const stream = await streamService.resolveStream(TEST_TRACK);
    
    if (stream) {
      console.log('✅ Stream resolved!');
      console.log('   Source:', stream.type);
      console.log('   Quality:', stream.quality);
      console.log('   URL:', stream.url?.substring(0, 60) + '...');
      
      if (stream.type === 'preview') {
        console.log('\n⚠️  Only 30-second preview available');
        console.log('   This means yt-dlp either:');
        console.log('   - Was not found');
        console.log('   - Could not find the full song on YouTube');
        console.log('   - Encountered an error during search');
      } else if (stream.type === 'youtube') {
        console.log('\n✅ Full YouTube video found!');
        console.log('   Video ID:', stream.videoId);
      }
    } else {
      console.log('❌ No stream found at all');
    }
  } catch (err) {
    console.log('❌ Stream resolution failed:', err.message);
    console.log('   Stack:', err.stack?.substring(0, 200));
  }

  // Step 3: Check download directories
  console.log('\n📁 STEP 3: Checking download directories...\n');
  const path = require('path');
  const fs = require('fs');
  const DOWNLOADS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, 'SoundyDownloads');
  
  if (fs.existsSync(DOWNLOADS_DIR)) {
    console.log('✅ Downloads directory exists:', DOWNLOADS_DIR);
    const files = fs.readdirSync(DOWNLOADS_DIR);
    console.log('   Files:', files.length);
    files.slice(0, 5).forEach(f => console.log('   -', f));
  } else {
    console.log('❌ Downloads directory does not exist:', DOWNLOADS_DIR);
    console.log('   It will be created when you download your first song');
  }

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                      SUMMARY                            ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  
  console.log('If yt-dlp is installed but downloads are still only 30-second previews:');
  console.log('1. Check backend console for error messages during search');
  console.log('2. Try running: cd backend && npm run check-ytdlp');
  console.log('3. Restart the backend server after installing yt-dlp');
  console.log('\n');
}

// Fallback yt-dlp finder
async function findYtDlpFallback(execAsync) {
  const path = require('path');
  const fs = require('fs');
  
  const possiblePaths = [
    path.join(process.env.USERPROFILE || process.env.HOME, 'yt-dlp.exe'),
    path.join(process.env.USERPROFILE || process.env.HOME, 'yt-dlp'),
    'yt-dlp.exe',
    'yt-dlp'
  ];
  
  for (const ytdlpPath of possiblePaths) {
    try {
      if (ytdlpPath.includes('/') || ytdlpPath.includes('\\')) {
        if (!fs.existsSync(ytdlpPath)) continue;
      }
      await execAsync(`"${ytdlpPath}" --version`, { timeout: 5000 });
      return ytdlpPath;
    } catch (err) {
      // Continue
    }
  }
  return null;
}

diagnose().catch(console.error);
