// Offline test: checks the workflow structure and runs every Code node on mock data.
// Run from the project folder:  node tests/validate_workflow.js
const fs = require('fs');
const wf = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'workflow', 'logistics_market_intelligence_agent.json')));
const byName = Object.fromEntries(wf.nodes.map(n => [n.name, n]));
let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };

// ---- 1. Structure ----
const raw = JSON.stringify(wf);
ok(!/Fourmativ|Fourwrd|Fourci|Fourun/i.test(raw), 'no company / product names left');
ok(!/19RTExhLhEF5|oy0xLfIO|fOyuoKp|axQjWyX/.test(raw), 'no sheet ID or credential IDs left');
ok(!wf.nodes.some(n => n.credentials), 'no credential blocks');
let targetsOk = true, incoming = new Set();
for (const [src, c] of Object.entries(wf.connections)) {
  if (!byName[src]) targetsOk = false;
  for (const out of c.main) for (const e of out) { if (!byName[e.node]) targetsOk = false; incoming.add(e.node); }
}
ok(targetsOk, 'every connection points to a real node');
const orphans = wf.nodes.filter(n => !n.type.includes('stickyNote') && !n.type.toLowerCase().includes('trigger') && !incoming.has(n.name));
ok(orphans.length === 0, 'no orphan nodes ' + orphans.map(n=>n.name));
const mergeIdx = new Set(); for (const c of Object.values(wf.connections)) for (const o of c.main) for (const e of o) if (e.node==='Combine Search Results') mergeIdx.add(e.index);
ok(mergeIdx.size === 10, 'all 10 searches feed distinct Merge inputs');
for (const n of wf.nodes.filter(n => n.type.endsWith('.code'))) {
  try { new Function('$input','$','$json', n.parameters.jsCode); ok(true, 'JS compiles: ' + n.name); }
  catch (e) { ok(false, 'JS compiles: ' + n.name + ' ' + e.message); }
}

// ---- 2. Run the pipeline on mock data ----
const run = (name, items, extra = {}) => {
  const fn = new Function('$input', '$', '$json', byName[name].parameters.jsCode);
  return fn({ all: () => items, item: items[0] }, extra.$ || (() => {}), items[0]?.json);
};
const serp = [
  { json: { search_parameters: { q: 'q1' }, organic_results: [
    { title: 'Warehouse for Rent in Bhiwandi, Mumbai', link: 'https://www.99acres.com/warehouse-rent-bhiwandi-r1', snippet: '45,000 sq ft Grade A warehouse on lease, ₹ 22 per sq ft, near Mumbai-Nashik highway', displayed_link: 'www.99acres.com' },
    { title: 'Industrial Plot for Sale in Indore', link: 'https://www.magicbricks.com/plot-indore-pppfs', snippet: 'Industrial land 5 acres for sale at ₹ 4.5 Cr, Pithampur', displayed_link: 'www.magicbricks.com' },
    { title: 'Spam', link: 'https://www.justdial.com/x', snippet: 'godowns' } ] } },
  { json: { search_parameters: { q: 'q2' }, organic_results: [
    { title: 'Dup', link: 'https://www.99acres.com/warehouse-rent-bhiwandi-r1', snippet: 'dup' } ],
    news_results: [ { title: 'Govt approves multimodal logistics park in Nagpur', link: 'https://economictimes.indiatimes.com/mmlp-nagpur', snippet: 'MMLP over 150 acres', source: 'ET' } ] } }
];
const s1 = run('Normalise & De-duplicate', serp);
ok(s1.length === 4, 'de-dup: 5 raw results -> 4 unique (got ' + s1.length + ')');
const s2 = run('Classify & Extract Fields', s1);
ok(s2.length === 3, 'noise site dropped (got ' + s2.length + ')');
const bh = s2[0].json;
console.log('     extracted:', JSON.stringify({city: bh.city, type: bh.property_type, deal: bh.deal_type, area: bh.area, price: bh.price, rt: bh.record_type}));
ok(bh.city === 'Bhiwandi' || bh.city === 'Mumbai', 'city extracted');
ok(bh.deal_type === 'Rent/Lease' && bh.area.includes('45,000') && bh.price.includes('₹'), 'deal/area/price (₹ kept)');
ok(s2[1].json.record_type === 'portal' && s2[1].json.area.includes('acres'), 'portal tag + acre area');
ok(s2[2].json.record_type === 'intel', 'news tagged intel');
// IF filter: listing OR portal
const s3 = s2.filter(i => ['listing','portal'].includes(i.json.record_type));
ok(s3.length === 2, 'filter keeps 2 property records, drops news');
const s4 = run('Build AI Scoring Prompt', s3);
ok(s4[0].json.prompt.includes('Regional Warehouse') && s4[0].json.url === bh.url, 'prompt built, original fields kept');
// Parse step: good, fenced and broken Claude replies
const replies = [
  '{"score":8,"product_fit":"Urban Last-Mile","deal_fit":"High","action":"Pursue","strategic_note":"x","risk":"y"}',
  '```json\n{"score":12,"product_fit":"Regional Warehouse","deal_fit":"Medium","action":"Shortlist","strategic_note":"a","risk":"b"}\n```',
  'sorry, not JSON'
];
const parsed = replies.map((t, i) => {
  const src = s4[i % 2];
  return run('Parse AI Verdict', [{ json: { content: [{ text: t }] } }], { $: () => ({ item: src }) });
});
ok(parsed[0].json.ai_score === 8 && parsed[0].json.url === 'https://www.99acres.com/warehouse-rent-bhiwandi-r1', 'parse OK + URL intact (slashes kept)');
ok(parsed[1].json.ai_score === 10, 'fenced reply parsed, score clamped to 10');
ok(parsed[2].json.action === 'Skip' && parsed[2].json.ai_score === 0, 'broken reply -> safe fallback');
console.log(fail ? `\n${fail} FAILED` : '\nALL TESTS PASSED');
process.exit(fail ? 1 : 0);
