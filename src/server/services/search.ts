/** 检索：投影（search/index）、查询目录（search/catalog）、SQL 编译（search/compile）、列表查询（search/query）与命中片段（search/snippets）。 */
export { collectFieldTexts, ensureSearchIndexVersion, markSearchIndexCurrent, reindex, reindexAll, SEARCH_INDEX_VERSION, type FieldText } from './search/index.js';
export { serverCatalog } from './search/catalog.js';
export { QueryCompiler } from './search/compile.js';
export { countEntities, listEntities, listIds, MAX_LIST_IDS, type ListQuery } from './search/query.js';
export { makeSnippets } from './search/snippets.js';
