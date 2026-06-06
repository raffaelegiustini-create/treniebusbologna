const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3456;

// ── Hello Bus real-time API ───────────────────────────────────────────────────
const HELLOBUS_URL = 'https://hellobuswsweb.tper.it/web-services/hello-bus.asmx/QueryHellobus';
const BUS_STOP_ID  = '9025';  // DIRETTISSIMA verso centro
const BUS_LINES    = ['13', '96'];

function parseHelloBusResponse(data) {
  const match = data.match(/<string[^>]*>([\s\S]*?)<\/string>/);
  if (!match) return [];
  const text = match[1].replace(/TperHellobus:\s*/, '').trim();
  if (!text || text.toLowerCase().includes('non trovata') || text.toLowerCase().includes('nessun')) return [];
  return text.split(',').map(s => s.trim()).filter(Boolean).map(entry => {
    const m = entry.match(/(\d+)\s+(DaSatellite|Previsto)\s+(\d{2}:\d{2})/);
    if (!m) return null;
    return { line: m[1], type: m[2], time: m[3] };
  }).filter(Boolean);
}

function fetchHelloBus(cb) {
  // Fetch all configured lines in parallel, merge and sort by time
  let done = 0;
  const all = [];
  BUS_LINES.forEach(line => {
    const u = `${HELLOBUS_URL}?fermata=${BUS_STOP_ID}&linea=${line}&oraHHMM=`;
    https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        all.push(...parseHelloBusResponse(data));
        if (++done === BUS_LINES.length) {
          all.sort((a, b) => a.time.localeCompare(b.time));
          cb(null, all);
        }
      });
    }).on('error', () => { if (++done === BUS_LINES.length) cb(null, all); });
  });
}

// ── Bus schedule (loaded once at startup) ────────────────────────────────────
let busSchedule = null;
try {
  busSchedule = JSON.parse(fs.readFileSync(path.join(__dirname, 'bus_schedule.json'), 'utf8'));
  console.log(`Bus schedule caricato: linea ${busSchedule.line}, ${busSchedule.services.length} service_ids`);
} catch (e) {
  console.warn('bus_schedule.json non trovato, sezione bus disabilitata');
}

function getNextBuses(count = 5) {
  if (!busSchedule) return [];
  const now = new Date();
  const todayStr = now.toISOString().slice(0,10).replace(/-/g,'');
  const dow = now.getDay() === 0 ? 6 : now.getDay() - 1; // 0=mon..6=sun
  const nowHH = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  const exceptions = {};
  for (const e of busSchedule.exceptions) {
    exceptions[`${e.service_id}|${e.date}`] = e.type;
  }

  const times = new Set();
  for (const svc of busSchedule.services) {
    let active = svc.days_of_week.includes(dow) &&
                 svc.start_date <= todayStr && todayStr <= svc.end_date;
    const exc = exceptions[`${svc.service_id}|${todayStr}`];
    if (exc === '1') active = true;
    if (exc === '2') active = false;
    if (active) svc.times.forEach(t => times.add(t));
  }

  return [...times].sort().filter(t => t >= nowHH).slice(0, count);
}
const RFI_BASE = 'https://iechub.rfi.it/ArriviPartenze/ArrivalsDepartures/Monitor';

// Known station IDs
const BOLOGNA_CENTRALE_ID = '683';
const CONNECTIONS = [
  { label: 'Milano', keywords: ['MILANO', 'TORINO'] },
  { label: 'Roma', keywords: ['ROMA', 'NAPOLI', 'SALERNO'] },
  { label: 'Venezia', keywords: ['VENEZIA'] },
];

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function fetchRfi(placeId, arrivals, cb) {
  const target = `${RFI_BASE}?placeId=${placeId}&arrivals=${arrivals}`;
  https.get(target, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => cb(null, data));
  }).on('error', cb);
}

function cellText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim().replace(/\s+/g, ' ');
}

function parseTrainsFromHtml(html) {
  const trains = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const cells = {};
    const cellRegex = /<td[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = cellRegex.exec(row)) !== null) {
      cells[m[1]] = cellText(m[2]);
    }

    if (!cells['RTreno'] || !cells['ROrario']) continue;

    const delayRaw = cells['RRitardo'] || '';
    const delay = delayRaw.match(/\d+/) ? delayRaw.match(/\d+/)[0] : '0';
    const status = cells['RExLampeggio'] || '';

    trains.push({
      trainNum: cells['RTreno'] || '',
      category: cells['RCategoria'] || '',
      operator: cells['RVettore'] || '',
      destination: cells['RStazione'] || '',
      time: cells['ROrario'] || '',
      delay,
      platform: cells['RBinario'] || '',
      status,
    });
  }

  return trains;
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Given local trains (to Bologna Centrale) and Bologna Centrale departures,
// build connection suggestions for Milano/Roma/Venezia.
// Travel time from S.Ruffillo to Bologna Centrale is ~15 min.
function buildConnections(localTrains, bolognaDepartures) {
  const TRAVEL_MIN      = 15; // minutes S.Ruffillo -> Bologna C.le (on the local train)
  const PLATFORM_CHANGE = 5;  // minutes to walk between platforms at Bologna C.le
  const MAX_WAIT        = 45; // don't suggest waiting more than this at Bologna C.le
  const OPTIONS_PER_DEST = 2; // how many catchable trains to show per destination

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // Local trains toward Bologna Centrale that haven't left yet, sorted by time
  const toBologna = localTrains
    .filter(t => t.destination.includes('BOLOGNA') && !t.status.toLowerCase().includes('soppres'))
    .filter(t => timeToMinutes(t.time) + (parseInt(t.delay)||0) >= nowMin - 2)
    .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));

  const results = [];

  for (const conn of CONNECTIONS) {
    const lds = bolognaDepartures
      .filter(t => conn.keywords.some(k => t.destination.includes(k)) &&
                   !t.status.toLowerCase().includes('soppres'))
      .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));

    if (lds.length === 0) continue;

    const options = [];
    for (const ld of lds) {
      const ldActual = timeToMinutes(ld.time) + (parseInt(ld.delay)||0);

      // Best feeder = the latest local you could take that still makes the change
      // (least time wasted waiting at the station = most realistic suggestion)
      let bestFeeder = null, bestWait = Infinity;
      for (const f of toBologna) {
        const ready = timeToMinutes(f.time) + (parseInt(f.delay)||0) + TRAVEL_MIN + PLATFORM_CHANGE;
        const wait = ldActual - ready;
        if (wait >= 0 && wait <= MAX_WAIT && wait < bestWait) {
          bestWait = wait;
          bestFeeder = f;
        }
      }

      if (bestFeeder) {
        options.push({
          destination: conn.label,
          ldTrain: { trainNum: ld.trainNum, category: ld.category, time: ld.time, delay: ld.delay, platform: ld.platform, status: ld.status },
          feeder: { trainNum: bestFeeder.trainNum, time: bestFeeder.time, delay: bestFeeder.delay, platform: bestFeeder.platform },
          waitMin: bestWait,
        });
      }
      if (options.length >= OPTIONS_PER_DEST) break;
    }

    // Fallback: no catchable option found -> still show the next departure (no feeder)
    if (options.length === 0) {
      const ld = lds.find(t => timeToMinutes(t.time) + (parseInt(t.delay)||0) >= nowMin) || lds[0];
      options.push({
        destination: conn.label,
        ldTrain: { trainNum: ld.trainNum, category: ld.category, time: ld.time, delay: ld.delay, platform: ld.platform, status: ld.status },
        feeder: null,
        waitMin: null,
      });
    }

    results.push(...options);
  }

  return results;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (parsed.pathname === '/api/trains') {
    const placeId = parsed.query.placeId || '679';
    const arrivals = parsed.query.arrivals || 'False';

    fetchRfi(placeId, arrivals, (err, html) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      const trains = parseTrainsFromHtml(html);

      const stationMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
                           html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      let station = stationMatch
        ? stationMatch[1].replace(/<[^>]+>/g, '').trim()
        : 'Stazione';
      station = station.replace(/^(Partenze|Arrivi)\s*[-–]\s*/i, '').trim();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ station, trains }));
    });
    return;
  }

  if (parsed.pathname === '/api/bus') {
    fetchHelloBus((err, buses) => {
      if (err || !buses.length) {
        // fallback to static GTFS schedule
        const next = getNextBuses(6);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lines: BUS_LINES, stop: 'DIRETTISSIMA', direction: 'Centro (Piazza Malpighi)', buses: next.map(t => ({ line: '13', time: t, type: 'Previsto' })), realtime: false }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lines: BUS_LINES, stop: 'DIRETTISSIMA', direction: 'Centro (Piazza Malpighi)', buses, realtime: true }));
    });
    return;
  }

  if (parsed.pathname === '/api/connections') {
    const localPlaceId = parsed.query.placeId || '679';

    // Fetch local trains and Bologna Centrale trains in parallel
    let localTrains = null, bolognaDepartures = null, errors = 0;

    function tryBuild() {
      if (localTrains === null || bolognaDepartures === null) return;
      const connections = buildConnections(localTrains, bolognaDepartures);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connections }));
    }

    fetchRfi(localPlaceId, 'False', (err, html) => {
      if (err) { localTrains = []; }
      else { localTrains = parseTrainsFromHtml(html); }
      tryBuild();
    });

    fetchRfi(BOLOGNA_CENTRALE_ID, 'False', (err, html) => {
      if (err) { bolognaDepartures = []; }
      else { bolognaDepartures = parseTrainsFromHtml(html); }
      tryBuild();
    });
    return;
  }

  // Serve static files
  let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  const fullPath = path.join(__dirname, filePath);

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Tabellone treni in esecuzione su http://localhost:${PORT}`);
});
