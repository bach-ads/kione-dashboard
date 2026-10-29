#!/usr/bin/env node
// Busca os dados diários por campanha na Meta Marketing API e gera public/data.json
// Uso:  META_ACCESS_TOKEN=... node scripts/update-data.mjs [--debug-actions]
//
// Robustez:
//  - consulta em janelas de 7 dias (consultas longas costumam dar "Service temporarily unavailable" no Meta);
//  - tenta de novo com espera crescente;
//  - se UMA conta continuar falhando, reaproveita os dados que já estão publicados no site (marcando a conta
//    como "desatualizada") em vez de derrubar a publicação inteira.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.META_ACCESS_TOKEN;
const VERSION = process.env.META_API_VERSION || 'v25.0';
const START = process.env.START_DATE || '2026-09-01';
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 7);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 3000);
const OUT = process.env.OUT_FILE || path.join(dir, '..', 'public', 'data.json');
const DEBUG = process.argv.includes('--debug-actions');
const accounts = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));

if (!TOKEN) { console.error('Defina a variável META_ACCESS_TOKEN.'); process.exit(1); }

// "hoje" no fuso de São Paulo
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const sleep = ms => new Promise(r => setTimeout(r, ms));
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
function windows(start, end) {
  const out = []; let s = start;
  while (s <= end) { const e = addDays(s, WINDOW_DAYS - 1); out.push([s, e > end ? end : e]); s = addDays(e, 1); }
  return out;
}

async function getJson(url, tries = 5) {
  for (let i = 1; i <= tries; i++) {
    let res, body;
    try { res = await fetch(url); body = await res.json().catch(() => ({})); }
    catch (e) { if (i === tries) throw e; await sleep(RETRY_BASE_MS * i * i); continue; }
    if (res.ok && !body.error) return body;
    const code = body.error?.code;
    const retry = [1, 2, 4, 17, 32, 341, 613].includes(code) || res.status >= 500;
    if (!retry || i === tries)
      throw new Error(`Meta API ${res.status}: ${body.error?.message || 'erro desconhecido'} (code ${code})`);
    console.log(`  tentativa ${i} falhou (code ${code}); aguardando para tentar de novo...`);
    await sleep(RETRY_BASE_MS * i * i);
  }
}

// Seguidores e visitas ao perfil do Instagram são campos próprios do relatório do Meta (não vêm em "actions").
// Conversas iniciadas vêm em "actions".
const numOf = v => Array.isArray(v) ? v.reduce((s, x) => s + Number(x.value || 0), 0) : Number(v || 0);
const MSG_TYPES = ['onsite_conversion.messaging_conversation_started_7d'];
const convOf = r => { for (const a of r.actions || []) if (MSG_TYPES.includes(a.action_type)) return Number(a.value || 0); return 0; };

function resultOf(acc, r, link) {
  if (acc.result === 'link_clicks') return link;
  const map = {};
  for (const a of r.actions || []) map[a.action_type] = Number(a.value || 0);
  for (const t of acc.actionTypes || []) if (map[t] !== undefined) return map[t];
  return 0;
}

// Lê um campo extra (um por vez, para que um nome inválido não derrube os outros)
async function pullField(acc, since, until, field) {
  const map = new Map();
  const params = new URLSearchParams({
    level: 'campaign', time_increment: '1', time_range: JSON.stringify({ since, until }),
    fields: 'campaign_id,' + field, limit: '100', access_token: TOKEN,
  });
  let url = `https://graph.facebook.com/${VERSION}/act_${acc.id}/insights?${params}`;
  while (url) {
    const body = await getJson(url);
    for (const r of body.data || []) map.set(r.date_start + '|' + r.campaign_id, numOf(r[field]));
    url = body.paging?.next || null;
  }
  return map;
}
async function fetchExtra(acc, since, until, state) {
  const out = new Map();
  for (const f of ['instagram_profile_follow', 'instagram_profile_visits']) {
    if (state[f] === false) continue;
    try {
      for (const [k, v] of await pullField(acc, since, until, f)) out.set(k, { ...(out.get(k) || {}), [f]: v });
    } catch (e) {
      state[f] = false;
      console.log(`::warning::${acc.name}: não foi possível ler "${f}" (${e.message.slice(0, 140)}). Esse KPI fica em 0 até corrigir.`);
    }
  }
  return out;
}

async function fetchAccount(acc) {
  const rows = [], seen = {}, state = {};
  for (const [since, until] of windows(START, today)) {
    const params = new URLSearchParams({
      level: 'campaign',
      time_increment: '1',
      time_range: JSON.stringify({ since, until }),
      fields: 'campaign_id,campaign_name,spend,impressions,reach,inline_link_clicks,unique_inline_link_clicks,actions',
      limit: '100',
      access_token: TOKEN,
    });
    const raw = [];
    let url = `https://graph.facebook.com/${VERSION}/act_${acc.id}/insights?${params}`;
    while (url) {
      const body = await getJson(url);
      raw.push(...(body.data || []));
      url = body.paging?.next || null;
    }
    const ex = await fetchExtra(acc, since, until, state);
    for (const r of raw) {
      for (const a of r.actions || []) seen[a.action_type] = (seen[a.action_type] || 0) + Number(a.value || 0);
      const spend = Number(r.spend || 0), imp = Number(r.impressions || 0);
      if (!spend && !imp) continue;
      const link = Number(r.inline_link_clicks || 0);
      const e = ex.get(r.date_start + '|' + r.campaign_id) || {};
      const fol = e.instagram_profile_follow || 0, vis = e.instagram_profile_visits || 0;
      const res = acc.result === 'profile_visits' ? vis : resultOf(acc, r, link);
      rows.push([r.date_start, r.campaign_name, +spend.toFixed(2), imp, Number(r.reach || 0),
        link, Number(r.unique_inline_link_clicks || 0), res, fol, vis, convOf(r)]);
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return { rows, seen };
}

let prevCache;
async function loadPrev() {
  if (prevCache !== undefined) return prevCache;
  let url = process.env.PREV_DATA_URL;
  if (!url && process.env.GITHUB_REPOSITORY) {
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    url = `https://${owner.toLowerCase()}.github.io/${repo}/data.json`;
  }
  prevCache = null;
  if (!url) return null;
  try { const r = await fetch(url + '?t=' + Date.now()); if (r.ok) prevCache = await r.json(); } catch { /* sem dados anteriores */ }
  return prevCache;
}

const out = { updatedAt: new Date().toISOString(), start: START, end: today, rows: {}, stale: [] };
for (const acc of accounts) {
  let rows, seen = {};
  try { ({ rows, seen } = await fetchAccount(acc)); }
  catch (e) {
    console.error(`Falha na conta ${acc.name}: ${e.message}`);
    const prev = await loadPrev(), pr = prev?.rows?.[acc.key];
    if (!pr || !pr.length) { console.error('Sem dados anteriores para reaproveitar. Publicação cancelada.'); process.exit(1); }
    rows = pr;
    const until = pr.reduce((m, r) => (r[0] > m ? r[0] : m), pr[0][0]);
    out.stale.push({ key: acc.key, name: acc.name, until, error: e.message.slice(0, 160) });
    console.log(`::warning::${acc.name}: usando os dados já publicados (até ${until}) porque o Meta não respondeu.`);
  }
  out.rows[acc.key] = rows;
  const t = rows.reduce((s, r) => [s[0] + r[2], s[1] + r[7], s[2] + (r[8] || 0), s[3] + (r[9] || 0), s[4] + (r[10] || 0)], [0, 0, 0, 0, 0]);
  console.log(`${acc.name}: ${rows.length} linhas | gasto R$ ${t[0].toFixed(2)} | resultados ${t[1]} | seguidores ${t[2]} | visitas ao perfil ${t[3]} | conversas iniciadas ${t[4]}`);
  const types = Object.entries(seen).sort((a, b) => b[1] - a[1]);
  if (DEBUG || (t[0] > 0 && t[1] === 0 && acc.result !== 'link_clicks')) {
    if (t[0] > 0 && t[1] === 0 && acc.result !== 'link_clicks')
      console.log(`::warning::${acc.name}: resultados zerados com gasto > 0. Confira "actionTypes" em scripts/accounts.json.`);
    console.log(`  tipos de ação devolvidos pelo Meta para ${acc.name}: ${types.slice(0, 20).map(([k, v]) => `${k}=${v}`).join(', ') || '(nenhum)'}`);
  }
}
if (!Object.values(out.rows).some(r => r.length)) { console.error('Nenhum dado retornado. data.json não foi alterado.'); process.exit(1); }

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT + '.tmp', JSON.stringify(out));
fs.renameSync(OUT + '.tmp', OUT);
console.log(`\ndata.json atualizado (${START} a ${today})${out.stale.length ? ' — com ' + out.stale.length + ' conta(s) desatualizada(s)' : ''}.`);
