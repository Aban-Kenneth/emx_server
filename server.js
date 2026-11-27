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

let listeners = [];
let currentPlaylist = [];
let jingles = [];
let sweepers = [];
let settings = {
  jingle_after_songs: 10,
  sweeper_after_songs: 3,
  sweeper_after_minutes: 15
};
let songsPlayed = 0;
let lastSweeperTime = Date.now();
let isLive = false;

async function loadFromSupabase() {
  try {
    const { data: playlist } = await supabase
      .from('auto_playlist')
      .select('position, songs(*)')
      .order('position');

    const { data: j } = await supabase
      .from('jingles')
      .select('*')
      .eq('is_active', true);

    const { data: s } = await supabase
      .from('sweepers')
      .select('*')
      .eq('is_active', true);

    const { data: st } = await supabase
      .from('station_settings')
      .select()
      .eq('id', 1)
      .maybeSingle();

    const { data: live } = await supabase
      .from('live_status')
      .select()
      .eq('id', 1)
      .maybeSingle();

    if (playlist) currentPlaylist = playlist.map(p => p.songs).filter(Boolean);
    if (j) jingles = j;
    if (s) sweepers = s;
    if (st) settings = st;
    if (live) isLive = (live.mode === 'LIVE');
  } catch (error) {
    console.error('Error loading from Supabase:', error);
  }
}

function driveToDirect(url) {
  if (!url) return url;
  const m = url.match(/\/d\/([^\/]+)/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  return url;
}

async function djLoop() {
  await loadFromSupabase();

  if (isLive) {
    console.log('🔴 LIVE on Zeno - DJ paused');
    setTimeout(djLoop, 10000);
    return;
  }

  if (currentPlaylist.length === 0) {
    setTimeout(djLoop, 5000);
    return;
  }

  for (let i = 0; i < currentPlaylist.length; i++) {
    await loadFromSupabase();
    if (isLive) break;

    const song = currentPlaylist[i];
    songsPlayed++;

    let trackToPlay = song;
    let isJingle = false;

    if (jingles.length > 0 && songsPlayed % (settings.jingle_after_songs || 10) === 0) {
      trackToPlay = jingles[Math.floor(Math.random() * jingles.length)];
      isJingle = true;
      console.log(`▶️ JINGLE: ${trackToPlay.name}`);
    } else if (sweepers.length > 0) {
      const mins = (Date.now() - lastSweeperTime) / 60000;
      if (songsPlayed % (settings.sweeper_after_songs || 3) === 0 || mins >= (settings.sweeper_after_minutes || 15)) {
        await streamOneFile(driveToDirect(sweepers[0].drive_url), 'SWEEPER');
        lastSweeperTime = Date.now();
      }
    }

    if (!isJingle) console.log(`▶️ NOW: ${song.title} - ${song.artist}`);
    await streamOneFile(driveToDirect(trackToPlay.drive_url), trackToPlay.title || trackToPlay.name);
  }

  djLoop();
}

function streamOneFile(url, label) {
  return new Promise(async (resolve) => {
    try {
      const response = await axios.get(url, { responseType: 'stream' });
      const ffmpeg = spawn('ffmpeg', ['-i', 'pipe:0', '-f', 'mp3', '-codec:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', 'pipe:1']);
      response.data.pipe(ffmpeg.stdin);
      ffmpeg.stdout.on('data', (chunk) => {
        listeners = listeners.filter(res => {
          try {
            res.write(chunk);
            return true;
          } catch {
            return false;
          }
        });
      });
      ffmpeg.on('close', () => resolve());
      ffmpeg.stderr.on('data', () => { });
    } catch (e) {
      console.log('Error', label, e.message);
      resolve();
    }
  });
}

app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'icy-name': 'EMX Radio'
  });
  listeners.push(res);
  console.log(`Listener joined: ${listeners.length}`);
  req.on('close', () => {
    listeners = listeners.filter(r => r !== res);
  });
});

app.get('/', (req, res) => res.send('EMX Radio is ON AIR - ' + listeners.length + ' listeners'));

app.listen(PORT, () => {
  console.log(`EMX on ${PORT}`);
  djLoop();
  setInterval(loadFromSupabase, 2 * 60 * 1000);
});
