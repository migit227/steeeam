Proxy server for Steam Web API

This simple Express proxy forwards requests to Steam Web API endpoints and hides your Steam API key from the client.

Setup:
1. Install dependencies:
   cd functions/proxy-server
   npm install

2. Set environment variable STEAM_API_KEY. In Windows PowerShell:
   $env:STEAM_API_KEY="YOUR_KEY"

3. Run the proxy:
   node index.js

4. In client (.env or dev), set:
   REACT_APP_STEAM_PROXY=http://localhost:3001

Endpoints:
- GET /resolveVanity?vanity=VANITY
- GET /getPlayerSummaries?steamids=STEAMID
- GET /getOwnedGames?steamid=STEAMID

Note: For production deploy to a secure environment (Heroku, VPS or cloud function). Do not commit your STEAM_API_KEY to source control.
