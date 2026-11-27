const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { spawn } = require('child_process');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8000;

const supabase = createClient(
  'https://vuoyjyvqoobwyhcyelgw.supabase.co',
  'sb_publishable_d5-EBdcZbCNFDe8_3sVEog_RY6BSemO'
);

// Keep all connected listeners here
let listeners = [];
let currentPlaylist = [];
let jingles = [];
let sweepers = [];
let settings = { jingle_after_songs: 10, sweeper_after_songs: 3, sweeper_after_minutes: 15 };
let songsPlayed = 0;
let lastSweeperTime = Date.now();
let isLive = false;
let liveZenoUrl = '';

async function loadFromSupabase() {
  const { data: playlist } = await supabase.from('auto_playlist').select('position, songs(*)').order('position');
  const { data: j } = await supabase.from('jingles').select().eq('is_active', true);
  const { data: s } = await supabase.from('sweepers').select().eq('is_active', true);
  const { data: st } = await supabase.from('station_settings').select().eq('id', 1).single();

  if (playlist) currentPlaylist = playlist.map(p => p.songs);
  if (j) jingles = j;
  if (s) sweepers = s;
  if (st) {
    settings = st;
    // Check if presenter is LIVE on Zeno
    if (st.live_mode === true || st.is_live === true) {
      isLive = true;
      liveZenoUrl = st.live_zeno_url || st.zeno_url || '';
    } else {
      isLive = false;
    }
  }
  console.log(`Loaded: ${currentPlaylist.length} songs, ${jingles.length} jingles, Live: ${isLive}`);
}

// Convert Drive link to direct download link
function driveToDirect(url) {
  if (!url) return url;
  const match = url.match(/\/d\/([^\/]+)/);
  if (match) return `https://drive.google.com/uc?export=download&id=${match[1]}`;
  return url;
}

// The DJ Loop - Plays forever
async function djLoop() {
  await loadFromSupabase();

  // If presenter is LIVE on Zeno, pause DJ and wait
  if (isLive) {
    console.log('🔴 LIVE on Zeno - DJ paused, waiting 10s...');
    setTimeout(djLoop, 10000);
    return;
  }

  if (currentPlaylist.length === 0) {
    console.log('No songs, waiting 5s...');
    setTimeout(djLoop, 5000);
    return;
  }

  for (let i = 0; i < currentPlaylist.length; i++) {
    // Check live again before each song
    await loadFromSupabase();
    if (isLive) break;

    const song = currentPlaylist[i];
    let trackToPlay = song;
    let isJingle = false;
    songsPlayed++;

    if (jingles.length > 0 && songsPlayed % settings.jingle_after_songs === 0) {
      trackToPlay = jingles[Math.floor(Math.random() * jingles.length)];
      isJingle = true;
      console.log(`▶️ JINGLE: ${trackToPlay.name} (after ${songsPlayed} songs)`);
    } else if (sweepers.length > 0) {
      const minsSinceSweeper = (Date.now() - lastSweeperTime) / 60000;
      if (songsPlayed % settings.sweeper_after_songs === 0 || minsSinceSweeper >= settings.sweeper_after_minutes) {
        await streamOneFile(driveToDirect(sweepers[0].drive_url), `SWEEPER: ${sweepers[0].name}`);
        lastSweeperTime = Date.now();
      }
    }

    if (!isJingle) console.log(`▶️ NOW PLAYING: ${song.title} - ${song.artist}`);
    await streamOneFile(driveToDirect(trackToPlay.drive_url), trackToPlay.title || trackToPlay.name);
  }
  // Loop forever
  djLoop();
}

// Stream ONE file to ALL listeners using ffmpeg
function streamOneFile(url, label) {
  return new Promise(async (resolve) => {
    try {
      const response = await axios.get(url, { responseType: 'stream' });
      const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',
        '-f', 'mp3',
        '-codec:a', 'libmp3lame',
        '-b:a', '128k',
        '-ar', '44100',
        'pipe:1'
      ]);

      response.data.pipe(ffmpeg.stdin);

      ffmpeg.stdout.on('data', (chunk) => {
        // Send same chunk to EVERY listener at same time = REAL RADIO
        listeners = listeners.filter(res => {
          try { res.write(chunk); return true; } catch { return false; }
        });
      });

      ffmpeg.on('close', () => resolve());
      ffmpeg.stderr.on('data', () => {});
    } catch (e) {
      console.log('Error playing', label, e.message);
      resolve();
    }
  });
}

// Listener tunes in here - joins MID-SONG
app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'icy-name': 'EMX Radio',
    'icy-genre': 'Afrobeat',
  });
  listeners.push(res);
  console.log(`Listener joined. Total: ${listeners.length}`);
  req.on('close', () => {
    listeners = listeners.filter(r => r !== res);
    console.log(`Listener left. Total: ${listeners.length}`);
  });
});

// Flutter apps check this to know if LIVE or AUTO
app.get('/status', async (req, res) => {
  await loadFromSupabase();
  res.json({
    live: isLive,
    zeno_url: liveZenoUrl,
    listeners: listeners.length,
    songs_played: songsPlayed
  });
});

app.get('/', (req, res) => res.send('EMX Radio is ON AIR - ' + listeners.length + ' listeners'));

app.listen(PORT, () => {
  console.log(`EMX Radio Server on ${PORT}`);
  djLoop();
  // Reload playlist every 2 minutes so Admin changes apply without restart
  setInterval(loadFromSupabase, 2 * 60 * 1000);
});
