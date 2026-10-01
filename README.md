# Kaat Card Game

The browser game is `Kaat Card Game.html` in the repository (the workspace copy is in `outputs/`). Solo play works as a local file. Online rooms need the Node.js server in this folder.

## Run online mode locally

1. Install Node.js 18 or newer.
2. From this folder, run `npm install` once.
3. Run `npm start` and keep that terminal open.
4. Open `http://localhost:8080` in your browser, choose **Play online**, and create a room.
5. To test with friends on the same Wi-Fi, they can use your computer’s local network address and port 8080. To play across the internet, deploy the app first and share the public page URL plus the room code.

The server deals and validates cards, enforces follow-suit, scores hands, and owns the 60-second turn deadline. When time runs out, it automatically plays the lowest legal card. Room state is held in server memory, so a server restart closes active rooms.

## Deploy

`render.yaml` describes a Node web service that serves the game page and its WebSocket endpoint from the same public URL. Put this folder in a GitHub repository, then create a Render Blueprint from that repository. After the service is live, open its `https://…onrender.com` address and create a room. Friends open that same address and enter the room code. The client uses secure WebSockets automatically on HTTPS.

The Render free web service can spin down after 15 minutes without incoming traffic; a new visit or WebSocket connection wakes it. Active WebSocket rooms are in memory and do not survive a service restart or redeploy.
