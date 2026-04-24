const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;

const app = express();
const session = require('express-session');
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
// trust proxy when running behind Vercel / other proxies so secure cookies work
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
// session for OpenID linking
const sessionOptions = {
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // require HTTPS in prod
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
};
app.use(session(sessionOptions));

// Initialize Passport (for Steam OpenID)
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Configure Steam strategy
passport.use(new SteamStrategy({
  returnURL: process.env.STEAM_RETURN_URL || 'https://stimprivyazka.vercel.app/auth/steam/return',
  realm: process.env.STEAM_REALM || 'https://stimprivyazka.vercel.app/',
  apiKey: process.env.STEAM_API_KEY
}, (identifier, profile, done) => {
  profile.identifier = identifier;
  return done(null, profile);
}));

// Store incoming Firebase ID token in session to associate with upcoming OpenID flow
app.post('/initLink', async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).send('No token');
    // Save token in session for later use in OpenID callback
    req.session.firebaseToken = idToken;
    return res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    return res.status(500).send('Internal Server Error');
  }
});

// Passport routes for Steam (using passport-steam)
app.get('/auth/steam', passport.authenticate('steam'));

app.get('/auth/steam/return',
  passport.authenticate('steam', { failureRedirect: '/' }),
  async (req, res) => {
    try {
      // req.user contains steam profile
      const steamProfile = req.user;
      // Get firebase token from session (initLink should have set it)
      const idToken = req.session && (req.session.firebaseToken || req.session.idToken);
      if (!idToken) {
        console.warn('No firebase token in session');
        return res.send('<html><body>Missing firebase token. Close this window.</body></html>');
      }
      // verify firebase token to get uid
      if (!admin) return res.status(500).send('Server not configured');
      const decoded = await admin.auth().verifyIdToken(idToken);
      const uid = decoded.uid;

      // fetch additional Steam data (owned games, summaries)
      const steamidMatch = (steamProfile && steamProfile._json && steamProfile._json.steamid) || steamProfile.identifier && steamProfile.identifier.match(/(\d+)$/)[1];
      const steamid = steamidMatch;
      const psR = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${encodeURIComponent(steamid)}`);
      const ps = await psR.json();
      const player = ps.response.players && ps.response.players[0];
      const ogR = await fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${encodeURIComponent(steamid)}&include_appinfo=1&include_played_free_games=1`);
      const og = await ogR.json();
      const gamesArr = (og.response && og.response.games) || [];
      const games = {};
      let totalMinutes = 0;
      gamesArr.forEach(g => { totalMinutes += (g.playtime_forever || 0); games[g.appid] = { appid: g.appid, name: g.name, playtime: g.playtime_forever || 0, playtime_hours: Math.round((g.playtime_forever||0)/60) }; });
      const totalHours = Math.round(totalMinutes / 60);
      const timecreated = player?.timecreated || null;
      const cs = games[730];
      const cs_hours = cs ? cs.playtime_hours : 0;
      let hasPrime = false;
      try {
        const achRes = await fetch(`https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?key=${STEAM_KEY}&steamid=${steamid}&appid=730`);
        const achJson = await achRes.json();
        if (achJson.playerstats && !achJson.playerstats.error) hasPrime = true;
      } catch (e) {}

      const steamInfo = { steamId: steamid, persona: player?.personaname || null, avatar: player?.avatarfull || player?.avatar || null, games, totalHours, timecreated, cs_hours, hasPrime, fetchedAt: Date.now() };

      const db = admin.firestore();
      await db.collection('users').doc(uid).set({ steam: steamInfo }, { merge: true });

      return res.send('<html><body><script>window.opener && window.opener.postMessage({ type: "steam-linked", steam: ' + JSON.stringify(steamInfo) + ' }, "*"); window.close();</script>Linked. You can close this window.</body></html>');
    } catch (err) {
      console.error(err);
      return res.status(500).send('Server error');
    }
  }
);

const STEAM_KEY = process.env.STEAM_API_KEY;
if (!STEAM_KEY) console.warn('Warning: STEAM_API_KEY is not set in environment. Proxy will return errors for Steam API calls.');

// Optional: initialize Firebase Admin to update user documents from server-side if needed
let admin;
try {
  admin = require('firebase-admin');
  if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }
} catch (e) { /* not configured */ }

app.get('/resolveVanity', async (req, res) => {
  const { vanity } = req.query;
  if (!vanity) return res.status(400).json({ error: 'vanity required' });
  try {
    const r = await fetch(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_KEY}&vanityurl=${encodeURIComponent(vanity)}`);
    const j = await r.json();
    return res.json(j);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'fetch error' });
  }
});

// allow health
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/getPlayerSummaries', async (req, res) => {
  const { steamids } = req.query;
  if (!steamids) return res.status(400).json({ error: 'steamids required' });
  try {
    const r = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${encodeURIComponent(steamids)}`);
    const j = await r.json();
    return res.json(j);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'fetch error' });
  }
});

app.get('/getOwnedGames', async (req, res) => {
  const { steamid } = req.query;
  if (!steamid) return res.status(400).json({ error: 'steamid required' });
  try {
    const r = await fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${encodeURIComponent(steamid)}&include_appinfo=1&include_played_free_games=1`);
    const j = await r.json();
    return res.json(j);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'fetch error' });
  }
});

// Endpoint to fetch and attach Steam info to a Firestore user document (secure server-side update)
app.post('/attachSteam', async (req, res) => {
  const { uid, steamid } = req.body || {};
  if (!uid || !steamid) return res.status(400).json({ error: 'uid and steamid required' });
  if (!admin) return res.status(500).json({ error: 'firebase-admin not configured on server' });
  try {
    // fetch player summaries and owned games
    const psR = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${encodeURIComponent(steamid)}`);
    const ps = await psR.json();
    const player = ps.response.players && ps.response.players[0];
    const ogR = await fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${encodeURIComponent(steamid)}&include_appinfo=1&include_played_free_games=1`);
    const og = await ogR.json();
    const gamesArr = (og.response && og.response.games) || [];
    const games = {};
    gamesArr.forEach(g => { games[g.appid] = { appid: g.appid, name: g.name, playtime: g.playtime_forever || 0, playtime_hours: Math.round((g.playtime_forever||0)/60) }; });
    let prime = false;
    for (const k of Object.keys(games)) {
      const n = (games[k].name||'').toLowerCase();
      if (n.includes('prime')) { prime = true; break; }
    }
    const steamInfo = { steamId: steamid, persona: player?.personaname || null, avatar: player?.avatarfull || player?.avatar || null, games, hasPrime: prime, fetchedAt: Date.now() };
    const cs = games[730];
    steamInfo.cs_hours = cs ? (cs.playtime_hours || Math.round((cs.playtime||0)/60)) : 0;

    const db = admin.firestore();
    await db.collection('users').doc(uid).set({ steam: steamInfo }, { merge: true });
    return res.json({ success: true, steam: steamInfo });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'fetch or update failed' });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// For local development listen on port 3001, in production Vercel will import the app
if (process.env.NODE_ENV !== 'production') {
  app.listen(3001, () => console.log('Steam proxy listening on http://localhost:3001'));
}

// Export app for serverless platforms (Vercel). Export both CommonJS and default to be safe.
module.exports = app;
exports.default = app;
