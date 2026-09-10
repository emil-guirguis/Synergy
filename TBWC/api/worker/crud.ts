/**
 * TBWC's binding of the framework's shared CRUD helpers to this Worker's
 * execQuery. See framework/backend/api/base/crud.ts for the implementation —
 * every consuming app gets the same findAll/where/whereLike/create/update/
 * remove behavior from one place instead of a hand-copied local reimplementation.
 */
import { createCrud } from '@meterit/framework-backend/api/base/crud';
import { execQuery } from './db';

export const { findAll, findById, create, update, remove, checkDeleteRestrictions } = createCrud(execQuery);
export { whereFromQuery, likeFieldsFromSchema, fieldMapFromSchema, NOT_NULL } from '@meterit/framework-backend/api/base/crud';
export type { FindAllOptions, FindAllResult, DeleteRestriction, DeleteRestrictionViolation } from '@meterit/framework-backend/api/base/crud';
