const express = require('express');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const { URLSearchParams } = require('url');

const router = express.Router();

const STEAM_KEY = process.env.STEAM_API_KEY;
if (!STEAM_KEY) console.warn('Warning: STEAM_API_KEY is not set');

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
  } catch (e) { console.warn('Invalid FIREBASE_SERVICE_ACCOUNT'); }
} else {
  console.warn('FIREBASE_SERVICE_ACCOUNT not set - server linking will not work');
}

// POST /initLink - store idToken in session (session middleware must be applied on main app)
router.post('/initLink', (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'idToken required' });
  if (!req.session) return res.status(500).json({ error: 'Session not configured on server' });
  req.session.idToken = idToken;
  return res.json({ ok: true });
});

// GET /auth/steam - redirect to Steam OpenID
router.get('/auth/steam', (req, res) => {
  // allow passing idToken as query parameter (fallback for local dev where session cookie isn't set)
  if (req.query && (req.query.idToken || req.query.token)) {
    const t = req.query.idToken || req.query.token;
    if (req.session) req.session.idToken = t;
  }
  const returnUrl = `${req.protocol}://${req.get('host')}/auth/steam/return`;
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnUrl,
    'openid.realm': `${req.protocol}://${req.get('host')}`,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
  });
  const redirectUrl = `https://steamcommunity.com/openid/login?${params.toString()}`;
  return res.redirect(redirectUrl);
});

// GET /auth/steam/return - OpenID callback
router.get('/auth/steam/return', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query);
    params.set('openid.mode', 'check_authentication');
    const verifyResp = await fetch('https://steamcommunity.com/openid/login', { method: 'POST', body: params });
    const verifyText = await verifyResp.text();
    if (!verifyText.includes('is_valid:true')) return res.status(400).send('OpenID verification failed');
    const claimed = req.query['openid.claimed_id'] || req.query['openid.identity'];
    const m = claimed && claimed.match(/https:\/\/steamcommunity.com\/openid\/id\/(\d+)/);
    if (!m) return res.status(400).send('Cannot extract steamid');
    const steamid = m[1];

    if (!req.session || !req.session.idToken) return res.status(400).send('No idToken in session. Start link from client first.');
    const idToken = req.session.idToken;
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // fetch player summary and games
    const psRes = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${steamid}`);
    const ps = await psRes.json();
    const player = ps.response.players && ps.response.players[0];
    const ogRes = await fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${steamid}&include_appinfo=1&include_played_free_games=1`);
    const og = await ogRes.json();
    const gamesArr = (og.response && og.response.games) || [];

    let totalMinutes = 0;
    const games = {};
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

    return res.send(`<html><body><script>window.opener && window.opener.postMessage({ type: 'steam-linked', steam: ${JSON.stringify(steamInfo)} }, '*'); window.close();</script>Linked. You can close this window.</body></html>`);
  } catch (e) {
    console.error(e);
    return res.status(500).send('Server error');
  }
});

module.exports = router;
