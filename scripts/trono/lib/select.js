/**
 * Fight selection policy.
 *
 * The economy of this game is gated by stamina, not by HP:
 *
 *   240 stamina/day  -> 80 Brumak kills
 *   13,737 HP/day    -> ~149 Brumak kills   (636 maxHp, 1.5%/min)
 *
 * So HP sits at full while stamina never does. A stamina point is therefore
 * permanent: spending it on a tier that pays 2 or 3 gold when 4.5 is reachable
 * is gold thrown away, and no amount of resting brings it back (resting only
 * refills HP, and HP was never the constraint).
 *
 * The policy:
 *   1. Discard tiers the hero could never start, buffer included. Eryndor costs
 *      627 HP against a 636 pool, so ranking by raw gold/stamina would chase a
 *      fight that is unreachable no matter how rich the account gets.
 *   2. Rank what is left by gold per day, which already discounts whichever
 *      budget binds first, and spend on the top tier that is affordable now.
 *      Ranking by gold per stamina instead is a trap: it picks Morvak (4.5 gold
 *      per stamina) over Brumak (4.0), but Morvak costs 387 HP so it only
 *      sustains 35 kills a day, eats the whole HP budget and leaves stamina
 *      unspent. Gold per day correctly keeps Brumak on top.
 *   3. If a worse tier is affordable and the top one is not, wait for HP —
 *      unless the wait would cap the stamina bar, in which case the regeneration
 *      would be lost anyway and the cheaper fight is the better trade.
 *
 * Known headroom, not implemented: a mixed schedule (about 24 Morvak + 48
 * Brumak) reaches roughly 1,008 gold/day instead of 960, a 5% gain, but it needs
 * day-level accounting of both budgets to avoid starving stamina. Not worth the
 * risk in a live loop for 5%.
 *
 * This module holds no I/O so the decision can be tested on a grid of HP and
 * stamina values without touching the game or the browser.
 */

/** Fraction of max HP kept as a safety margin before starting a fight. */
const HP_MARGIN = 0.12;
/** Reduced margin used only when the normal margin makes every tier unreachable. */
const HP_MARGIN_MIN = 0.04;
/** Stamina regenerates 10/hour (measured from vitals.regeneration.stamina). */
const STAMINA_PER_MIN = 10 / 60;
/** Hospital rest refills HP at 2%/min; passive regeneration is 1.5%/min. */
const REST_FRACTION_PER_MIN = 0.02;

function chooseFight(hero, targets, opts = {}) {
  const maxFights = opts.maxFights || 2;
  const winnable = (targets || []).filter((t) => t.win && !t.coolingDown);
  if (!winnable.length) {
    return { action: 'wait', plan: [], reason: 'no winnable target with current stats' };
  }

  const fits = (t, margin) => t.hpCost + margin <= hero.maxHp;
  let margin = Math.round(hero.maxHp * HP_MARGIN);
  let reachable = winnable.filter((t) => fits(t, margin));
  if (!reachable.length) {
    margin = Math.round(hero.maxHp * HP_MARGIN_MIN);
    reachable = winnable.filter((t) => fits(t, margin));
  }
  if (!reachable.length) {
    return { action: 'wait', plan: [], reason: 'no winnable target fits the HP pool' };
  }

  const byYield = reachable.slice().sort((a, b) => b.goldPerDay - a.goldPerDay || b.goldPerStamina - a.goldPerStamina);
  const tier = byYield[0];
  const affordable = byYield.filter((t) => t.hpCost + margin <= hero.hp);

  if (!affordable.length) {
    const need = tier.hpCost + margin - hero.hp;
    const perMin = Math.max(1, Math.round(hero.maxHp * REST_FRACTION_PER_MIN));
    const minToReady = Math.ceil(need / perMin);
    return {
      action: 'wait',
      plan: [],
      tier,
      margin,
      reason: `resting: need ${need} HP for ${tier.name} (~${minToReady} min at ${perMin} HP/min)`
    };
  }

  const pick = affordable[0];
  if (pick.key === tier.key) {
    // The runner re-reads HP between kills and breaks when the margin stops
    // holding, so repeating the entry keeps the multi-kill tick on one tier.
    return {
      action: 'fight',
      plan: Array.from({ length: maxFights }, () => tier),
      tier,
      margin,
      notable: false,
      reason: `${tier.name} is both the best yield (${tier.goldPerStamina} gold/stamina) and affordable`
    };
  }

  const need = tier.hpCost + margin - hero.hp;
  const perMin = Math.max(1, Math.round(hero.maxHp * REST_FRACTION_PER_MIN));
  const minToReady = Math.ceil(need / perMin);
  const maxStamina = hero.maxStamina || 65;
  const wouldCap = Math.max(0, hero.stamina + STAMINA_PER_MIN * minToReady - maxStamina);

  if (wouldCap >= pick.stamina) {
    return {
      action: 'fight',
      plan: Array.from({ length: maxFights }, () => pick),
      tier: pick,
      margin,
      notable: true,
      reason: `stamina would cap (${hero.stamina}/${maxStamina}, ~${wouldCap.toFixed(1)} lost in ${minToReady} min) — spending it on ${pick.name} (${pick.goldPerStamina} gold/stamina) while ${tier.name} regenerates`
    };
  }

  return {
    action: 'wait',
    plan: [],
    tier,
    margin,
    reason: `waiting for HP: ${tier.name} pays ${tier.goldPerStamina} gold/stamina, best affordable now is ${pick.name} at ${pick.goldPerStamina} — need ${need} HP (~${minToReady} min, stamina ${hero.stamina}/${maxStamina} will not cap)`
  };
}

module.exports = { chooseFight, HP_MARGIN, STAMINA_PER_MIN, REST_FRACTION_PER_MIN };
