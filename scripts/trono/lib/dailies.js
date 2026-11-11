/**
 * Daily quest engine.
 *
 * Flow (verified against the live board):
 *   1. OFFERS  : /pages/quests_main.php?view=ofertas
 *                accept -> form POST quest_action=accept_offer&instance_id=..&csrf=..
 *   2. ACTIVE  : /pages/quests_main.php?cat=diarias&estado=active
 *   3. CLAIM   : form POST quest_action=claim_..&instance_id=..&csrf=..
 *
 * Progress only counts AFTER accepting ("Solo cuentan las acciones que realices
 * después de aceptarlas"), so accepting must happen before the fight loop.
 */
const OFFERS_URL = '/pages/quests_main.php?view=ofertas';
const BOARD_BASE = '/pages/quests_main.php?cat=diarias';

const clean = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function formFields(formHtml) {
  const fields = {};
  for (const m of formHtml.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) {
    fields[m[1]] = m[2];
  }
  return fields;
}

/** Offers currently on the board, with objectives and rewards. */
async function offers(g) {
  const page = await g.fetchPage(OFFERS_URL);
  if (!page.ok) throw new Error(`offers HTTP ${page.status}`);
  const main = (page.html.match(/<main[\s\S]*?<\/main>/i) || [])[0] || page.html;

  // One block per offer. The board renders them as <template data-mission-selection="..">.
  const blocks = main
    .split(/(?=<template[^>]*data-mission-selection=")/)
    .filter((b) => /data-mission-selection="\d+"/.test(b));
  const out = [];
  for (const block of blocks) {
    const id = /data-mission-selection="(\d+)"/.exec(block)?.[1];
    if (!id) continue;
    const text = clean(block);
    const acceptForm = [...block.matchAll(/<form[\s\S]{0,1200}?<\/form>/g)]
      .map((f) => ({ html: f[0], fields: formFields(f[0]) }))
      .find((f) => f.fields.quest_action === 'accept_offer' && f.fields.instance_id === id);
    const objectives = [...text.matchAll(/([A-ZÁÉÍÓÚ][^.]{4,80}?)\s(\d+)\s*\/\s*(\d+)/g)].map((m) => ({
      text: m[1].trim(),
      current: Number(m[2]),
      target: Number(m[3])
    }));
    out.push({
      instanceId: Number(id),
      title: (/^([^|]{3,60}?)\s+(Diaria|Semanal|Especial)/.exec(text) || [])[1] || null,
      text: text.slice(0, 420),
      gold: Number((/Oro Imperial (\d+)/.exec(text) || [])[1] || 0),
      exp: Number((/(\d+)\s*EXP/.exec(text) || [])[1] || 0),
      objectives,
      acceptFields: acceptForm ? acceptForm.fields : null
    });
  }
  return { csrf: findCsrf(main), list: out };
}

function findCsrf(html) {
  const m = /<input[^>]*name="csrf"[^>]*value="([0-9a-f]{16,64})"/.exec(html);
  return m ? m[1] : null;
}

/** Quests currently in progress (accepted, not yet claimed). */
async function active(g) {
  const page = await g.fetchPage(`${BOARD_BASE}&estado=active`);
  if (!page.ok) throw new Error(`active quests HTTP ${page.status}`);
  const main = (page.html.match(/<main[\s\S]*?<\/main>/i) || [])[0] || page.html;
  const text = clean(main);
  const progress = [...text.matchAll(/(Derrota|Recolecta|Consigue|Abre|Fabrica|Usa|Mejora|Realiza|Gasta|Visita|Completa)[^.]{0,60}?(\d+)\s*\/\s*(\d+)/gi)].map((m) => ({
    text: m[0].trim(),
    current: Number(m[2]),
    target: Number(m[3])
  }));
  return { csrf: findCsrf(main), progress, text: text.slice(0, 1200), html: page.html };
}

/** Quests whose objectives are met and can be claimed right now. */
async function ready(g) {
  const page = await g.fetchPage(`${BOARD_BASE}&estado=ready`);
  if (!page.ok) throw new Error(`ready quests HTTP ${page.status}`);
  const main = (page.html.match(/<main[\s\S]*?<\/main>/i) || [])[0] || page.html;
  const forms = [...main.matchAll(/<form[\s\S]{0,1200}?<\/form>/g)]
    .map((f) => formFields(f[0]))
    .filter((f) => f.quest_action && f.quest_action !== 'claim_activity' && f.quest_action !== 'claim_activity_all');
  const clean2 = clean(main);
  return { csrf: findCsrf(main), forms, text: clean2.slice(0, 900) };
}

/** Accept one offer by instance id (uses the form the board rendered). */
async function accept(g, instanceId, csrf, opts = {}) {
  if (!opts.allowMutate) throw new Error('MUTATION_BLOCKED: accept needs allowMutate');
  const res = await g.postForm(
    OFFERS_URL,
    { csrf, quest_action: 'accept_offer', instance_id: String(instanceId) },
    { allowMutate: true }
  );
  return res;
}

/** Accept every offer whose objectives we can realistically complete in combat. */
async function acceptAll(g, opts = {}) {
  const { csrf, list } = await offers(g);
  if (!csrf) return { accepted: [], reason: 'no csrf on offers page' };
  const accepted = [];
  for (const offer of list) {
    const res = await accept(g, offer.instanceId, csrf, opts);
    accepted.push({ instanceId: offer.instanceId, title: offer.title, status: res && res.status });
  }
  return { accepted, count: accepted.length };
}

/** Claim every quest that reports ready. */
async function claimAll(g, opts = {}) {
  const r = await ready(g);
  if (!r.csrf || !r.forms.length) return { claimed: [], reason: r.forms.length ? 'no csrf' : 'nothing ready' };
  const claimed = [];
  for (const fields of r.forms) {
    const res = await g.postForm('/pages/quests_main.php', fields, { allowMutate: !!opts.allowMutate });
    claimed.push({ action: fields.quest_action, instanceId: fields.instance_id, status: res && res.status });
  }
  return { claimed };
}

module.exports = { OFFERS_URL, BOARD_BASE, offers, active, ready, accept, acceptAll, claimAll, findCsrf, clean };
