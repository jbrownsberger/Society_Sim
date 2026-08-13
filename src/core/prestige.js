import { PROFESSION_PRESTIGE, PRESTIGE_WEALTH_LOG_SCALE, PRESTIGE_WEALTH_CAP, PRESTIGE_PER_ASSET, PRESTIGE_ASSET_CAP, PRESTIGE_HELP_GAIN } from '../config/constants.js';

export function prestigeTarget(npc) {
  export const professionPart = PROFESSION_PRESTIGE[npc.profession] ?? 0;
  export const wealthPart = Math.min(PRESTIGE_WEALTH_CAP, Math.log1p(Math.max(0, npc.savings)) * PRESTIGE_WEALTH_LOG_SCALE);
  export const assetPart  = Math.min(PRESTIGE_ASSET_CAP, (npc.ownedAssets?.length ?? 0) * PRESTIGE_PER_ASSET);
  return clamp(professionPart + wealthPart + assetPart, 0, 1);
}
