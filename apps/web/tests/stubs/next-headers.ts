/**
 * Stub for `next/headers` under Vitest.
 */

const cookieStoreMap = new Map<string, { value: string; options?: unknown }>();

export function cookies() {
  return {
    get(name: string) {
      const entry = cookieStoreMap.get(name);
      return entry ? { name, value: entry.value } : undefined;
    },
    set(name: string, value: string, options?: unknown) {
      cookieStoreMap.set(name, { value, options });
    },
    delete(name: string) {
      cookieStoreMap.delete(name);
    },
    getAll() {
      return Array.from(cookieStoreMap.entries()).map(([name, entry]) => ({
        name,
        value: entry.value,
      }));
    },
  };
}

export function headers(): Headers {
  return new Headers();
}
