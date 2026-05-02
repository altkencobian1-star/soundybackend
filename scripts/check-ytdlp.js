#!/usr/bin/env node
/**
 * yt-dlp Setup Checker
 * Run this to verify yt-dlp is properly installed
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const YTDLP_PATHS = [
  path.join(process.env.USERPROFILE || process.env.HOME, 'yt-dlp.exe'),
  path.join(process.env.USERPROFILE || process.env.HOME, 'yt-dlp'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'yt-dlp.exe'),
  'yt-dlp',
  'yt-dlp.exe'
];

function execPromise(command) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

async function findYtDlp() {
  console.log('🔍 Checking for yt-dlp...\n');
  
  for (const ytdlpPath of YTDLP_PATHS) {
    try {
      if (ytdlpPath.includes('/') || ytdlpPath.includes('\\')) {
        // Check if file exists for absolute paths
        if (!fs.existsSync(ytdlpPath)) continue;
      }
      
      const { stdout } = await execPromise(`"${ytdlpPath}" --version`);
      console.log('✅ yt-dlp found!');
      console.log(`   Location: ${ytdlpPath}`);
      console.log(`   Version: ${stdout.trim()}\n`);
      return ytdlpPath;
    } catch (err) {
      // Continue to next path
    }
  }
  
  return null;
}

function printInstallInstructions() {
  console.log('❌ yt-dlp NOT found\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📥 INSTALLATION INSTRUCTIONS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  console.log('OPTION 1: Download Executable (Easiest)');
  console.log('──────────────────────────────────────────');
  console.log('1. Go to: https://github.com/yt-dlp/yt-dlp/releases');
  console.log('2. Download: yt-dlp.exe (for Windows)');
  console.log('3. Save it to your user folder:');
  console.log(`   ${process.env.USERPROFILE || '%USERPROFILE%'}\\yt-dlp.exe\n`);
  
  console.log('OPTION 2: Using Python pip');
  console.log('──────────────────────────────────────────');
  console.log('Run: pip install yt-dlp\n');
  
  console.log('OPTION 3: Using Chocolatey (Windows)');
  console.log('──────────────────────────────────────────');
  console.log('Run: choco install yt-dlp\n');
  
  console.log('OPTION 4: Using Winget (Windows 10/11)');
  console.log('──────────────────────────────────────────');
  console.log('Run: winget install yt-dlp\n');
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🧪 TESTING AFTER INSTALLATION');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('1. Open a NEW terminal window');
  console.log('2. Run: yt-dlp --version');
  console.log('3. Should show version number (like 2024.04.09)\n');
  
  console.log('⚠️  IMPORTANT: Restart your backend server after installing yt-dlp!\n');
}

async function testDownload() {
  console.log('🧪 Testing yt-dlp download capability...\n');
  
  const ytdlpPath = await findYtDlp();
  if (!ytdlpPath) {
    printInstallInstructions();
    return false;
  }
  
  // Quick test - get info for a test video
  console.log('Testing YouTube access (this may take 10-30 seconds)...');
  try {
    const testCmd = `"${ytdlpPath}" -j "ytsearch1:test audio" --skip-download`;
    const { stdout } = await execPromise(testCmd);
    const videoInfo = JSON.parse(stdout);
    
    console.log('✅ YouTube search working!');
    console.log(`   Found: "${videoInfo.title}"\n`);
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✨ yt-dlp is ready to use!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Features now available:');
    console.log('  • Full song downloads from YouTube');
    console.log('  • High-quality audio streaming');
    console.log('  • Offline playback of full tracks\n');
    
    return true;
  } catch (err) {
    console.log('⚠️  yt-dlp found but YouTube test failed');
    console.log(`   Error: ${err.message}\n`);
    console.log('This might be due to:');
    console.log('  • Network restrictions');
    console.log('  • YouTube rate limiting');
    console.log('  • Outdated yt-dlp version');
    console.log('\nTry updating yt-dlp: yt-dlp -U\n');
    return false;
  }
}

// Run check
testDownload().then(success => {
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error('Check failed:', err);
  process.exit(1);
});
