/** In-place iterative radix-2 complex FFT with precomputed twiddles. */
export class FFT {
  readonly size: number
  private readonly cos: Float64Array
  private readonly sin: Float64Array
  private readonly rev: Uint32Array

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${size}`)
    this.size = size
    this.cos = new Float64Array(size / 2)
    this.sin = new Float64Array(size / 2)
    for (let k = 0; k < size / 2; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / size)
      this.sin[k] = Math.sin((2 * Math.PI * k) / size)
    }
    this.rev = new Uint32Array(size)
    const bits = Math.log2(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
  }

  /** Transforms (re, im) in place. The inverse is unscaled: divide by `size` yourself. */
  transform(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.size
    const rev = this.rev
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    const sign = inverse ? 1 : -1
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1
      const step = n / len
      for (let i = 0; i < n; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = this.cos[k]
          const wi = sign * this.sin[k]
          const a = i + j
          const b = a + half
          const xr = re[b] * wr - im[b] * wi
          const xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
      }
    }
  }
}
