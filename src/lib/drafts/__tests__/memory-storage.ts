/** vitest(node)で sessionStorage の代わりに差す偽物。throwOn を立てると setItem で投げる。 */
export class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  throwOnSet: Error | null = null;
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    if (this.throwOnSet) throw this.throwOnSet;
    this.m.set(k, String(v));
  }
}

export function installMemoryStorage(): MemoryStorage {
  const s = new MemoryStorage();
  Object.defineProperty(globalThis, "sessionStorage", { value: s, configurable: true, writable: true });
  return s;
}

export function uninstallStorage(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).sessionStorage;
}
