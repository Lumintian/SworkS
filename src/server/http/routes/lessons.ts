/** 教案：按引用组合题目（与题目的内容版本无关）。 */
import { lessonAddItemsSchema, lessonCreateSchema, lessonListQuerySchema, lessonUpdateSchema } from '../../../shared/api.js';
import {
  addProblemsToLesson,
  createLesson,
  getLesson,
  listLessons,
  setLessonDeleted,
  updateLesson,
} from '../../services/lessons.js';
import { body, parse, uuidParam, type RegisterRoutes } from '../helpers.js';

export const register: RegisterRoutes = (app, ctx) => {
  const { db } = ctx;
  app.get('/api/lessons', (c) => c.json(listLessons(db, parse(lessonListQuerySchema, c.req.query()))));
  app.post('/api/lessons', async (c) => {
    const { id, ...input } = await body(c, lessonCreateSchema);
    const r = createLesson(db, id, input);
    return c.json(r, r.created ? 201 : 200);
  });
  app.get('/api/lessons/:id', (c) => c.json(getLesson(db, uuidParam(c))));
  app.put('/api/lessons/:id', async (c) => {
    const { expectedVersion, ...input } = await body(c, lessonUpdateSchema);
    return c.json(updateLesson(db, uuidParam(c), expectedVersion, input));
  });
  app.post('/api/lessons/:id/items', async (c) => c.json(addProblemsToLesson(db, uuidParam(c), (await body(c, lessonAddItemsSchema)).problemIds)));
  app.delete('/api/lessons/:id', (c) => c.json(setLessonDeleted(db, uuidParam(c), true)));
  app.post('/api/lessons/:id/restore', (c) => c.json(setLessonDeleted(db, uuidParam(c), false)));
};
