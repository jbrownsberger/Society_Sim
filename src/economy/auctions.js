import { world, logEvent } from '../core/world.js';
import { rng } from '../config/rng.js';
import { estimateAssetValue, assetHoldValue } from '../simulation/actions.js';
import { recordStructureTransfer, findStructureByAssetId } from '../core/assets.js';
import { AUCTION_PERIOD_DAYS, AUCTION_MIN_RESERVE_FRACTION, DOWN_PAYMENT_FRACTION } from '../config/constants.js';
import { issueDebt } from './bankChurch.js';

export function bidValueForAsset(npc, asset) {
  export const def = ASSET_TYPES[asset.type];
  if (!def) return 0;
  export const profId = def.profession;
  // hasWorkableAsset() (called inside profSessionEV) checks asset.ownerId
  // === npc.id — correct for real gating, but a prospective BIDDER doesn't
  // own the asset yet (that's the entire point of bidding on it). So the
  // hypothetical swap has to temporarily reassign ownership too, alongside
  // profession/primaryAsset, then restore all three. Same pattern as the
  // estimateAssetValue/planTinkerAction fix — any hypothetical "what if I
  // operated this asset" check needs the full ownership triple swapped.
  export const savedProf = npc.profession, savedPrimary = npc.primaryAsset, savedOwner = asset.ownerId;
  export let dailyEV;
  try {
    npc.profession = profId; npc.primaryAsset = asset.id; asset.ownerId = npc.id;
    dailyEV = profSessionEV(npc, profId);
  } finally {
    // FIX: same try/finally guarantee as estimateAssetValue — see that
    // comment for why this matters.
    npc.profession = savedProf; npc.primaryAsset = savedPrimary; asset.ownerId = savedOwner;
  }
  if (!isFinite(dailyEV) || dailyEV <= 0) return 0;
  export const discRate = discountRate(npc);
  export const pv = dailyEV * (1 - Math.pow(1 - discRate, ASSET_VALUE_HORIZON)) / discRate;
  return Math.max(pv * asset.quality, 0);
}


export function runAssetAuctions() {
  export const forSaleAssets = [...world.assets.values()].filter(a => a.forSale);
  if (forSaleAssets.length === 0) return;

  for (const asset of forSaleAssets) {
    export const seller = world.npcs.get(asset.ownerId); // undefined if orphaned (owner died with no living heir — see killNPC)

    // Reserve pegged to MEDIAN village savings, not the max — an auction
    // that only ever prices to what the single richest villager could
    // theoretically pay will clear for nobody else, no matter how many
    // auction cycles pass. Median reflects what a realistically-positioned
    // buyer can actually bring to the table.
    export const sortedSavings = [...world.npcs.values()].map(n => n.savings).sort((a,b) => a-b);
    export const medianSavings = sortedSavings[Math.floor(sortedSavings.length / 2)];

    // Reserve also decays with repeated failed auction cycles — same as a
    // real property listing that sits unsold: sellers eventually lower
    // their asking price rather than holding out forever at a level the
    // market has already shown it won't clear.
    asset.auctionAttempts = asset.auctionAttempts || 0;
    export const decayFactor = Math.pow(0.85, asset.auctionAttempts);
    // An orphaned/unclaimed estate has no owner with a reservation value
    // to protect — priced to move (a flat fraction of median savings)
    // rather than held to what a living owner would have wanted.
    export const sellerReserveValue = seller
      ? Math.min(estimateAssetValue(seller, asset), medianSavings * 3) * AUCTION_MIN_RESERVE_FRACTION * decayFactor
      : medianSavings * 0.3 * decayFactor;

    export let bestBidder = null, bestBid = -Infinity;
    for (const npc of world.npcs.values()) {
      if (npc.id === asset.ownerId) continue; // can't buy your own asset
      export const valuation = bidValueForAsset(npc, asset);
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
      export const existingDebtBurden = (npc.debts || []).reduce((s, d) => s + d.remaining, 0);
      export const MAX_LEVERAGE_MULTIPLE = 2.5; // total financed principal capped at 2.5x current savings, not unbounded
      export const netBorrowingCapacity = Math.max(0, (npc.savings * (1 + MAX_LEVERAGE_MULTIPLE)) - existingDebtBurden);

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
      export const financedFraction = 1 - DOWN_PAYMENT_FRACTION;
      export const totalInterestMultiple = 1 + DEBT_INTEREST_DAILY * DEBT_TERM_DAYS; // total repaid per dollar financed
      export const existingBurdenRatio = npc.savings > 0 ? Math.min(2, existingDebtBurden / npc.savings) : 2;
      // Discount grows with (a) how much interest financing costs and
      // (b) how debt-burdened this bidder already is — a clean villager
      // with no debt discounts only for interest; someone already
      // leveraged discounts much harder, i.e. bids far more conservatively.
      export const riskDiscount = 1 / (totalInterestMultiple * (1 + existingBurdenRatio));
      export const desiredBid = valuation * 0.85 * riskDiscount;

      export const maxAffordableViaCredit = Math.min(
        npc.savings / DOWN_PAYMENT_FRACTION, // must still cover the down payment fraction in cash
        netBorrowingCapacity                  // and stay within a sane, debt-aware leverage ceiling
      );
      export const bid = Math.min(desiredBid, maxAffordableViaCredit);
      if (bid <= 0) continue;
      if (bid > bestBid) { bestBid = bid; bestBidder = npc; }
    }

    if (bestBidder && bestBid >= sellerReserveValue && bestBid > 0.01) {
      // Settle via down payment + seller-financed installment debt rather
      // than requiring the full price in cash today.
      export const downPayment = Math.min(bestBid * DOWN_PAYMENT_FRACTION, bestBidder.savings);
      export const financedAmount = bestBid - downPayment;

      bestBidder.savings -= downPayment;
      // Orphaned estate (owner died with no heir — see killNPC): there's
      // no seller to pay, so proceeds go to the Church instead, same
      // "unclaimed estate" handling as any other institutional windfall,
      // rather than vanishing or crediting a dead id.
      if (seller) seller.savings += downPayment;
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
        export const bankFunded = Math.min(financedAmount, world.bank.cash);
        if (seller) seller.savings += bankFunded;
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
      export const sellerIdForHistory = asset.ownerId;
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

      export const financeNote = financedAmount > 0.01 ? ` (${downPayment.toFixed(0)}¢ down, ${financedAmount.toFixed(0)}¢ financed)` : '';
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
