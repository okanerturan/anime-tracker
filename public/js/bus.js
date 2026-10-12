// Minimal event bus so views can invalidate each other's caches.
const handlers = new Map();
export const bus = {
  on(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
  emit(name, data) { for (const fn of handlers.get(name) || []) fn(data); }
};
