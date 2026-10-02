# Kaat Card Game 🃏

A 4-player trick-taking card game. Play **solo** against three computer opponents, or open an **online room** and play with friends in real time — with table chat.

## Screenshots

| Lobby | Choose Kaat | Bidding |
|---|---|---|
| ![Game lobby](docs/screenshots/lobby.png) | ![Choose the kaat suit](docs/screenshots/call.png) | ![Bidding ghar](docs/screenshots/bid.png) |

| Gameplay | Online room |
|---|---|
| ![Mid-hand gameplay](docs/screenshots/play.png) | ![Online room with table chat](docs/screenshots/online.png) |

## Features

**Solo mode — you vs 3 bots**
- Three bot difficulties: Easy, Normal, Hard (Hard bots manage trumps, protect their bids and cash winners)
- Bot bids stay hidden until you lock yours
- Tap a card to select, tap again to play — no misclicks
- Tricks auto-advance, last-trick review strip, card animations and sound effects (mutable)
- Match stats saved across visits (hands, matches won, bid success %)

**Online multiplayer** *(needs the Node server below)*
- Room codes for 4 players; server deals, validates and scores
- Table chat with unread badges, surviving reconnects
- 60-second turn timer with auto-play; call/bid phases time out too, so rooms never stall
- Host migration, kick for disconnected players, disconnected seats reopen for newcomers

## Run it

**Solo:** just open `Kaat Card Game.html` in any browser. No build, no server.

**Online rooms (local):**
1. Install Node.js 18 or newer.
2. In this folder: `npm install` (once), then `npm start`.
3. Open `http://localhost:8080`, choose **Play online**, create a room and share the code.
4. Friends on the same Wi-Fi can join via your computer's local address, port 8080.

**Online rooms (internet):** deploy with the included `render.yaml` (Render Blueprint), then open the public URL. The page connects over secure WebSockets automatically; or paste any `wss://` server address into the online lobby's server field.

Room state is held in server memory, so a server restart closes active rooms. The Render free web service can spin down after 15 minutes without incoming traffic; a new visit or WebSocket connection wakes it.

## How to play

- 52 cards, 4 players, 13 cards each. Every deal is checked so each player holds at least one card of every suit.
- The **caller** picks the **kaat** (trump) suit, bids at least **6 ghar**, and leads the first trick. Others bid at least **2**.
- Follow the lead suit if you can; otherwise play kaat or any card. Kaat beats non-kaat; without kaat, highest lead-suit card wins the trick (*ghar* / *baari*).
- Combined bids must reach **14** — short tables are raised by one in seat order.
- Make your bid (or more) for **+bid** points; miss it for **−bid** points. First to **+21** wins the match (ties go to the highest score).

The full rulebook is in `Kaat Card Game Rules.docx`.

## Project structure

| File | What it is |
|---|---|
| `Kaat Card Game.html` | The whole game client — solo mode and the online UI in one file |
| `server.js` | Node.js + WebSocket server: rooms, dealing, validation, timers, chat relay |
| `package.json` | Single dependency (`ws`) |
| `render.yaml` | Render Blueprint for one-click deploy |
| `Kaat Card Game Rules.docx` | Original rulebook |

Environment knobs for the server: `PORT`, `TURN_MS`, `TRICK_PAUSE_MS`, `MAX_ROOMS`, `GHOST_SEAT_MS`.
