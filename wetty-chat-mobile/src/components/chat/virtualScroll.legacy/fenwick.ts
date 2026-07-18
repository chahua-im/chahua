export class FenwickTree {
  private readonly size: number;
  private readonly tree: number[];
  private readonly values: number[];

  constructor(size: number, initialValue = 0) {
    this.size = size;
    this.tree = new Array(size + 1).fill(0);
    this.values = new Array(size).fill(initialValue);

    if (initialValue !== 0) {
      for (let i = 0; i < size; i++) {
        this.add(i, initialValue);
      }
    }
  }

  get(index: number) {
    return this.values[index] ?? 0;
  }

  set(index: number, value: number) {
    const current = this.get(index);
    const delta = value - current;
    if (delta === 0) return current;

    this.values[index] = value;
    this.add(index, delta);
    return current;
  }

  prefixSum(count: number) {
    let sum = 0;
    const upperBound = Math.max(0, Math.min(count, this.size));

    for (let i = upperBound; i > 0; i -= i & -i) {
      sum += this.tree[i];
    }

    return sum;
  }

  total() {
    return this.prefixSum(this.size);
  }

  findIndexByOffset(offset: number) {
    if (this.size <= 0) return 0;
    if (offset <= 0) return 0;

    let index = 0;
    let accumulated = 0;
    let bit = 1;

    while (bit < this.tree.length) {
      bit <<= 1;
    }
    bit >>= 1;

    while (bit > 0) {
      const next = index + bit;
      if (next <= this.size && accumulated + this.tree[next] <= offset) {
        index = next;
        accumulated += this.tree[next];
      }
      bit >>= 1;
    }

    return Math.min(index, this.size - 1);
  }

  private add(index: number, delta: number) {
    for (let i = index + 1; i < this.tree.length; i += i & -i) {
      this.tree[i] += delta;
    }
  }
}
