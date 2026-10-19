// api/bouw7.js — Vercel serverless functie voor Bouw7 koppeling
// De API key staat veilig als omgevingsvariabele op Vercel, nooit in de browser

const BOUW7_BASE  = 'https://heimdall.bouw7.nl';
const APOLLO_BASE = 'https://apollo.bouw7.nl';
const BOUW7_KEY   = process.env.BOUW7_API_KEY; // instellen in Vercel dashboard

// Optioneel: forceer een vaste app naam via env var BOUW7_APP
// Anders probeert de functie automatisch een lijst kandidaat-namen
const FORCED_APP  = process.env.BOUW7_APP || '';

// Kandidaat app namen om te proberen (in volgorde)
const APP_CANDIDATES = FORCED_APP
  ? [FORCED_APP]
  : ['exact', 'exactonline', 'exact-online-bouw', 'bouw7', 'bouw', 'api', 'msf-dashboard'];

// ── Token cache
let _token = null;
let _tokenExpiry = 0;
let _workingApp = null;

async function tryLogin(appName) {
  const res = await fetch(`${BOUW7_BASE}/auth/login/${appName}/apiKey`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: `apiKey=${encodeURIComponent(BOUW7_KEY)}`
  });
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  return { ok: res.ok, status: res.status, data };
}

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  // Als we al een werkende app naam kennen, gebruik die
  const namen = _workingApp ? [_workingApp, ...APP_CANDIDATES] : APP_CANDIDATES;

  let laatsteFout = '';
  for (const appName of namen) {
    const r = await tryLogin(appName);
    if (r.ok) {
      const tok = r.data.token || r.data.access_token || r.data.apiToken;
      if (tok) {
        _token = tok;
        _workingApp = appName;
        _tokenExpiry = Date.now() + 9 * 60 * 1000;
        return _token;
      }
    }
    // Onthoud de fout, maar alleen 'application does not exist' betekent: probeer volgende naam
    const msg = (r.data && r.data.message) ? r.data.message : JSON.stringify(r.data);
    laatsteFout = `[${appName}] ${r.status}: ${msg}`;
    // Als de fout NIET over de applicatienaam gaat, is de key zelf fout — stop dan
    if (r.data && r.data.type && r.data.type !== 'ApplicationNotFoundException') {
      throw new Error(`Bouw7 login geweigerd: ${msg} (app: ${appName})`);
    }
  }
  throw new Error(`Geen werkende app naam gevonden. Laatste fout: ${laatsteFout}. Geprobeerd: ${namen.join(', ')}`);
}

// Endpoint om te zien welke app naam werkte
function getWorkingApp(){ return _workingApp; }

async function bouw7Get(path) {
  const token = await getToken();
  const res = await fetch(`${BOUW7_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`Bouw7 API fout (${res.status}) voor ${path}`);
  return res.json();
}

// ── Bouw7 gebruikt POST om LIJSTEN op te halen (niet om aan te maken)
async function bouw7Post(path, body) {
  const token = await getToken();
  const res = await fetch(`${BOUW7_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error(`Bouw7 API fout (${res.status}) voor POST ${path}`);
  return res.json();
}

// ── Paginering via GET
async function bouw7GetAll(path) {
  let results = [];
  let page = 1;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await bouw7Get(`${path}${sep}page=${page}&limit=100`);
    const items = Array.isArray(data) ? data : (data.data || data.results || data.items || []);
    results = results.concat(items);
    if (items.length < 100) break;
    page++;
  }
  return results;
}

// ── Paginering via POST (voor lijst-endpoints zoals /project)
async function bouw7PostAll(path) {
  let results = [];
  let page = 1;
  while (true) {
    const data = await bouw7Post(path, { page: page, limit: 100 });
    const items = Array.isArray(data) ? data : (data.data || data.results || data.items || []);
    results = results.concat(items);
    if (items.length < 100) break;
    page++;
    if (page > 50) break; // veiligheidsgrens
  }
  return results;
}

// ── Apollo search API (apollo.bouw7.nl/search/*) — GET met optionele X-Query header
async function apolloSearch(resource, query) {
  const token = await getToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json'
  };
  if (query) headers['X-Query'] = query;
  const res = await fetch(`${APOLLO_BASE}/search/${resource}`, {
    method: 'GET',
    headers: headers
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Apollo fout (${res.status}) voor /search/${resource}: ${txt.substring(0,150)}`);
  try { return JSON.parse(txt); } catch { return txt; }
}

// Haal alle items op uit een Apollo-resultaat (verschillende mogelijke structuren)
function apolloItems(data) {
  if (Array.isArray(data)) return data;
  return data.data || data.results || data.items || data.hits || [];
}

export default async function handler(req, res) {
  // CORS — alleen vanuit jouw Vercel domein
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!BOUW7_KEY) {
    res.status(500).json({ ok: false, error: 'BOUW7_API_KEY niet ingesteld in Vercel' });
    return;
  }

  const { endpoint, id } = req.query;

  try {
    let data;

    // Diagnostisch endpoint: welke app naam werkt + welke endpoints zijn bereikbaar?
    if (endpoint === 'diag') {
      await getToken(); // forceert login
      var tests = {};
      // Eerst organisatie-id ophalen voor context-varianten
      var orgId = null;
      try {
        var orgToken = await getToken();
        var orgRes = await fetch(BOUW7_BASE + '/organization', {
          headers: { 'Authorization': 'Bearer ' + orgToken, 'Accept': 'application/json' }
        });
        if (orgRes.ok) {
          var orgData = await orgRes.json();
          var arr = Array.isArray(orgData) ? orgData : (orgData.data || [orgData]);
          if (arr[0]) orgId = arr[0].id || arr[0]._id || arr[0].organizationId;
        }
      } catch(e){}

      var paden = [
        '/project',
        '/projects',
        '/v1/project',
        '/organization/' + orgId + '/project',
        '/organization/' + orgId + '/projects',
        '/project?organization=' + orgId,
        '/projects?organization=' + orgId,
        '/work',
        '/works',
        '/job',
        '/jobs'
      ];
      for (var i = 0; i < paden.length; i++) {
        try {
          var token = await getToken();
          var rr = await fetch(BOUW7_BASE + paden[i], {
            headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
          });
          tests['GET ' + paden[i]] = rr.status;
        } catch (e) {
          tests['GET ' + paden[i]] = 'fout';
        }
      }
      // Test Apollo search endpoints via GET (de juiste methode)
      var apolloResources = ['projects', 'hours', 'invoices', 'purchase-invoices', 'employees', 'relations'];
      for (var a = 0; a < apolloResources.length; a++) {
        try {
          var tka = await getToken();
          var ra = await fetch(APOLLO_BASE + '/search/' + apolloResources[a], {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + tka, 'Accept': 'application/json' }
          });
          var txta = await ra.text();
          tests['Apollo GET /search/' + apolloResources[a]] = ra.status + ': ' + txta.substring(0, 80);
        } catch (e) {
          tests['Apollo GET /search/' + apolloResources[a]] = 'fout';
        }
      }
      res.status(200).json({ ok: true, workingApp: getWorkingApp(), orgId: orgId, endpointTests: tests });
      return;
    }

    // Organisatie ophalen
    if (endpoint === 'organization') {
      data = await bouw7Get('/organization');
      res.status(200).json({ ok: true, data });
      return;
    }

    switch (endpoint) {

      // ── Projecten (Apollo search) — filter afgesloten eruit, nieuwste eerst
      case 'projects': {
        // status.closesProject = false → alleen lopende projecten
        // Sorteer op id aflopend (nieuwste eerst), haal max 1000
        let proj = [];
        try {
          proj = apolloItems(await apolloSearch('projects', 'status.closesProject is false SORT(id, DESC) LIMIT 1000'));
        } catch (e) {
          // Fallback: gewoon alles, nieuwste eerst
          try { proj = apolloItems(await apolloSearch('projects', 'SORT(id, DESC) LIMIT 1000')); }
          catch (e2) { proj = apolloItems(await apolloSearch('projects')); }
        }
        data = proj;
        break;
      }

      // ── Eén project via id-filter
      case 'project':
        if (!id) throw new Error('id vereist');
        data = apolloItems(await apolloSearch('projects', `id = ${id}`));
        break;

      // ── Inkoopfacturen per project
      case 'invoices':
        if (!id) throw new Error('id vereist');
        data = apolloItems(await apolloSearch('purchase-invoices', `project = @("${id}")`));
        break;

      // ── Medewerkers
      case 'employees':
        data = apolloItems(await apolloSearch('employees'));
        break;

      // ── Alles voor één project in één aanroep
      case 'project_full': {
        if (!id) throw new Error('id vereist');
        // Project zelf — id is numeriek, dus geen @() wrapper (die is voor datums)
        let project = null;
        try {
          const projlist = apolloItems(await apolloSearch('projects', `id = ${id}`));
          project = projlist[0] || null;
        } catch (e) {}
        // Fallback: haal alle projecten op en zoek het juiste id
        if (!project) {
          try {
            const alle = apolloItems(await apolloSearch('projects'));
            project = alle.find(p => String(p.id) === String(id)) || null;
          } catch (e) {}
        }
        if (!project) throw new Error('Project ' + id + ' niet gevonden via Apollo');

        // Geboekte uren — via employee-hour-logs, gefilterd op projectId
        let hours = [];
        try {
          hours = apolloItems(await apolloSearch('employee-hour-logs', `projectId = ${id} LIMIT 1000`));
        } catch (e) {
          try { hours = apolloItems(await apolloSearch('employee-hour-logs', `project.id = ${id} LIMIT 1000`)); } catch (e2) {}
        }

        // Inkoopfacturen met regels (bedragen zitten in lines, vereist EXPAND)
        let invoices = [];
        try {
          invoices = apolloItems(await apolloSearch('purchase-invoices', `EXPAND(lines) project.id = ${id} LIMIT 1000`));
        } catch (e) {
          try { invoices = apolloItems(await apolloSearch('purchase-invoices', `project.id = ${id} LIMIT 1000`)); } catch (e2) {}
        }

        // Verkoopfacturen (termijnfacturen) — bedrag staat op factuurniveau (total/subtotal)
        let salesInvoices = [];
        try {
          salesInvoices = apolloItems(await apolloSearch('invoices', `project.id = ${id} LIMIT 1000`));
        } catch (e) {
          try { salesInvoices = apolloItems(await apolloSearch('invoices', `project = ${id} LIMIT 1000`)); } catch (e2) {}
        }

        data = { project, hours, invoices, salesInvoices, budget: null };
        break;
      }

      // (diagnose-endpoints verwijderd — alleen productieve endpoints resteren)

      default:
        res.status(400).json({ ok: false, error: `Onbekend endpoint: ${endpoint}` });
        return;
    }

    res.status(200).json({ ok: true, data });

  } catch (err) {
    console.error('Bouw7 fout:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}
