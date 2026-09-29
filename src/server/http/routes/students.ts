/** 学生与作答记录（与题目内容版本无关）。 */
import {
  attemptBatchSchema,
  attemptCreateSchema,
  attemptListQuerySchema,
  attemptUpdateSchema,
  studentCreateSchema,
  studentUpdateSchema,
} from '../../../shared/api.js';
import {
  createAttempt,
  createAttemptsBatch,
  createStudent,
  getStudentDetail,
  listAttempts,
  listStudents,
  setAttemptDeleted,
  setStudentArchived,
  updateAttempt,
  updateStudent,
} from '../../services/students.js';
import { body, parse, uuidParam, type RegisterRoutes } from '../helpers.js';

export const register: RegisterRoutes = (app, ctx) => {
  const { db } = ctx;
  app.get('/api/students', (c) => c.json(listStudents(db, { includeArchived: c.req.query('all') === '1' })));
  app.post('/api/students', async (c) => {
    const r = createStudent(db, await body(c, studentCreateSchema));
    return c.json(r.student, r.created ? 201 : 200);
  });
  app.get('/api/students/:id', (c) => c.json(getStudentDetail(db, uuidParam(c))));
  app.put('/api/students/:id', async (c) => c.json(updateStudent(db, uuidParam(c), await body(c, studentUpdateSchema))));
  app.post('/api/students/:id/archive', (c) => c.json(setStudentArchived(db, uuidParam(c), true)));
  app.post('/api/students/:id/unarchive', (c) => c.json(setStudentArchived(db, uuidParam(c), false)));

  app.get('/api/attempts', (c) => c.json(listAttempts(db, parse(attemptListQuerySchema, c.req.query()))));
  app.post('/api/attempts', async (c) => {
    const r = createAttempt(db, await body(c, attemptCreateSchema));
    return c.json(r.attempt, r.created ? 201 : 200);
  });
  app.post('/api/attempts/batch', async (c) => c.json(createAttemptsBatch(db, await body(c, attemptBatchSchema))));
  app.put('/api/attempts/:id', async (c) => c.json(updateAttempt(db, uuidParam(c), await body(c, attemptUpdateSchema))));
  app.post('/api/attempts/:id/delete', (c) => {
    setAttemptDeleted(db, uuidParam(c), true);
    return c.json({ ok: true });
  });
  app.post('/api/attempts/:id/restore', (c) => {
    setAttemptDeleted(db, uuidParam(c), false);
    return c.json({ ok: true });
  });
};
