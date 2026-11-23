import * as Core from '../js/core/index.js';

const fetchJson = async (url) => {
  const raw = await import('node:fs').then(fs => fs.readFileSync('' + url, 'utf8'));
  return JSON.parse(raw);
};

const loaded = await Core.loadScenario('1936', { fetchJson });
const camp = new Core.Campaign(loaded, { seed: 0x1936 });
camp.newGame();
const s = camp.state;
camp.setMapIndex({
  neighbors: {
    '1159312769': [1159314695, 1159314679],
    '1159314695': [1159312769],
    '1159314679': [1159312769],
  },
});

console.log('aircraft templates:', Object.keys(camp.content.aircraft).join(','));
console.log('ship templates:', Object.keys(camp.content.ships).join(','));
console.log('initial armies GER:', s.armies.filter(a=>a.owner==='GER').length);

// 地形修正：山地防御
console.log('terrainDefense mountain:', Core.terrainDefense('mountain', 'infantry', camp.ctx(), s.countries.GER));
console.log('terrainDefense plains:', Core.terrainDefense('plains', 'infantry', camp.ctx(), s.countries.GER));
console.log('battleWidth:', Core.battleWidth(s.provinces[1159312769]));

// 部队指令
const army = s.armies[0];
console.log('order before:', army.order);
console.log('setArmyOrder:', camp.command({ t:'setArmyOrder', armyId: army.id, order:'advance' }).ok, army.order);

// 空军部署（需要先解锁）：手动解锁
s.countries.GER.unlockedAir = ['fighter', 'strategic'];
s.countries.GER.equipment.fighter = 100;
s.countries.GER.equipment.bomber = 100;
console.log('deploy air:', camp.command({ t:'deployAirForce', country:'GER', province:1159312769, template:'fighter', count:1 }).ok, s.airForces.length);
console.log('deploy air bad province:', camp.command({ t:'deployAirForce', country:'GER', province:1159314695, template:'fighter', count:1 }).err);

// 舰队：需要沿海省份
const coastal = Object.values(s.provinces).find(p => p.coastal && p.controller === 'GER');
console.log('coastal GER province:', coastal ? coastal.id : 'none');
if (coastal) {
  s.countries.GER.unlockedShips = ['destroyer'];
  s.countries.GER.equipment.destroyer = 50;
  console.log('deploy fleet:', camp.command({ t:'deployFleet', country:'GER', province:coastal.id, template:'destroyer', count:1 }).ok, s.fleets.length);
}

// 补给网络
camp.fastForward(30);
const supply = camp._supply;
console.log('supply map size:', supply.size, 'berlin factor:', supply.get(1159312769));
const starved = s.armies.filter(a => (supply.get(a.provinceId) ?? 0) <= 0).length;
console.log('starved armies:', starved, 'org of first army:', s.armies[0]?.org.toFixed(3));

// 自动寻路
s.countries.GER.unlockedTemplates = ['infantry','armor','mechanized','cavalry','mountain'];
const path = Core.planPath(s, camp.ctx(), 1159312769, 1159314679, 'GER');
console.log('planPath:', path);
console.log('lastAirNavy:', JSON.stringify(camp.lastAirNavy));
