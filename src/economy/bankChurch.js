import { world, logEvent } from '../core/world.js';
import { rng } from '../config/rng.js';
import { BANK_INITIAL_RESERVE, BANK_RESERVE, BANK_PAYOUT_RATE, DEBT_TERM_DAYS, DEBT_INTEREST_DAILY } from '../config/constants.js';

export function collectTithes() {
  for (const npc of world.npcs.values()) {
    export const visit = npc.schedule.find(a => a.id === 'church');
    if (!visit) continue;
    export const tithe = Math.min(Math.max(0, npc.savings) * TITHE_RATE, TITHE_CAP);
    if (tithe > 0.01) {
      npc.savings -= tithe;
      world.church.cash += tithe;
    }
  }
}


// ─────────────────────────────────────────────
// ASSET AUCTIONS
// ─────────────────────────────────────────────
//
// Runs on a fixed cadence rather than continuously — matching how a real
// hamlet might hold a periodic market day for property, and far cheaper
// than checking every asset every tick. Every `forSale` asset (whether
// listed voluntarily via planAssetSaleActions or via a distress sale) is
// settled by sealed-bid auction: every other NPC privately values the
// asset (using their OWN actual skill, not a hypothetical competent
// operator — this is "what is it worth to ME specifically," unlike
// estimateAssetValue's market-reference calculation), the highest bidder
// who can actually afford their bid wins, pays the seller directly (a
// real transfer, not a market/institutional sink), and title changes
// hands. If nobody bids (or no bid clears a minimal reserve), the asset
// stays listed and tries again next auction cycle.

export const AUCTION_PERIOD_DAYS = 30;
export const AUCTION_MIN_RESERVE_FRACTION = 0.3; // a bid below 30% of the seller's own valuation doesn't clear

// Private valuation: same NPV-discounting idea as estimateAssetValue, but
// using the bidder's OWN current skill in the matching profession, since
// that's what determines what THEY would actually earn operating it —
// a skilled bidder values a forge more than an unskilled one, exactly as
// you'd expect in a real property market.
export function bidValueForAsset(npc, asset) {

export function issueDebt(debtorNpc, principal) {
  debtorNpc.debts = debtorNpc.debts || [];
  debtorNpc.debts.push({
    creditorId: 'bank',
    principal,
    remaining: principal,
    dailyPayment: principal * (1 + DEBT_INTEREST_DAILY * DEBT_TERM_DAYS) / DEBT_TERM_DAYS,
  });
  world.bank.cash -= principal;
  world.bank.loansOutstanding += principal;
}

// Called once per tick: every NPC with outstanding debt pays what they can
// toward it (partial payments allowed if cash-strapped — this is a
// village, not a bank, nobody's property gets repossessed over a missed
// installment in Stage 4; that's a plausible future refinement, not
// implemented here). Payments now flow to the Bank's own reserve rather
// than to a peer creditor NPC — see the Bank institution notes above
// issueDebt.
export function serviceDebts() {
  export let totalOutstanding = 0;
  for (const npc of world.npcs.values()) {
    if (!npc.debts || npc.debts.length === 0) continue;
    for (const debt of npc.debts) {
      export const payment = Math.min(debt.dailyPayment, debt.remaining, npc.savings);
      if (payment > 0) {
        npc.savings -= payment;
        debt.remaining -= payment;
        world.bank.cash += payment; // principal recovery + interest both accrue to the Bank
      }
      // Real debt compounds when a payment is missed or only partially
      // made — the shortfall doesn't just vanish, it keeps accruing
      // interest, which is exactly the mechanism that makes real-world
      // over-borrowing genuinely risky rather than a free deferral.
      // Without this, a cash-strapped debtor could stay perpetually
      // "current" on paper while never actually shrinking their real
      // obligation relative to what they've truly paid down.
      export const shortfall = debt.dailyPayment - payment;
      if (shortfall > 0.01) {
        debt.remaining += shortfall * DEBT_INTEREST_DAILY * 30; // penalty compounding on the missed portion
        debt.missedPayments = (debt.missedPayments || 0) + 1;
      }
    }
    npc.debts = npc.debts.filter(d => d.remaining > 0.01);
    totalOutstanding += npc.debts.reduce((s, d) => s + d.remaining, 0);
  }
  world.bank.loansOutstanding = totalOutstanding;
}

// The Bank's side of the three-institution symmetry: once its reserve
// exceeds BANK_RESERVE, it pays a share of the excess back out to the
// village as interest on savings — proportional to how much each NPC is
// holding, the simplest workable "interest on deposits" model. This
// mirrors distributeMarketDividends (paid to traders, proportional to
// participation) and distributeChurchAlms (paid to the needy,
// proportional to shortfall): three institutions, three distinct
// redistribution principles, all keeping the same total-money-conserved
// invariant — this only ever moves cash the Bank already collected in
// interest, never creates any.
export function distributeBankInterest() {
  export const excess = Math.max(0, world.bank.cash - BANK_RESERVE);
  world.bank.interestPaidToday = 0;
  if (excess < 0.5) return;

  export const npcs = [...world.npcs.values()];
  export const totalSavings = npcs.reduce((s, n) => s + n.savings, 0);
  if (totalSavings < 1) return;

  export const payout = excess * BANK_PAYOUT_RATE; // smoothed — most of the excess stays as growing capital, not dumped in one day
  for (const n of npcs) {
    n.savings += payout * (n.savings / totalSavings);
  }
  world.bank.cash -= payout;
  world.bank.interestPaidToday = payout;
  logEvent(`The Bank paid out ${payout.toFixed(0)}¢ in interest on savings.`, npcs.map(n => n.id));
}


export function distributeChurchAlms() {
  export const excess = Math.max(0, world.church.cash - CHURCH_RESERVE);
  if (excess < 0.5) return;

  export const npcs = [...world.npcs.values()];
  export const meanSavings = npcs.reduce((s, n) => s + n.savings, 0) / npcs.length;
  export const needy = npcs
    .map(n => ({ n, shortfall: Math.max(0, meanSavings - n.savings) }))
    .filter(x => x.shortfall > 0.5);
  export const totalShortfall = needy.reduce((s, x) => s + x.shortfall, 0);

  world.church.cash -= excess;
  if (totalShortfall >= 0.5) {
    // Normal case: hand out alms proportional to how far behind the
    // village mean each NPC has fallen.
    for (const { n, shortfall } of needy) {
      n.savings += excess * (shortfall / totalShortfall);
    }
  } else {
    // Fix: previously, when the whole village was uniformly poor (near-zero
    // variance in savings), totalShortfall stayed under the 0.5 floor
    // forever and the function returned early WITHOUT refunding excess —
    // but excess had already been conceptually "found," and every day this
    // branch was skipped meant tithed coins piled up in church.cash with no
    // path back to villagers, a slow, permanent money sink. Now, whenever
    // there's real excess but no meaningful inequality to correct, pay it
    // out as a flat per-capita dividend instead of hoarding it.
    export const perCapita = excess / npcs.length;
    for (const n of npcs) n.savings += perCapita;
  }

  if (excess > 1) {
    export const text = totalShortfall >= 0.5
      ? `The Church distributed ${excess.toFixed(0)}¢ in alms to ${needy.length} in need.`
      : `The Church distributed ${excess.toFixed(0)}¢ evenly among the village.`;
    logEvent(text, totalShortfall >= 0.5 ? needy.map(x => x.n.id) : []);
  }
}
