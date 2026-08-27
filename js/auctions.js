import { ASSET_TYPES, findStructureByAssetId, recordStructureTransfer } from './constants.js';
import { POPULATION, adjustSavings, logEvent, world } from './state.js';
import { discountRate } from './prices.js';
import { profSessionEV } from './valuation.js';
import { ASSET_VALUE_HORIZON, estimateAssetValue } from './actions.js';
import { killNPC } from './death.js';
import { CHURCH_RESERVE } from './capital.js';

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
  const def = ASSET_TYPES[asset.type];
  if (!def) return 0;
  const profId = def.profession;
  // hasWorkableAsset() (called inside profSessionEV) checks asset.ownerId
  // === npc.id — correct for real gating, but a prospective BIDDER doesn't
  // own the asset yet (that's the entire point of bidding on it). So the
  // hypothetical swap has to temporarily reassign ownership too, alongside
  // profession/primaryAsset, then restore all three. Same pattern as the
  // estimateAssetValue/planTinkerAction fix — any hypothetical "what if I
  // operated this asset" check needs the full ownership triple swapped.
  const savedProf = npc.profession, savedPrimary = npc.primaryAsset, savedOwner = asset.ownerId;
  let dailyEV;
  try {
    npc.profession = profId; npc.primaryAsset = asset.id; asset.ownerId = npc.id;
    dailyEV = profSessionEV(npc, profId);
  } finally {
    // FIX: same try/finally guarantee as estimateAssetValue — see that
    // comment for why this matters.
    npc.profession = savedProf; npc.primaryAsset = savedPrimary; asset.ownerId = savedOwner;
  }
  if (!isFinite(dailyEV) || dailyEV <= 0) return 0;
  const discRate = discountRate(npc);
  const pv = dailyEV * (1 - Math.pow(1 - discRate, ASSET_VALUE_HORIZON)) / discRate;
  return Math.max(pv * asset.quality, 0);
}

// ── Installment financing, through a Bank ──────────────────────────────
// A pre-modern village auction with all-cash bidding, checked against a
// reserve pegged to the WEALTHIEST villager, creates a liquidity trap:
// nearly everyone's spare savings sit near zero while one or two outliers
// hold most of the village's cash (a realistic wealth distribution, but
// one that makes an all-cash market clear only for the very richest).
// Real small economies solve this with credit.
//
// This used to be seller-financed (the seller carried the buyer's IOU
// directly and collected installments over months). It's now a proper
// third institution alongside the Market and the Church: the BANK
// advances the seller the full financed amount in cash immediately (see
// runAssetAuctions), and the buyer's installment obligation is owed to
// the Bank, not the seller. This is what a real bank actually does —
// removes the seller's collection risk entirely (they're paid in full,
// today), and concentrates credit risk in one institution with its own
// reserve, capitalization, and (via distributeBankInterest) a way to pay
// some of its interest income back out to the village, the same
// three-institution pattern as Market dividends and Church alms.
export const DOWN_PAYMENT_FRACTION = 0.35;   // buyer must have at least this much of their bid in cash now
export const DEBT_TERM_DAYS        = 240;    // remaining balance amortized over ~8 months
export const DEBT_INTEREST_DAILY   = 0.0006; // mild carrying cost — keeps credit from being strictly free money

// Sized the same way the Market's cash pools are (see makeMarketGood): a
// bank that starts near its own reserve floor can't fund a single loan
// until it's somehow already collected interest from loans it was never
// able to issue. POPULATION * 250 gives the Bank enough capacity to fund
// several simultaneous asset-financing deals (bids can run into the
// thousands for the wealthiest bidders) without immediately hitting its
// own liquidity ceiling — tune alongside DOWN_PAYMENT_FRACTION if the
// Bank is chronically illiquid or chronically overflowing in testing.
// BANK_INITIAL_RESERVE/BANK_RESERVE depend on POPULATION (from state.js),
// but this file participates in the same import cycle as state.js/npc.js,
// so POPULATION isn't safely readable at this module's top level (it may
// not be initialized yet depending on load order). Computed lazily inside
// initBank() instead, which main.js calls once every module has loaded.
export let BANK_INITIAL_RESERVE;
export let BANK_RESERVE; // floor kept before any interest is paid out
export const BANK_PAYOUT_RATE = 0.05; // fraction of excess-above-reserve paid out per day — smoothed, not dumped all at once

// Seeds the Bank's starting cash. Called once from main.js's init sequence
// (see initWorld() in npc.js) rather than at module-load time.
export function initBank() {
  BANK_INITIAL_RESERVE = POPULATION * 250;
  BANK_RESERVE = BANK_INITIAL_RESERVE * 0.5;
  world.bank.cash = BANK_INITIAL_RESERVE;
}

// principal is what the Bank actually advances right now (see
// runAssetAuctions) — the debtor's obligation and the Bank's outgoing
// cash are always the same number, by construction, so the books balance
// by construction rather than needing a reconciliation step.
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
  let totalOutstanding = 0;
  for (const npc of world.npcs.values()) {
    if (!npc.debts || npc.debts.length === 0) continue;
    for (const debt of npc.debts) {
      const payment = Math.min(debt.dailyPayment, debt.remaining, npc.savings);
      if (payment > 0) {
        adjustSavings(npc, -payment, 'debt_payment');
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
      const shortfall = debt.dailyPayment - payment;
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
  const excess = Math.max(0, world.bank.cash - BANK_RESERVE);
  world.bank.interestPaidToday = 0;
  if (excess < 0.5) return;

  const npcs = [...world.npcs.values()];
  const totalSavings = npcs.reduce((s, n) => s + n.savings, 0);
  if (totalSavings < 1) return;

  const payout = excess * BANK_PAYOUT_RATE; // smoothed — most of the excess stays as growing capital, not dumped in one day
  for (const n of npcs) {
    adjustSavings(n, payout * (n.savings / totalSavings), 'bank_interest');
  }
  world.bank.cash -= payout;
  world.bank.interestPaidToday = payout;
  logEvent(`The Bank paid out ${payout.toFixed(0)}¢ in interest on savings.`, npcs.map(n => n.id));
}

export function runAssetAuctions() {
  const forSaleAssets = [...world.assets.values()].filter(a => a.forSale);
  if (forSaleAssets.length === 0) return;

  for (const asset of forSaleAssets) {
    const seller = world.npcs.get(asset.ownerId); // undefined if orphaned (owner died with no living heir — see killNPC)

    // Reserve pegged to MEDIAN village savings, not the max — an auction
    // that only ever prices to what the single richest villager could
    // theoretically pay will clear for nobody else, no matter how many
    // auction cycles pass. Median reflects what a realistically-positioned
    // buyer can actually bring to the table.
    const sortedSavings = [...world.npcs.values()].map(n => n.savings).sort((a,b) => a-b);
    const medianSavings = sortedSavings[Math.floor(sortedSavings.length / 2)];

    // Reserve also decays with repeated failed auction cycles — same as a
    // real property listing that sits unsold: sellers eventually lower
    // their asking price rather than holding out forever at a level the
    // market has already shown it won't clear.
    asset.auctionAttempts = asset.auctionAttempts || 0;
    const decayFactor = Math.pow(0.85, asset.auctionAttempts);
    // An orphaned/unclaimed estate has no owner with a reservation value
    // to protect — priced to move (a flat fraction of median savings)
    // rather than held to what a living owner would have wanted.
    const sellerReserveValue = seller
      ? Math.min(estimateAssetValue(seller, asset), medianSavings * 3) * AUCTION_MIN_RESERVE_FRACTION * decayFactor
      : medianSavings * 0.3 * decayFactor;

    let bestBidder = null, bestBid = -Infinity;
    for (const npc of world.npcs.values()) {
      if (npc.id === asset.ownerId) continue; // can't buy your own asset
      const valuation = bidValueForAsset(npc, asset);
      if (valuation <= 0) continue;
      // A rational bidder doesn't bid their full valuation — leaves a
      // margin, same spirit as any auction with more than one bidder.
      // No longer capped by cash-in-hand alone: a bidder can finance the
      // majority of a bid on credit (see DOWN_PAYMENT_FRACTION below), so
      // the true constraint is "can I afford the down payment," not "do I
      // have the entire price sitting in savings" — this is the direct
      // fix for the liquidity trap the all-cash version produced.
      // Real borrowers are risk-conscious, not maximally leveraged: a
      // rational villager doesn't borrow up to the hilt on a hypothetical
      // future income stream, and existing debt obligations directly
      // reduce how much MORE they're willing/able to take on — the same
      // "debt-service-to-income" intuition that caps real-world mortgage
      // borrowing.
      const existingDebtBurden = (npc.debts || []).reduce((s, d) => s + d.remaining, 0);
      const MAX_LEVERAGE_MULTIPLE = 2.5; // total financed principal capped at 2.5x current savings, not unbounded
      const netBorrowingCapacity = Math.max(0, (npc.savings * (1 + MAX_LEVERAGE_MULTIPLE)) - existingDebtBurden);

      // RISK-AVERSION DISCOUNT: a forward-looking bidder discounts their
      // own valuation the more of the purchase they'd need to finance —
      // real people don't treat a fully-leveraged, debt-financed asset as
      // worth the same to them as one they could pay for outright. This
      // also directly captures interest cost (DEBT_INTEREST_DAILY over
      // DEBT_TERM_DAYS): a bidder correctly perceives that financing X
      // actually costs them more than X once interest is included, so
      // they should only be willing to bid less for the same asset the
      // more debt they'd need to take on, exactly mirroring how a real
      // buyer facing seller-financed interest bids more conservatively
      // than one paying cash.
      const financedFraction = 1 - DOWN_PAYMENT_FRACTION;
      const totalInterestMultiple = 1 + DEBT_INTEREST_DAILY * DEBT_TERM_DAYS; // total repaid per dollar financed
      const existingBurdenRatio = npc.savings > 0 ? Math.min(2, existingDebtBurden / npc.savings) : 2;
      // Discount grows with (a) how much interest financing costs and
      // (b) how debt-burdened this bidder already is — a clean villager
      // with no debt discounts only for interest; someone already
      // leveraged discounts much harder, i.e. bids far more conservatively.
      const riskDiscount = 1 / (totalInterestMultiple * (1 + existingBurdenRatio));
      const desiredBid = valuation * 0.85 * riskDiscount;

      const maxAffordableViaCredit = Math.min(
        npc.savings / DOWN_PAYMENT_FRACTION, // must still cover the down payment fraction in cash
        netBorrowingCapacity                  // and stay within a sane, debt-aware leverage ceiling
      );
      const bid = Math.min(desiredBid, maxAffordableViaCredit);
      if (bid <= 0) continue;
      if (bid > bestBid) { bestBid = bid; bestBidder = npc; }
    }

    if (bestBidder && bestBid >= sellerReserveValue && bestBid > 0.01) {
      // Settle via down payment + seller-financed installment debt rather
      // than requiring the full price in cash today.
      const downPayment = Math.min(bestBid * DOWN_PAYMENT_FRACTION, bestBidder.savings);
      const financedAmount = bestBid - downPayment;

      adjustSavings(bestBidder, -downPayment, 'asset_purchase');
      // Orphaned estate (owner died with no heir — see killNPC): there's
      // no seller to pay, so proceeds go to the Church instead, same
      // "unclaimed estate" handling as any other institutional windfall,
      // rather than vanishing or crediting a dead id.
      if (seller) adjustSavings(seller, downPayment, 'asset_sale');
      else world.church.cash += downPayment;
      if (financedAmount > 0.01) {
        // The Bank advances the seller the financed portion in full,
        // right now — capped by what the Bank actually has on hand. In
        // the rare case the Bank's reserve can't cover the whole request
        // (e.g. a run of large loans issued in a short span), the seller
        // simply receives less and the buyer's loan shrinks to match:
        // the Bank never advances more than it holds, so world money
        // stays exactly conserved even under this constraint, and the
        // shortfall self-corrects as outstanding loans get repaid and
        // the Bank's reserve recovers (see serviceDebts/
        // distributeBankInterest).
        const bankFunded = Math.min(financedAmount, world.bank.cash);
        if (seller) adjustSavings(seller, bankFunded, 'asset_sale');
        else world.church.cash += bankFunded;
        if (bankFunded > 0.01) issueDebt(bestBidder, bankFunded);
      }

      if (seller) {
        seller.ownedAssets = seller.ownedAssets.filter(id => id !== asset.id);
        // FIX: this was the actual remaining leak behind the recurring
        // stale-pointer corruption. Since owners now keep working a listed
        // asset right up until it sells (a deliberate earlier fix), the
        // seller can still be its primaryAsset at the exact moment the
        // auction settles here — and this code was never updated to clear
        // that pointer on transfer. The seller instantly becomes
        // asset-less in that profession the moment ownership actually
        // changes hands, which is correct and matches how a real sale
        // works (you don't get to keep operating what you just sold).
        if (seller.primaryAsset === asset.id) {
          seller.primaryAsset = null;
        }
      }
      bestBidder.ownedAssets.push(asset.id);
      const sellerIdForHistory = asset.ownerId;
      asset.ownerId = bestBidder.id;
      recordStructureTransfer(findStructureByAssetId(asset.id), sellerIdForHistory, bestBidder.id, seller ? 'sold' : 'inherited (unclaimed estate)');
      asset.forSale = false;
      asset.starvingStreak = 0;
      asset.auctionAttempts = 0;
      asset.idleSinceDay = undefined; // fresh grace period for the new owner

      // New owner immediately starts operating it only if they currently
      // have no primary asset (i.e., they were asset-less in some
      // profession) — otherwise it's a spare they now hold, same as any
      // NPC who happens to own more than one asset.
      if (bestBidder.primaryAsset === null || bestBidder.primaryAsset === undefined) {
        bestBidder.primaryAsset = asset.id;
      }

      const financeNote = financedAmount > 0.01 ? ` (${downPayment.toFixed(0)}¢ down, ${financedAmount.toFixed(0)}¢ financed)` : '';
      logEvent(
        seller
          ? `${bestBidder.name} won the auction for ${seller.name}'s ${ASSET_TYPES[asset.type].name} (${bestBid.toFixed(0)}¢${financeNote}).`
          : `${bestBidder.name} won the auction for an unclaimed ${ASSET_TYPES[asset.type].name} (${bestBid.toFixed(0)}¢${financeNote}).`,
        seller ? [bestBidder.id, seller.id] : [bestBidder.id]
      );
    } else {
      // No qualifying bid — asset remains forSale, reserve decays for next cycle.
      asset.auctionAttempts++;
    }
  }
}


export function distributeChurchAlms() {
  const excess = Math.max(0, world.church.cash - CHURCH_RESERVE);
  if (excess < 0.5) return;

  const npcs = [...world.npcs.values()];
  const meanSavings = npcs.reduce((s, n) => s + n.savings, 0) / npcs.length;
  const needy = npcs
    .map(n => ({ n, shortfall: Math.max(0, meanSavings - n.savings) }))
    .filter(x => x.shortfall > 0.5);
  const totalShortfall = needy.reduce((s, x) => s + x.shortfall, 0);

  world.church.cash -= excess;
  if (totalShortfall >= 0.5) {
    // Normal case: hand out alms proportional to how far behind the
    // village mean each NPC has fallen.
    for (const { n, shortfall } of needy) {
      adjustSavings(n, excess * (shortfall / totalShortfall), 'alms');
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
    const perCapita = excess / npcs.length;
    for (const n of npcs) adjustSavings(n, perCapita, 'alms');
  }

  if (excess > 1) {
    const text = totalShortfall >= 0.5
      ? `The Church distributed ${excess.toFixed(0)}¢ in alms to ${needy.length} in need.`
      : `The Church distributed ${excess.toFixed(0)}¢ evenly among the village.`;
    logEvent(text, totalShortfall >= 0.5 ? needy.map(x => x.n.id) : []);
  }
}

