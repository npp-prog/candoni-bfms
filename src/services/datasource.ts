import type { DataSource, Filter, OrderBy, WithId } from '@bfms/shared';
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  limit as qLimit,
  orderBy as qOrderBy,
  query,
  where,
  type QueryConstraint,
} from 'firebase/firestore';
import { db } from './firebase/app';

function constraints(filters: readonly Filter[], orderBy: readonly OrderBy[] = [], limit?: number): QueryConstraint[] {
  const c: QueryConstraint[] = filters.map(([f, op, v]) => where(f, op, v));
  orderBy.forEach(([f, dir]) => c.push(qOrderBy(f, dir ?? 'asc')));
  if (limit) c.push(qLimit(limit));
  return c;
}

/** Browser implementation of the report DataSource (reads go through Security Rules). */
export const clientDataSource: DataSource = {
  async get<T>(col: string, id: string) {
    const s = await getDoc(doc(db, col, id));
    return s.exists() ? ({ ...(s.data() as T), id: s.id } as WithId<T>) : null;
  },
  async list<T>(col: string, filters: readonly Filter[], orderBy?: readonly OrderBy[], limit?: number) {
    const s = await getDocs(query(collection(db, col), ...constraints(filters, orderBy, limit)));
    return s.docs.map((d) => ({ ...(d.data() as T), id: d.id }) as WithId<T>);
  },
  async listGroup<T>(sub: string, filters: readonly Filter[], orderBy?: readonly OrderBy[], limit?: number) {
    const s = await getDocs(query(collectionGroup(db, sub), ...constraints(filters, orderBy, limit)));
    return s.docs.map((d) => ({ ...(d.data() as T), id: d.id }) as WithId<T>);
  },
  async listSub<T>(col: string, id: string, sub: string, orderBy?: readonly OrderBy[]) {
    const s = await getDocs(query(collection(db, col, id, sub), ...constraints([], orderBy)));
    return s.docs.map((d) => ({ ...(d.data() as T), id: d.id }) as WithId<T>);
  },
};
