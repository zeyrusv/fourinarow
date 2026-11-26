# Four in a Row

A two-player Four in a Row game with a 3D board (Three.js) and live online play. No dependencies to install.

## Features

- 3D board with lighting, shadows and bouncing discs (switch to a flat 2D board anytime)
- Play online with a friend using a 4-letter code or invite link, or share one screen
- Live updates, scores, rematch, and emoji reactions
- Light and dark theme
- Keyboard controls: ← → to choose a column, Enter to drop, or press 1–7

## Run it

You need [Node.js](https://nodejs.org) 16 or newer.

```
node server.js
```

Then open http://localhost:3000.

To play from another device on the same network:

```
HOST=0.0.0.0 node server.js
```

On Windows PowerShell:

```
$env:HOST="0.0.0.0"; node server.js
```

Settings (environment variables): `PORT` (default 3000), `HOST` (default 127.0.0.1).

## Project layout

```
server.js            game server (rooms, moves, live updates)
public/index.html    page
public/app.js        game screen and controls
public/board3d.js    3D board (Three.js)
public/style.css     styling
public/vendor/       local copy of Three.js
```

## Hosting

The game needs a Node server, so GitHub Pages won't work. Use a host that runs Node (Render, Railway, Fly.io) with start command `node server.js` and the environment variable `HOST=0.0.0.0`.

## License

MIT
