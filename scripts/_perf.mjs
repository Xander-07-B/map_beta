import * as Core from '../js/core/index.js';
import { readFileSync } from 'node:fs';
const fetchJson = async (url) => JSON.parse(readFileSync(url, 'utf8'));
const loaded = await Core.loadScenario('1936', { fetchJson });
const mk = () => new Core.Campaign(loaded, { seed: 0x1936 });

let t0 = Date.now();
const c = mk(); c.newGame(); c.setAI(true);
c.fastForward(600);
console.log('AI 600 ticks:', Date.now() - t0, 'ms');
console.log('armies', c.state.armies.length, 'air', c.state.airForces.length, 'fleets', c.state.fleets.length);

t0 = Date.now();
const c2 = mk(); c2.newGame(); c2.setAI(true);
c2.fastForward(600);
console.log('AI 600 ticks (repeat):', Date.now() - t0, 'ms');
console.log('deterministic armies:', c.state.armies.length === c2.state.armies.length);
