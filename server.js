import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const BOOKS = [
  ['fanduel','FanDuel'], ['draftkings','DraftKings'],
  ['fanatics','Fanatics'], ['betmgm','BetMGM'], ['williamhill_us','Caesars']
];
const scheduleCache = new Map();
let oddsCache = { at: 0, data: [] };

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(14000) });
  if (!response.ok) throw new Error('Provider returned HTTP ' + response.status);
  return response.json();
}
async function schedule(season, week) {
  const key = season + '-' + week, cached = scheduleCache.get(key);
  if (cached && Date.now() - cached.at < 21600000) return cached.data;
  const data = await json('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=' + season + '&seasontype=2&week=' + week + '&limit=25');
  const games = (data.events || []).map(event => {
    const competitors = event.competitions?.[0]?.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');
    if (!home || !away) return null;
    return { id: event.id, date: event.date, home: home.team.displayName,
      away: away.team.displayName, homeAbbr: home.team.abbreviation,
      awayAbbr: away.team.abbreviation,
      status: event.status?.type?.description || 'Scheduled' };
  }).filter(Boolean).sort((a,b) => Date.parse(a.date) - Date.parse(b.date));
  scheduleCache.set(key, { at: Date.now(), data: games });
  return games;
}
async function odds() {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { configured: false, games: [], asOf: null };
  const interval = Math.max(5, Number(process.env.ODDS_CACHE_MINUTES || 30)) * 60000;
  if (oddsCache.at && Date.now() - oddsCache.at < interval)
    return { configured: true, games: oddsCache.data, asOf: new Date(oddsCache.at).toISOString() };
  const url = new URL('https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/');
  url.searchParams.set('apiKey', key);
  url.searchParams.set('bookmakers', BOOKS.map(b => b[0]).join(','));
  url.searchParams.set('markets', 'spreads,totals');
  url.searchParams.set('oddsFormat', 'american');
  const games = await json(url);
  oddsCache = { at: Date.now(), data: games };
  return { configured: true, games, asOf: new Date(oddsCache.at).toISOString() };
}
function lines(game, items) {
  const match = items.find(x => x.home_team === game.home && x.away_team === game.away)
    || items.find(x => (x.home_team === game.home || x.home_team?.endsWith(game.home.split(' ').at(-1)))
      && (x.away_team === game.away || x.away_team?.endsWith(game.away.split(' ').at(-1)))
      && Math.abs(Date.parse(x.commence_time) - Date.parse(game.date)) < 86400000);
  const bookLines = BOOKS.map(([key,name]) => {
    const book = match?.bookmakers?.find(b => b.key === key);
    const spreads = book?.markets?.find(m => m.key === 'spreads')?.outcomes || [];
    const totals = book?.markets?.find(m => m.key === 'totals')?.outcomes || [];
    const homeSpread = spreads.find(o => o.name === match?.home_team)?.point;
    const total = totals.find(o => o.name === 'Over')?.point;
    return { key, name, spread: Number.isFinite(homeSpread) ? homeSpread : null,
      total: Number.isFinite(total) ? total : null };
  });
  const mean = field => {
    const values = bookLines.map(b => b[field]).filter(Number.isFinite);
    return values.length ? Math.round(values.reduce((a,b) => a+b,0)/values.length*10)/10 : null;
  };
  return { ...game, books: bookLines, spread: mean('spread'), total: mean('total'),
    spreadCount: bookLines.filter(b => b.spread !== null).length,
    totalCount: bookLines.filter(b => b.total !== null).length };
}
const clientScript = "\nconst seasonSelect=document.getElementById('season'),weekSelect=document.getElementById('week');\nfor(let y=2024;y<=2028;y++) seasonSelect.add(new Option(y,y));\nfor(let w=1;w<=18;w++) weekSelect.add(new Option('Week '+w,w));\nseasonSelect.value='2026';weekSelect.value='12';\nfunction fmtSpread(v,team){if(v===null)return '—';return team+' '+(v>0?'+':'')+v.toFixed(1)}\nfunction fmtTotal(v){return v===null?'—':v.toFixed(1)}\nfunction safe(s){return String(s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]))}\nasync function load(){\n document.getElementById('notice').textContent='Loading NFL games and odds…';\n try{\n  const r=await fetch('/api/games?season='+seasonSelect.value+'&week='+weekSelect.value);\n  const d=await r.json();if(!r.ok)throw Error(d.error||'Unable to load games');\n  document.getElementById('gameCount').textContent=d.games.length;\n  document.getElementById('updated').textContent=d.asOf?new Date(d.asOf).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):'Not linked';\n  document.getElementById('notice').textContent=!d.configured?'Schedule is live. Add ODDS_API_KEY in Render to enable sportsbook lines.':d.oddsError?d.oddsError:'Odds are snapshots and may be unavailable for completed or distant games.';\n  document.getElementById('games').innerHTML=d.games.map((g,i)=>`<div class=\"row game\" data-index=\"${i}\" role=\"button\" tabindex=\"0\"><div><b>${safe(g.away)} @ ${safe(g.home)}</b><div class=\"sub\">${new Date(g.date).toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})} ET · ${safe(g.status)}</div></div><div><div class=\"number\">${fmtSpread(g.spread,g.homeAbbr)}</div><div class=\"sub\">${g.spreadCount}/5 books</div></div><div><div class=\"number\">${fmtTotal(g.total)}</div><div class=\"sub\">${g.totalCount}/5 books</div></div><div>⌄</div></div><div class=\"detail\" id=\"detail-${i}\"><div class=\"bookrow muted\"><b>Sportsbook</b><b>Home spread</b><b>O/U</b></div>${g.books.map(b=>`<div class=\"bookrow\"><span>${safe(b.name)}</span><span>${fmtSpread(b.spread,g.homeAbbr)}</span><span>${fmtTotal(b.total)}</span></div>`).join('')}</div>`).join('');\n  document.querySelectorAll('.game').forEach(el=>{const toggle=()=>document.getElementById('detail-'+el.dataset.index).classList.toggle('open');el.addEventListener('click',toggle);el.addEventListener('keydown',e=>{if(e.key==='Enter')toggle()})});\n }catch(e){document.getElementById('notice').textContent='Unable to retrieve the schedule: '+e.message}\n}\nseasonSelect.addEventListener('change',load);weekSelect.addEventListener('change',load);document.getElementById('refresh').addEventListener('click',load);load();\n";
const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NFL Consensus Odds</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,Arial;background:#0b1120;color:#f3f7ff;color-scheme:dark}
*{box-sizing:border-box}body{margin:0}main{max-width:1160px;margin:0 auto;padding:34px 22px 80px}
header{display:flex;gap:20px;justify-content:space-between;align-items:center;flex-wrap:wrap;margin-bottom:30px}
h1{font-size:clamp(28px,4vw,41px);letter-spacing:-1.5px;margin:0 0 7px}
.kicker{color:#60d9c5;text-transform:uppercase;letter-spacing:2px;font-size:12px;font-weight:750}
.muted,.sub{color:#9caac2}.controls{display:flex;gap:9px;align-items:center}
select,button{background:#1b2a45;color:white;border:1px solid #3b4d69;border-radius:10px;padding:11px 14px;font-size:14px}
button{cursor:pointer;background:#187e74;border-color:#187e74;font-weight:700}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:13px;margin-bottom:24px}
.metric,.panel{background:#121e32;border:1px solid #2b3b55;border-radius:15px}
.metric{padding:18px}.metric strong{font-size:26px;display:block;margin-top:7px}
.metric span{font-size:13px;color:#a8bad1}
.notice{background:#17263a;border-left:3px solid #40c3b0;color:#c2d8eb;padding:13px 17px;border-radius:7px;margin-bottom:20px}
.panel{overflow:hidden}.row{display:grid;grid-template-columns:minmax(160px,1fr) 140px 140px 32px;gap:12px;align-items:center;padding:17px 20px;border-bottom:1px solid #273750}
.row:last-child{border-bottom:0}.head{color:#93a4bd;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:700;background:#18263b}
.game{cursor:pointer}.game:hover{background:#1b2d45}.game b{font-size:16px}.sub{font-size:12px;margin-top:5px}
.number{font-weight:800;font-size:19px;font-variant-numeric:tabular-nums}
.detail{display:none;padding:17px 20px 20px;background:#0f1b2e;border-bottom:1px solid #273750}
.detail.open{display:block}.bookrow{display:grid;grid-template-columns:1fr 140px 140px;gap:12px;padding:10px 0;border-bottom:1px solid #293850}
.bookrow:last-child{border:0}#message{margin:14px 0;color:#9ab0cb}
@media(max-width:620px){main{padding:25px 12px}.metrics{gap:7px}.metric{padding:11px}.metric strong{font-size:19px}.row{grid-template-columns:minmax(120px,1fr) 87px 74px 16px;gap:5px;padding:13px 9px}.head{font-size:10px}.number{font-size:15px}.bookrow{grid-template-columns:1fr 85px 80px}}
</style></head><body><main><header><div><div class="kicker">NFL • Betting analytics</div><h1>Consensus Odds</h1><div class="muted">Five-book spread and totals comparison</div></div>
<div class="controls"><select id="season" aria-label="Season"></select><select id="week" aria-label="Week"></select><button id="refresh">Refresh</button></div></header>
<div class="metrics"><div class="metric"><span>Games</span><strong id="gameCount">—</strong></div><div class="metric"><span>Sportsbooks</span><strong>5</strong></div><div class="metric"><span>Odds updated</span><strong id="updated" style="font-size:16px">—</strong></div></div>
<div class="notice" id="notice">Loading weekly NFL schedule…</div><section class="panel"><div class="row head"><span>Matchup</span><span>Average spread</span><span>Average O/U</span><span></span></div><div id="games"></div></section>
<div id="message">Consensus spreads reflect the home team's point of view. Negative means the home team is favored.</div></main>
<script src="/app.js"></script></body></html>`;
http.createServer(async(req,res)=>{
 const url = new URL(req.url || '/', 'http://localhost');
 const send=(code,data,type='application/json')=>{res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(typeof data==='string'?data:JSON.stringify(data));};
 if(url.pathname==='/')return send(200,html,'text/html; charset=utf-8');
 if(url.pathname==='/app.js')return send(200,clientScript,'text/javascript; charset=utf-8');
 if(url.pathname==='/health')return send(200,{ok:true});
 if(url.pathname!=='/api/games')return send(404,{error:'Not found'});
 const season=Number(url.searchParams.get('season')||2026), week=Number(url.searchParams.get('week')||12);
 if(!Number.isInteger(season)||season<2020||season>2035||!Number.isInteger(week)||week<1||week>18)return send(400,{error:'Invalid season/week'});
 try {
  const [s,o]=await Promise.allSettled([schedule(season,week),odds()]);
  if(s.status!=='fulfilled')throw s.reason;
  const data=o.status==='fulfilled'?o.value:{configured:!!process.env.ODDS_API_KEY,games:[],asOf:null};
  send(200,{season,week,games:s.value.map(g=>lines(g,data.games)),configured:data.configured,asOf:data.asOf,oddsError:o.status==='rejected'?'Odds API could not be reached; check your key, plan or quota.':null});
 }catch(e){send(502,{error:'NFL schedule unavailable: '+String(e.message||e)})}
}).listen(PORT,'0.0.0.0',()=>console.log('NFL dashboard listening on '+PORT));
