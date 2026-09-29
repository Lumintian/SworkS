/** 常用检索。 */
import { SAVED_SEARCH_SCOPES, savedSearchCreateSchema, savedSearchReorderSchema, savedSearchUpdateSchema, type SavedSearchScope } from '../../../shared/api.js';
import { AppError } from '../../errors.js';
import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  reorderSavedSearches,
  savedSearchCounts,
  updateSavedSearch,
} from '../../services/savedSearches.js';
import { body, uuidParam, type RegisterRoutes } from '../helpers.js';

function scopeOf(v: string | undefined, required: true): SavedSearchScope;
function scopeOf(v: string | undefined, required?: false): SavedSearchScope | undefined;
function scopeOf(v: string | undefined, required = false): SavedSearchScope | undefined {
  if (v && (SAVED_SEARCH_SCOPES as readonly string[]).includes(v)) return v as SavedSearchScope;
  if (required || v) throw new AppError('VALIDATION', 'scope 应为 problem 或 material');
  return undefined;
}

export const register: RegisterRoutes = (app, ctx) => {
  const { db } = ctx;
  app.get('/api/saved-searches', (c) => c.json(listSavedSearches(db, scopeOf(c.req.query('scope')))));
  app.get('/api/saved-searches/counts', (c) => c.json(savedSearchCounts(db, scopeOf(c.req.query('scope'), true))));
  app.post('/api/saved-searches/reorder', async (c) => {
    const input = await body(c, savedSearchReorderSchema);
    reorderSavedSearches(db, input.scope, input.ids);
    return c.json(listSavedSearches(db, input.scope));
  });
  app.post('/api/saved-searches', async (c) => {
    const r = createSavedSearch(db, await body(c, savedSearchCreateSchema));
    return c.json(r.savedSearch, r.created ? 201 : 200);
  });
  app.put('/api/saved-searches/:id', async (c) => c.json(updateSavedSearch(db, uuidParam(c), await body(c, savedSearchUpdateSchema))));
  app.post('/api/saved-searches/:id/delete', (c) => {
    deleteSavedSearch(db, uuidParam(c));
    return c.json({ ok: true });
  });
};
