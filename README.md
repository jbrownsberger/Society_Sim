# The Hamlet Simulation (Society Sim)

An agent-based socio-economic village simulation built with HTML5 Canvas and modular ES6 JavaScript.

## Project Structure

```
Society_Sim/
├── index.html              # Main HTML entry point
├── css/
│   └── styles.css          # Editorial parchment-style UI stylesheets
├── src/
│   ├── main.js             # Bootstrap, game loop, and global event listeners
│   ├── config/
│   │   ├── constants.js    # Economic, grid, need, and simulation constants
│   │   └── rng.js          # Seeded pseudorandom number generator (RNG class)
│   ├── core/
│   │   ├── world.js        # Global world state object & event logging
│   │   ├── assets.js       # Physical/skill assets, building footprint & grid map logic
│   │   ├── npc.js          # NPC factory, name generation, initial population setup
│   │   ├── needs.js        # Need satisfaction utility functions & emergency replanning
│   │   ├── prestige.js     # Village prestige score target calculations
│   │   ├── relations.js    # Inter-NPC devotion/odium & affinity decay logic
│   │   └── demographics.js # Marriage market, childbirth, aging, death & estate inheritance
│   ├── economy/
│   │   ├── market.js       # Inventory-based bid/ask market maker & dividend distribution
│   │   ├── shadowPrices.js # Shadow pricing math, NPV calculation & carrying costs
│   │   ├── labor.js        # Hired labor valuations & per-profession clearing wages
│   │   ├── auctions.js     # Periodic sealed-bid asset auctions
│   │   └── bankChurch.js   # Tithes, alms, bank financing, debt service & interest
│   ├── simulation/
│   │   ├── actions.js      # Action library scoring & asset building/tinkering EV math
│   │   ├── scheduler.js    # Weekly planner & two-pass daily schedule allocator
│   │   ├── execution.js    # Schedule tick execution & memory updates
│   │   └── engine.js       # Main daily simulation loop (tickDay)
│   └── ui/
│       ├── renderer.js     # Canvas map drawing, terrain, structure & NPC rendering
│       └── ui.js           # Sidebar tabs, market grid, price history sparkline & inspector panel
├── package.json            # NPM package metadata and dev scripts
└── work.html               # Original single-file html backup
```

## Running the Simulation

### Option 1: Using standard web server
Run any local HTTP server in the repository root folder:
```bash
npx serve .
# or
python3 -m http.server 8000
```
Then open `http://localhost:3000` (or `http://localhost:8000`) in any modern browser.

### Option 2: NPM start shortcut
```bash
npm start
```
