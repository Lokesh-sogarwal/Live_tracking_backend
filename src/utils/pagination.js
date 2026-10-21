// Legacy list endpoints returned everything; defaults stay generous so existing
// screens keep working, but every query is now capped.
export function parsePagination(query, { defaultLimit = 200, maxLimit = 1000 } = {}) {
  const rawLimit = Number.parseInt(query.limit ?? query.per_page ?? defaultLimit, 10);
  const rawPage = Number.parseInt(query.page ?? 1, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, maxLimit) : defaultLimit;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  return { limit, page, skip: (page - 1) * limit };
}

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
