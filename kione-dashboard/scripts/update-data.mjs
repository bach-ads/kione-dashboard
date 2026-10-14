#!/usr/bin/env node
// Busca os dados diários por campanha na Meta Marketing API e gera public/data.json
// Uso:  META_ACCESS_TOKEN=... node scripts/update-data.mjs [--debug-actions]
//
// Comportamento:
//  - timeout por requisição e novas tentativas em falha de rede/limite de taxa;
//  - período dividido em blocos (CHUNK_DAYS, padrão 14) e, se a Meta pedir para
//    "reduzir a quantidade de dados", o bloco é dividido ao meio automaticamente;
//  - uma conta com erro NÃO derruba as outras: ela aparece como anotação de erro no
//    GitHub Actions e o dashboard segue publicado com o último dado conhecido dela;
//  - o job só falha se o token for inválido, se TODAS as contas falharem ou se não vier dado nenhum.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.META_ACCESS_TOKEN;
const VERSION = process.env.META_API_VERSION || 'v21.0';
const GRAPH = (process.env.META_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, '');
const START = process.env.START_DATE || '2026-09-01';
const OUT = process.env.OUT_FILE || path.join(dir, '..', 'public', 'data.json');
const CHUNK_DAYS = Number(process.env.CHUNK_DAYS || 14);
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 90000);
const DEBUG = process.argv.includes('--debug-actions');
const accounts = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));

if (!TOKEN) {
  console.error('::error title=Token ausente::O secret META_ACCESS_TOKEN está vazio ou não existe (Settings > Secrets and variables > Actions).');
  process.exit(1);
}

// "hoje" no fuso de São Paulo
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const sleep = ms => new Promise(r => setTimeout(r, ms));
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

class MetaError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'MetaError'; Object.assign(this, extra); }
}

// Nunca registrar a URL: ela carrega o access_token.
async function getJson(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    let res, body;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      const why = `${e.name}${e.cause?.code ? ' ' + e.cause.code : ''}`;
      if (i === tries) throw new MetaError(`falha de rede ou timeout após ${tries} tentativas (${why})`, { network: true });
      await sleep(2000 * i * i);
      continue;
    }
    if (res.ok && !body.error) return body;
    const err = body.error || {};
    const code = err.code;
    const tooBig = /reduce the amount of data/i.test(err.message || '');
    const retry = !tooBig && ([1, 2, 4, 17, 32, 613].includes(code) || res.status >= 500);
    if (!retry || i === tries) {
      const extra = [`code ${code}`, err.error_subcode && `subcode ${err.error_subcode}`, err.fbtrace_id && `trace ${err.fbtrace_id}`].filter(Boolean).join(', ');
      throw new MetaError(`Meta API ${res.status}: ${err.message || 'erro desconhecido'} (${extra})`, { code, status: res.status, tooBig });
    }
    await sleep(2000 * i * i);
  }
}

function resultOf(acc, r, link) {
  if (acc.result === 'link_clicks') return link;
  const map = {};
  for (const a of r.actions || []) map[a.action_type] = Number(a.value || 0);
  for (const t of acc.actionTypes || []) if (map[t] !== undefined) return map[t];
  return 0;
}

async function fetchRange(acc, since, until, seen) {
  const params = new URLSearchParams({
    level: 'campaign',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    fields: 'campaign_id,campaign_name,spend,impressions,reach,inline_link_clicks,unique_inline_link_clicks,actions',
    limit: '500',
    access_token: TOKEN,
  });
  let url = `${GRAPH}/${VERSION}/act_${acc.id}/insights?${params}`;
  const rows = [], seenLocal = {};
  try {
    while (url) {
      const body = await getJson(url);
      for (const r of body.data || []) {
        for (const a of r.actions || []) seenLocal[a.action_type] = (seenLocal[a.action_type] || 0) + Number(a.value || 0);
        const spend = Number(r.spend || 0), imp = Number(r.impressions || 0);
        if (!spend && !imp) continue;
        const link = Number(r.inline_link_clicks || 0);
        rows.push([r.date_start, r.campaign_name, +spend.toFixed(2), imp, Number(r.reach || 0),
          link, Number(r.unique_inline_link_clicks || 0), resultOf(acc, r, link)]);
      }
      url = body.paging?.next || null;
    }
  } catch (e) {
    if (e.tooBig && since < until) { // a Meta pediu menos dados: divide o período ao meio
      const mid = addDays(since, Math.floor(daysBetween(since, until) / 2));
      const a = await fetchRange(acc, since, mid, seen);
      const b = await fetchRange(acc, addDays(mid, 1), until, seen);
      return [...a, ...b];
    }
    throw e;
  }
  for (const [k, v] of Object.entries(seenLocal)) seen[k] = (seen[k] || 0) + v;
  return rows;
}

async function fetchAccount(acc) {
  const rows = [], seen = {};
  for (let s = START; s <= today; s = addDays(s, CHUNK_DAYS)) {
    const e = addDays(s, CHUNK_DAYS - 1);
    rows.push(...await fetchRange(acc, s, e < today ? e : today, seen));
  }
  if (DEBUG) {
    console.log(`\n[${acc.key}] ${acc.name} — tipos de ação encontrados (total no período):`);
    Object.entries(seen).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`   ${k}: ${v}`));
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return rows;
}

// último dado conhecido (usado só para contas que falharem nesta execução)
let prev = null;
try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* sem arquivo anterior */ }

const out = { updatedAt: new Date().toISOString(), start: START, end: today, rows: {} };
const failed = [];
let tokenInvalid = false;

for (const acc of accounts) {
  try {
    out.rows[acc.key] = await fetchAccount(acc);
    const t = out.rows[acc.key].reduce((s, r) => [s[0] + r[2], s[1] + r[7]], [0, 0]);
    console.log(`${acc.name}: ${out.rows[acc.key].length} linhas | gasto R$ ${t[0].toFixed(2)} | resultados ${t[1]}`);
  } catch (e) {
    const hint = e.code === 190 ? ' Token inválido ou expirado: gere um novo token de Usuário do Sistema (ads_read) e atualize o secret META_ACCESS_TOKEN.'
      : [200, 10, 100].includes(e.code) ? ' Confira se o token tem acesso a esta conta de anúncios no Business Manager.' : '';
    console.error(`::error title=Falha na conta ${acc.name}::${e.message}.${hint}`);
    failed.push({ key: acc.key, name: acc.name, error: e.message });
    if (e.code === 190) { tokenInvalid = true; break; }
    out.rows[acc.key] = prev?.rows?.[acc.key] || [];
  }
}

if (tokenInvalid) { console.error('Token inválido: nada foi publicado.'); process.exit(1); }
if (failed.length === accounts.length) { console.error('Todas as contas falharam. data.json não foi alterado.'); process.exit(1); }
if (!Object.values(out.rows).some(r => r.length)) { console.error('::error title=Sem dados::Nenhum dado retornado. data.json não foi alterado.'); process.exit(1); }

if (failed.length) {
  out.failed = failed.map(f => f.key);                 // contas com dado desatualizado
  out.failedSince = prev?.updatedAt || null;
  console.warn(`::warning title=Dashboard parcial::${failed.length} conta(s) com erro: ${failed.map(f => f.name).join(', ')}. As demais foram atualizadas.`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const tmp = OUT + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(out));
fs.renameSync(tmp, OUT);
console.log(`\ndata.json atualizado (${START} a ${today}).`);
