export class RNG {
  constructor(seed=42) { this.s = seed; }
  next() { this.s = (this.s * 1664525 + 1013904223) & 0xffffffff; return (this.s >>> 0) / 0xffffffff; }
  float(lo=0, hi=1) { return lo + this.next() * (hi - lo); }
  int(lo, hi) { return Math.floor(this.float(lo, hi+1)); }
  pick(arr) { return arr[this.int(0, arr.length-1)]; }
}
export const rng = new RNG(42);
